import { randomUUID } from 'node:crypto';
import {
  createSdkMcpServer,
  query,
  tool,
  type HookCallback,
  type Options,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  GATEWAY_ERROR,
  type AgentRunEvent,
  type AgentRunIO,
  type AgentRunRequest,
  type ModelGateway,
  type TokenUsage,
  type ToolCallResult,
} from '../types';

/** Tên server MCP in-process: tool của agent là `mcp__cc__<tên>`. */
export const MCP_SERVER_NAME = 'cc';
const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** Tham số của `query` do provider dùng; test thay bằng hàm giả dựng sẵn chuỗi SDKMessage. */
export type QueryFn = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage> & { close?: () => void };

export type ClaudeAgentSdkProviderOptions = {
  apiKey?: string;
  /** `HTTPS_PROXY` / `NO_PROXY` cho egress-proxy (worker chỉ ra ngoài qua proxy này). */
  httpsProxy?: string;
  noProxy?: string;
  /** Mặc định `process.env` cho `PATH`, `HOME`. */
  baseEnv?: Record<string, string | undefined>;
  queryFn?: QueryFn;
  /** Số lượt agent tối đa mỗi run (khi `limits.maxTurns` không đặt). */
  defaultMaxTurns?: number;
};

type UsageKey = { id: string; usage: TokenUsage; model: string };

/** env tối thiểu: SDK thay hoàn toàn env của subprocess nên không có secret nào ngoài API key (R3). */
export function buildSdkEnv(options: ClaudeAgentSdkProviderOptions): Record<string, string> {
  const base = options.baseEnv ?? process.env;
  const env: Record<string, string> = {};
  const put = (key: string, value: string | undefined) => {
    if (value) env[key] = value;
  };
  put('PATH', base.PATH ?? base.Path);
  put('HOME', base.HOME ?? base.USERPROFILE);
  put('ANTHROPIC_API_KEY', options.apiKey ?? base.ANTHROPIC_API_KEY);
  put('HTTPS_PROXY', options.httpsProxy);
  put('NO_PROXY', options.noProxy);
  return env;
}

/**
 * Runtime `claude_agent_sdk` (vai trò làm việc với mã nguồn). Tắt toàn bộ built-in (`tools: []`) và chỉ dùng MCP
 * tool in-process do hệ thống viết; mỗi handler gọi `io.invokeTool` nên quyền và ledger nằm trong hệ thống.
 * `canUseTool` KHÔNG phải điểm cưỡng chế (R3); hook `PreToolUse` chỉ là lớp từ chối thứ hai ngoài `mcp__cc__*`.
 */
export class ClaudeAgentSdkProvider implements ModelGateway {
  private readonly queryFn: QueryFn;

  constructor(private readonly options: ClaudeAgentSdkProviderOptions = {}) {
    this.queryFn = options.queryFn ?? ((params) => query(params) as ReturnType<QueryFn>);
  }

  async *runAgent(req: AgentRunRequest, io: AgentRunIO): AsyncGenerator<AgentRunEvent> {
    // Khi có tool trả `pending_approval`/`run_locked`, agent được kết thúc lượt tự nhiên rồi mới phát paused.
    let pauseApprovalId: string | null = null;
    // Sự kiện sinh ra từ handler tool (đang chạy bên trong `query`) được xếp hàng để phát đúng thứ tự.
    const queued: AgentRunEvent[] = [];

    const handle = async (name: string, input: unknown): Promise<ToolCallResult> => {
      queued.push({ type: 'tool_call', name, status: 'started' });
      const result = await io.invokeTool({ name, input, providerCallId: randomUUID() });
      queued.push({ type: 'tool_call', name, status: 'finished' });
      // Sau mỗi lần handler trả kết quả, SDK sẽ gọi model lượt kế tiếp.
      queued.push({ type: 'model_call_started' });
      if (result.status === 'pending_approval' || result.status === 'run_locked') {
        pauseApprovalId ??= String(
          (result.output as { approvalRequestId?: string } | undefined)?.approvalRequestId ?? '',
        );
      }
      return result;
    };

    const server = createSdkMcpServer({
      name: MCP_SERVER_NAME,
      tools: req.tools.map((spec) =>
        tool(spec.name, spec.description, spec.zodShape ?? {}, async (args) => {
          const result = await handle(spec.name, args);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            isError: result.status === 'error' || result.status === 'denied',
          };
        }),
      ),
    });

    // Từ chối mọi tool ngoài MCP của hệ thống, kể cả khi `tools: []` bị cấu hình sai.
    const denyForeignTools: HookCallback = async (input) => {
      const name = 'tool_name' in input ? String(input.tool_name) : '';
      if (name.startsWith(TOOL_PREFIX)) return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Tool "${name}" không nằm trong danh sách tool của hệ thống`,
        },
      };
    };

    const abortController = new AbortController();
    const abort = () => abortController.abort();
    if (io.signal.aborted) abort();
    io.signal.addEventListener('abort', abort, { once: true });

    const options: Options = {
      model: req.modelId,
      systemPrompt: req.systemPrompt,
      cwd: req.workspacePath,
      permissionMode: 'default',
      tools: [],
      allowedTools: [`${TOOL_PREFIX}*`],
      settingSources: [],
      strictMcpConfig: true,
      maxTurns: req.limits.maxTurns ?? this.options.defaultMaxTurns ?? 40,
      maxBudgetUsd: req.limits.maxCostUsd,
      resume: req.resumeSessionId,
      env: buildSdkEnv(this.options),
      mcpServers: { [MCP_SERVER_NAME]: server },
      hooks: { PreToolUse: [{ hooks: [denyForeignTools] }] },
      abortController,
    };

    const usageById = new Map<string, UsageKey>();
    const emitted = new Set<string>();
    let sessionId: string | undefined;
    let finalText = '';

    const flushUsage = function* (): Generator<AgentRunEvent> {
      for (const entry of usageById.values()) {
        if (emitted.has(entry.id)) continue;
        emitted.add(entry.id);
        yield { type: 'model_call', messageId: entry.id, modelId: entry.model, usage: entry.usage };
      }
    };

    // Phát `model_call_started` khi bắt đầu `query()` (lượt đầu).
    yield { type: 'model_call_started' };
    const stream = this.queryFn({ prompt: req.input, options });

    try {
      for await (const message of stream) {
        yield* drain(queued);
        if (message.type === 'system' && message.subtype === 'init') {
          sessionId = message.session_id;
          yield { type: 'session', sessionId };
          continue;
        }
        if (message.type === 'assistant') {
          const apiMessage = message.message;
          // Nhiều khung assistant cùng `message.id`: dedupe, giữ số liệu lớn nhất, phát khi id kế tiếp xuất hiện.
          const previous = [...usageById.values()].find((u) => !emitted.has(u.id) && u.id !== apiMessage.id);
          if (previous) {
            emitted.add(previous.id);
            yield { type: 'model_call', messageId: previous.id, modelId: previous.model, usage: previous.usage };
          }
          const usage = apiMessage.usage;
          const prior = usageById.get(apiMessage.id)?.usage;
          usageById.set(apiMessage.id, {
            id: apiMessage.id,
            model: apiMessage.model,
            usage: {
              inputTokens: Math.max(prior?.inputTokens ?? 0, usage?.input_tokens ?? 0),
              outputTokens: Math.max(prior?.outputTokens ?? 0, usage?.output_tokens ?? 0),
              cacheReadTokens: Math.max(prior?.cacheReadTokens ?? 0, usage?.cache_read_input_tokens ?? 0),
              cacheWriteTokens: Math.max(
                prior?.cacheWriteTokens ?? 0,
                usage?.cache_creation_input_tokens ?? 0,
              ),
            },
          });
          for (const block of apiMessage.content) {
            if (block.type === 'text' && block.text) {
              finalText = block.text;
              yield { type: 'text', text: block.text };
            }
          }
          continue;
        }
        if (message.type === 'result') {
          yield* flushUsage();
          yield* drain(queued);
          if (message.subtype === 'success') {
            if (pauseApprovalId !== null) {
              yield { type: 'paused_for_approval', approvalRequestId: pauseApprovalId };
            } else {
              const text = message.result || finalText;
              yield { type: 'finished', output: { summary: text }, text };
            }
            return;
          }
          if (message.subtype === 'error_max_budget_usd') {
            yield {
              type: 'error',
              code: GATEWAY_ERROR.BUDGET_EXCEEDED,
              message: 'Run chạm maxBudgetUsd',
              retryable: false,
            };
            return;
          }
          if (message.subtype === 'error_max_turns' && pauseApprovalId !== null) {
            // Agent chưa chịu dừng khi tool bị khóa: `maxTurns` chặn trên số lượt, vẫn coi là tạm dừng.
            yield { type: 'paused_for_approval', approvalRequestId: pauseApprovalId };
            return;
          }
          yield {
            type: 'error',
            code: message.subtype === 'error_max_turns' ? GATEWAY_ERROR.MAX_TURNS : GATEWAY_ERROR.PROVIDER_ERROR,
            message: `Agent SDK kết thúc với ${message.subtype}`,
            retryable: message.subtype === 'error_during_execution',
          };
          return;
        }
      }
      yield* flushUsage();
      yield {
        type: 'error',
        code: GATEWAY_ERROR.PROVIDER_ERROR,
        message: 'Agent SDK kết thúc mà không có kết quả',
        retryable: true,
      };
    } catch (error) {
      yield* flushUsage();
      yield io.signal.aborted
        ? {
            type: 'error',
            code: GATEWAY_ERROR.ABORTED,
            message: 'Run bị hủy hoặc hết thời gian',
            retryable: false,
          }
        : {
            type: 'error',
            code: GATEWAY_ERROR.PROVIDER_ERROR,
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          };
    } finally {
      io.signal.removeEventListener('abort', abort);
      stream.close?.();
    }
  }
}

function* drain(queue: AgentRunEvent[]): Generator<AgentRunEvent> {
  while (queue.length > 0) yield queue.shift() as AgentRunEvent;
}
