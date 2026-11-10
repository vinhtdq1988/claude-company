import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ClaudeAgentSdkProvider,
  FakeModelProvider,
  MessagesApiProvider,
  renderInput,
  type AgentRunEvent,
  type AgentRunIO,
  type AgentRunRequest,
  type ModelGateway,
  type ToolCallResult,
} from '@claude-company/model-gateway';

/**
 * Contract test ModelGateway chạy chung cho cả ba provider (T081; Nguyên tắc VI, R3, R4):
 * Fake, Messages API (HTTP mock thật) và Agent SDK (query + MCP giả). Mọi tool đi qua `io.invokeTool`,
 * `beforeModelCall` quyết định dừng, `model_call_started` đứng trước mỗi lượt model, usage dedupe theo `message.id`.
 */

const TOOL = {
  name: 'artifact_publish',
  actionType: 'artifact.publish',
  description: 'Nộp artifact',
  inputSchema: {
    type: 'object',
    properties: { title: { type: 'string' }, content: { type: 'string' } },
  },
  zodShape: { title: z.string(), content: z.string() },
};
const PUBLISH_INPUT = { title: 'Báo cáo', content: 'Nội dung' };

const request = (
  runtimeKind: 'messages_api' | 'claude_agent_sdk',
  over: Partial<AgentRunRequest> = {},
): AgentRunRequest => ({
  runtimeKind,
  modelId: 'claude-opus-5-5',
  systemPrompt: 'Bạn là AI Employee.',
  input: renderInput({
    task_objective: 'Viết báo cáo',
    acceptance_criteria: [{ id: 'c1', text: 'Có nội dung' }],
    expected_output: 'Báo cáo',
  }),
  tools: [TOOL],
  limits: { maxCostUsd: 1.8, maxTokens: 4096, timeoutMs: 5_000 },
  ...over,
});

type Harness = {
  invoked: Array<{ name: string; input: unknown }>;
  before: number;
  saved: unknown[];
  io(overrides?: Partial<AgentRunIO>): AgentRunIO;
};

function harness(toolResult: ToolCallResult = { status: 'ok', output: { saved: true } }): Harness {
  const h: Harness = {
    invoked: [],
    before: 0,
    saved: [],
    io(overrides = {}) {
      return {
        invokeTool: async (call) => {
          h.invoked.push({ name: call.name, input: call.input });
          return toolResult;
        },
        beforeModelCall: async () => {
          h.before += 1;
          return true;
        },
        saveConversation: async (m) => void h.saved.push(m),
        signal: new AbortController().signal,
        ...overrides,
      };
    },
  };
  return h;
}

async function collect(
  gateway: ModelGateway,
  req: AgentRunRequest,
  io: AgentRunIO,
): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = [];
  for await (const e of gateway.runAgent(req, io)) events.push(e);
  return events;
}

const types = (events: AgentRunEvent[]) => events.map((e) => e.type);

// --- Messages API: máy chủ HTTP giả ---

type MockReply = { status?: number; body: unknown };
let server: Server;
let baseURL: string;
const requests: Array<Record<string, unknown>> = [];
let replies: MockReply[] = [];

const usage = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const toolUseReply = (id = 'msg_tool'): MockReply => ({
  body: {
    id,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'tool_use', id: 'tu_1', name: 'artifact_publish', input: PUBLISH_INPUT }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage,
  },
});
const textReply = (text: string, id = 'msg_end'): MockReply => ({
  body: {
    id,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage,
  },
});

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      const reply = replies.shift() ?? {
        status: 500,
        body: { type: 'error', error: { type: 'api_error', message: 'hết kịch bản' } },
      };
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const messagesApi = () => new MessagesApiProvider({ apiKey: 'test-key', baseURL });

// --- Agent SDK: query giả + MCP giả ---

type CapturedTool = {
  name: string;
  handler: (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

function sdkProvider(
  script: (ctx: {
    tools: Map<string, CapturedTool>;
    options: Record<string, unknown>;
  }) => AsyncGenerator<unknown>,
) {
  const tools = new Map<string, CapturedTool>();
  const captured: { options?: Record<string, unknown> } = {};
  const provider = new ClaudeAgentSdkProvider({
    apiKey: 'sk-test',
    baseEnv: {
      PATH: '/usr/bin',
      HOME: '/home/x',
      DATABASE_URL: 'postgres://secret',
      SESSION_SECRET: 'x',
    },
    httpsProxy: 'http://egress-proxy:3128',
    noProxy: 'redis',
    mcp: {
      tool: ((name: string, _d: string, _s: unknown, handler: CapturedTool['handler']) => {
        tools.set(name, { name, handler });
        return { name } as never;
      }) as never,
      createSdkMcpServer: (() => ({ type: 'sdk', name: 'cc', instance: {} })) as never,
    },
    queryFn: ({ options }) => {
      captured.options = options as unknown as Record<string, unknown>;
      return script({ tools, options: captured.options }) as never;
    },
  });
  return { provider, tools, captured };
}

const sdkAssistant = (
  id: string,
  outputTokens: number,
  content: unknown[] = [{ type: 'text', text: 'ok' }],
) => ({
  type: 'assistant',
  message: {
    id,
    model: 'claude-opus-5-5',
    content,
    usage: {
      input_tokens: 100,
      output_tokens: outputTokens,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
  session_id: 's1',
});
const sdkInit = { type: 'system', subtype: 'init', session_id: 'session-1' };
const sdkSuccess = { type: 'result', subtype: 'success', result: 'Xong báo cáo' };

describe('Contract: ModelGateway — chạy chung cho ba provider (T081)', () => {
  type Subject = {
    name: string;
    runtime: 'messages_api' | 'claude_agent_sdk';
    /** Dựng kịch bản "gọi tool artifact_publish rồi kết thúc". */
    toolThenFinish(): { gateway: ModelGateway; expectModelCalls: number };
    /** Số tool đã chạy khi lượt model thứ hai bị chặn: Fake nộp artifact sau lượt thứ hai nên là 0. */
    toolsBeforeSecondTurn: number;
  };

  const subjects: Subject[] = [
    {
      name: 'FakeModelProvider',
      runtime: 'messages_api',
      toolThenFinish: () => ({ gateway: new FakeModelProvider(), expectModelCalls: 2 }),
      toolsBeforeSecondTurn: 0,
    },
    {
      name: 'MessagesApiProvider',
      runtime: 'messages_api',
      toolThenFinish: () => {
        replies = [toolUseReply(), textReply('Xong báo cáo')];
        return { gateway: messagesApi(), expectModelCalls: 2 };
      },
      toolsBeforeSecondTurn: 1,
    },
    {
      name: 'ClaudeAgentSdkProvider',
      runtime: 'claude_agent_sdk',
      toolThenFinish: () => {
        const { provider } = sdkProvider(async function* ({ tools }) {
          yield sdkInit;
          yield sdkAssistant('m1', 10, [
            { type: 'tool_use', id: 'tu', name: 'mcp__cc__artifact_publish', input: PUBLISH_INPUT },
          ]);
          await tools.get('artifact_publish')!.handler(PUBLISH_INPUT);
          yield sdkAssistant('m2', 20);
          yield sdkSuccess;
        });
        return { gateway: provider, expectModelCalls: 2 };
      },
      toolsBeforeSecondTurn: 1,
    },
  ];

  describe.each(subjects)('$name', (subject) => {
    it('mọi tool đi qua io.invokeTool và kết thúc bằng sự kiện finished', async () => {
      const h = harness();
      const { gateway } = subject.toolThenFinish();
      const events = await collect(gateway, request(subject.runtime), h.io());
      expect(h.invoked).toHaveLength(1);
      expect(h.invoked[0]?.name).toBe('artifact_publish');
      // Input của mọi provider phải hợp lệ theo schema của tool đã cấp; provider thật chuyển đúng input model sinh ra.
      expect(z.object(TOOL.zodShape).safeParse(h.invoked[0]?.input).success).toBe(true);
      if (subject.name !== 'FakeModelProvider') expect(h.invoked[0]?.input).toEqual(PUBLISH_INPUT);
      expect(events.at(-1)).toMatchObject({ type: 'finished' });
      expect(events.filter((e) => e.type === 'error')).toEqual([]);
    });

    it('phát model_call_started trước mỗi lượt model và dedupe usage theo message.id', async () => {
      const h = harness();
      const { gateway, expectModelCalls } = subject.toolThenFinish();
      const events = await collect(gateway, request(subject.runtime), h.io());
      const started = events.filter((e) => e.type === 'model_call_started').length;
      const calls = events.filter(
        (e): e is Extract<AgentRunEvent, { type: 'model_call' }> => e.type === 'model_call',
      );
      expect(calls).toHaveLength(expectModelCalls);
      expect(new Set(calls.map((c) => c.messageId)).size).toBe(calls.length);
      expect(started).toBeGreaterThanOrEqual(calls.length);
      // Mỗi model_call có một model_call_started đứng trước nó.
      let open = 0;
      for (const e of events) {
        if (e.type === 'model_call_started') open += 1;
        if (e.type === 'model_call') {
          expect(open).toBeGreaterThan(0);
          open -= 1;
        }
      }
    });
  });

  describe.each(subjects.filter((s) => s.runtime === 'messages_api'))(
    '$name — ngân sách theo lượt',
    (subject) => {
      it('beforeModelCall trả false thì dừng ngay, không gọi model (BUDGET_EXCEEDED)', async () => {
        requests.length = 0;
        const h = harness();
        const { gateway } = subject.toolThenFinish();
        const events = await collect(
          gateway,
          request(subject.runtime),
          h.io({ beforeModelCall: async () => false }),
        );
        // `session` chỉ là thông tin phiên, không phải lượt model: bỏ qua khi so khớp.
        expect(events.filter((e) => e.type !== 'session')).toEqual([
          expect.objectContaining({ type: 'error', code: 'BUDGET_EXCEEDED', retryable: false }),
        ]);
        expect(h.invoked).toEqual([]);
        if (subject.name === 'MessagesApiProvider') expect(requests).toHaveLength(0);
      });

      it('hết ngân sách giữa chừng: lượt thứ hai bị chặn sau khi tool đã chạy', async () => {
        const h = harness();
        let turn = 0;
        const { gateway } = subject.toolThenFinish();
        const events = await collect(
          gateway,
          request(subject.runtime),
          h.io({ beforeModelCall: async () => ++turn < 2 }),
        );
        expect(h.invoked).toHaveLength(subject.toolsBeforeSecondTurn);
        expect(events.at(-1)).toMatchObject({ type: 'error', code: 'BUDGET_EXCEEDED' });
      });
    },
  );

  describe('MessagesApiProvider', () => {
    it('gửi max_tokens theo limits, tool đã cấp và system prompt', async () => {
      requests.length = 0;
      replies = [textReply('Xong')];
      await collect(
        messagesApi(),
        request('messages_api', { limits: { maxCostUsd: 1, maxTokens: 777, timeoutMs: 5000 } }),
        harness().io(),
      );
      expect(requests[0]).toMatchObject({
        model: 'claude-opus-5-5',
        max_tokens: 777,
        system: 'Bạn là AI Employee.',
        tools: [expect.objectContaining({ name: 'artifact_publish' })],
      });
    });

    it('tool lạ model gọi (không được cấp) bị từ chối, không đi tới io.invokeTool', async () => {
      const h = harness();
      replies = [
        {
          body: {
            id: 'msg_x',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [
              {
                type: 'tool_use',
                id: 'tu_9',
                name: 'network_fetch',
                input: { url: 'https://evil' },
              },
            ],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage,
          },
        },
        textReply('Xong'),
      ];
      const events = await collect(messagesApi(), request('messages_api'), h.io());
      expect(h.invoked).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: 'finished' });
      const second = requests.at(-1) as { messages: Array<{ content: unknown }> };
      expect(JSON.stringify(second.messages.at(-1))).toContain('chưa được cấp');
    });

    it('pending_approval: lưu hội thoại rồi phát paused_for_approval', async () => {
      const h = harness({ status: 'pending_approval', output: { approvalRequestId: 'apr-1' } });
      replies = [toolUseReply()];
      const events = await collect(messagesApi(), request('messages_api'), h.io());
      expect(h.saved).toHaveLength(1);
      expect(events.at(-1)).toEqual({ type: 'paused_for_approval', approvalRequestId: 'apr-1' });
    });

    it('structured output: dùng output_config.format, kiểm tra schema; sai schema → INVALID_OUTPUT', async () => {
      const schema = z.object({ decision: z.enum(['pass', 'rework']) });
      requests.length = 0;
      replies = [textReply('{"decision":"pass"}')];
      const ok = await collect(
        messagesApi(),
        request('messages_api', { tools: [], structuredOutput: schema }),
        harness().io(),
      );
      expect(requests[0]).toHaveProperty('output_config.format.type', 'json_schema');
      expect(requests[0]).not.toHaveProperty('tools');
      expect(ok.at(-1)).toMatchObject({ type: 'finished', output: { decision: 'pass' } });

      replies = [textReply('{"decision":"maybe"}')];
      const bad = await collect(
        messagesApi(),
        request('messages_api', { tools: [], structuredOutput: schema }),
        harness().io(),
      );
      expect(bad.at(-1)).toMatchObject({ type: 'error', code: 'INVALID_OUTPUT' });
    });

    it('lỗi 429/5xx là retryable, lỗi 400 thì không', async () => {
      replies = [
        {
          status: 429,
          body: { type: 'error', error: { type: 'rate_limit_error', message: 'chậm lại' } },
        },
      ];
      const rate = await collect(messagesApi(), request('messages_api'), harness().io());
      expect(rate.at(-1)).toMatchObject({ type: 'error', retryable: true });
      replies = [
        {
          status: 400,
          body: { type: 'error', error: { type: 'invalid_request_error', message: 'sai' } },
        },
      ];
      const bad = await collect(messagesApi(), request('messages_api'), harness().io());
      expect(bad.at(-1)).toMatchObject({ type: 'error', retryable: false });
    });
  });

  describe('ClaudeAgentSdkProvider', () => {
    it('maxBudgetUsd = limits.maxCostUsd (đã trừ headroom); error_max_budget_usd thành lỗi hết ngân sách', async () => {
      const { provider, captured } = sdkProvider(async function* () {
        yield sdkInit;
        yield sdkAssistant('m1', 10);
        yield { type: 'result', subtype: 'error_max_budget_usd' };
      });
      const events = await collect(
        provider,
        request('claude_agent_sdk', { limits: { maxCostUsd: 1.8, maxTokens: 1, timeoutMs: 1000 } }),
        harness().io(),
      );
      expect(captured.options?.maxBudgetUsd).toBe(1.8);
      expect(events.at(-1)).toMatchObject({
        type: 'error',
        code: 'BUDGET_EXCEEDED',
        retryable: false,
      });
      // Usage của lượt đã chạy vẫn được ghi nhận trước khi báo lỗi.
      expect(events.some((e) => e.type === 'model_call')).toBe(true);
    });

    it('nhiều khung assistant cùng message.id chỉ tính một model_call (số liệu lớn nhất)', async () => {
      const { provider } = sdkProvider(async function* () {
        yield sdkInit;
        yield sdkAssistant('same', 5);
        yield sdkAssistant('same', 50);
        yield sdkSuccess;
      });
      const events = await collect(provider, request('claude_agent_sdk'), harness().io());
      const calls = events.filter(
        (e): e is Extract<AgentRunEvent, { type: 'model_call' }> => e.type === 'model_call',
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.usage.outputTokens).toBe(50);
    });

    it('tool bị khóa (run_locked/pending_approval): chờ agent kết thúc lượt rồi phát paused_for_approval', async () => {
      const h = harness({ status: 'pending_approval', output: { approvalRequestId: 'apr-7' } });
      const { provider } = sdkProvider(async function* ({ tools }) {
        yield sdkInit;
        yield sdkAssistant('m1', 10);
        await tools.get('artifact_publish')!.handler(PUBLISH_INPUT);
        yield sdkAssistant('m2', 10);
        yield sdkSuccess;
      });
      const events = await collect(provider, request('claude_agent_sdk'), h.io());
      expect(events.at(-1)).toEqual({ type: 'paused_for_approval', approvalRequestId: 'apr-7' });
      expect(events.some((e) => e.type === 'finished')).toBe(false);
    });

    it('session id được báo qua sự kiện session để run có thể resume', async () => {
      const { provider, captured } = sdkProvider(async function* () {
        yield sdkInit;
        yield sdkSuccess;
      });
      const events = await collect(
        provider,
        request('claude_agent_sdk', { resumeSessionId: 'old-session' }),
        harness().io(),
      );
      expect(events.find((e) => e.type === 'session')).toEqual({
        type: 'session',
        sessionId: 'session-1',
      });
      expect(captured.options?.resume).toBe('old-session');
    });
  });

  describe('đồng nhất giữa các provider', () => {
    it('beforeModelCall của Fake được gọi mỗi lượt, kể cả lượt bị lỗi tạm thời', async () => {
      const h = harness();
      const fake = new FakeModelProvider();
      const input = renderInput({
        task_objective: 'x [[fake:error=retryable;times=1]]',
        directive: '',
      });
      const events = await collect(fake, request('messages_api', { input }), h.io());
      expect(h.before).toBe(1);
      expect(events.at(-1)).toMatchObject({ type: 'error', retryable: true });
      expect(types(events)).toContain('model_call');
    });
  });
});
