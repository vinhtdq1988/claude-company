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
 * Contract test `paused_for_approval` cho cả ba provider (T131a, viết trước T138; R4, FR-026):
 * `pending_approval` và `run_locked` không thực thi tool, giữ `sessionId`, không treo callback; `messages_api` gọi
 * `saveConversation` trước khi tạm dừng và resume thêm kết quả duyệt thành một lượt user mới.
 */

const EMAIL_TOOL = {
  name: 'email_send',
  actionType: 'email.send',
  description: 'Đề xuất gửi email',
  inputSchema: {
    type: 'object',
    properties: { to: { type: 'array' }, subject: { type: 'string' } },
  },
  zodShape: { to: z.array(z.string()), subject: z.string(), body: z.string() },
};
const PUBLISH_TOOL = {
  name: 'artifact_publish',
  actionType: 'artifact.publish',
  description: 'Nộp artifact',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
  zodShape: { title: z.string(), content: z.string() },
};
const EMAIL_INPUT = { to: ['khach@example.com'], subject: 'Tóm tắt', body: 'Nội dung' };

const request = (
  runtimeKind: 'messages_api' | 'claude_agent_sdk',
  over: Partial<AgentRunRequest> = {},
): AgentRunRequest => ({
  runtimeKind,
  modelId: 'claude-opus-5-5',
  systemPrompt: 'Bạn là AI Employee.',
  input: renderInput({
    task_objective: 'Viết báo cáo và gửi email tóm tắt cho khách hàng',
    acceptance_criteria: [{ id: 'c1', text: 'Có nội dung' }],
    expected_output: 'Báo cáo',
  }),
  tools: [EMAIL_TOOL, PUBLISH_TOOL],
  limits: { maxCostUsd: 1.8, maxTokens: 4096, timeoutMs: 5_000 },
  ...over,
});

type IoHarness = {
  invoked: Array<{ name: string; input: unknown }>;
  saved: unknown[];
  /** Thứ tự các lời gọi `saveConversation` so với lúc phát `paused_for_approval`. */
  order: string[];
  io(): AgentRunIO;
};

function ioHarness(results: Record<string, ToolCallResult>): IoHarness {
  const h: IoHarness = {
    invoked: [],
    saved: [],
    order: [],
    io: () => ({
      invokeTool: async (call) => {
        h.invoked.push({ name: call.name, input: call.input });
        h.order.push(`tool:${call.name}`);
        return results[call.name] ?? { status: 'ok', output: {} };
      },
      beforeModelCall: async () => true,
      saveConversation: async (messages) => {
        h.saved.push(messages);
        h.order.push('save');
      },
      signal: new AbortController().signal,
    }),
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

const PENDING: ToolCallResult = {
  status: 'pending_approval',
  output: { approvalRequestId: 'apr-1' },
  message: 'Đã tạo yêu cầu phê duyệt',
};
const LOCKED: ToolCallResult = { status: 'run_locked', message: 'Đang chờ Human Approval' };

// --- Messages API: máy chủ HTTP giả ---

type MockReply = { status?: number; body: unknown };
let server: Server;
let baseURL: string;
const requests: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
let replies: MockReply[] = [];

const usage = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const reply = (content: unknown[], stop: 'tool_use' | 'end_turn', id: string): MockReply => ({
  body: {
    id,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage,
  },
});
const emailUse = (toolUseId: string) => ({
  type: 'tool_use',
  id: toolUseId,
  name: 'email_send',
  input: EMAIL_INPUT,
});
const publishUse = (toolUseId: string) => ({
  type: 'tool_use',
  id: toolUseId,
  name: 'artifact_publish',
  input: { title: 'Báo cáo', content: 'x' },
});

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push(raw ? JSON.parse(raw) : {});
      const next = replies.shift() ?? {
        status: 500,
        body: { type: 'error', error: { type: 'api_error', message: 'hết kịch bản' } },
      };
      res.writeHead(next.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next.body));
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
  script: (ctx: { tools: Map<string, CapturedTool> }) => AsyncGenerator<unknown>,
) {
  const tools = new Map<string, CapturedTool>();
  const captured: { options?: Record<string, unknown>; prompt?: string } = {};
  const provider = new ClaudeAgentSdkProvider({
    apiKey: 'sk-test',
    baseEnv: { PATH: '/usr/bin', HOME: '/home/x' },
    mcp: {
      tool: ((name: string, _d: string, _s: unknown, handler: CapturedTool['handler']) => {
        tools.set(name, { name, handler });
        return { name } as never;
      }) as never,
      createSdkMcpServer: (() => ({ type: 'sdk', name: 'cc', instance: {} })) as never,
    },
    queryFn: ({ options, prompt }) => {
      captured.options = options as unknown as Record<string, unknown>;
      captured.prompt = prompt;
      return script({ tools }) as never;
    },
  });
  return { provider, tools, captured };
}

const sdkAssistant = (id: string, content: unknown[] = [{ type: 'text', text: 'ok' }]) => ({
  type: 'assistant',
  message: { id, model: 'claude-opus-5-5', content, usage },
  session_id: 's1',
});
const sdkInit = { type: 'system', subtype: 'init', session_id: 'session-1' };

describe('Contract: ModelGateway — tạm dừng chờ Human Approval (T131a)', () => {
  describe('messages_api', () => {
    it('pending_approval: không thực thi tool nào ngoài lời gọi đã trả pending, lưu hội thoại TRƯỚC khi phát paused', async () => {
      replies = [reply([emailUse('tu_1')], 'tool_use', 'msg_1')];
      requests.length = 0;
      const h = ioHarness({ email_send: PENDING });
      const events = await collect(messagesApi(), request('messages_api'), h.io());

      expect(types(events).at(-1)).toBe('paused_for_approval');
      expect(events.at(-1)).toEqual({ type: 'paused_for_approval', approvalRequestId: 'apr-1' });
      expect(h.invoked.map((i) => i.name)).toEqual(['email_send']);
      // Hội thoại được lưu đúng một lần, trước lúc tạm dừng, và không gọi model lần hai.
      expect(h.saved).toHaveLength(1);
      expect(requests).toHaveLength(1);
      const saved = h.saved[0] as Array<{ role: string; content: unknown }>;
      expect(saved.at(-1)?.role).toBe('user');
      expect(JSON.stringify(saved.at(-1)?.content)).toContain('pending_approval');
    });

    it('run_locked cho các tool còn lại trong cùng lượt: tool bị khóa không thực thi và vẫn tạm dừng đúng một lần', async () => {
      replies = [reply([emailUse('tu_1'), publishUse('tu_2')], 'tool_use', 'msg_1')];
      requests.length = 0;
      const h = ioHarness({ email_send: PENDING, artifact_publish: LOCKED });
      const events = await collect(messagesApi(), request('messages_api'), h.io());

      expect(events.filter((e) => e.type === 'paused_for_approval')).toHaveLength(1);
      expect(events.at(-1)).toEqual({ type: 'paused_for_approval', approvalRequestId: 'apr-1' });
      const saved = h.saved[0] as Array<{ role: string; content: Array<{ content: string }> }>;
      expect(saved.at(-1)?.content.map((c) => JSON.parse(c.content).status)).toEqual([
        'pending_approval',
        'run_locked',
      ]);
    });

    it('resume: hội thoại đã lưu cộng kết quả duyệt thành một lượt user mới rồi chạy tiếp tới khi hoàn tất', async () => {
      replies = [reply([emailUse('tu_1')], 'tool_use', 'msg_1')];
      requests.length = 0;
      const first = ioHarness({ email_send: PENDING });
      await collect(messagesApi(), request('messages_api'), first.io());

      replies = [reply([{ type: 'text', text: 'Đã ghi nhận kết quả duyệt' }], 'end_turn', 'msg_2')];
      const second = ioHarness({});
      const notice = 'Kết quả phê duyệt: đã duyệt';
      const events = await collect(
        messagesApi(),
        request('messages_api', { input: notice, resumeConversation: first.saved[0] }),
        second.io(),
      );
      expect(types(events)).toContain('finished');
      expect(second.invoked).toHaveLength(0);
      const sent = requests.at(-1)!.messages as Array<{ role: string; content: unknown }>;
      expect(sent.at(-1)).toEqual({ role: 'user', content: notice });
      // Hội thoại cũ được giữ nguyên phía trước (lượt assistant gọi email và kết quả pending).
      expect(sent.length).toBe((first.saved[0] as unknown[]).length + 1);
      expect(sent.some((m) => JSON.stringify(m.content).includes('pending_approval'))).toBe(true);
    });

    it('không treo: callback `invokeTool` trả về ngay và provider kết thúc luồng sự kiện', async () => {
      replies = [reply([emailUse('tu_1')], 'tool_use', 'msg_1')];
      const h = ioHarness({ email_send: PENDING });
      const result = await Promise.race([
        collect(messagesApi(), request('messages_api'), h.io()),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3_000)),
      ]);
      expect(result).not.toBe('timeout');
    });
  });

  describe('claude_agent_sdk', () => {
    /** Agent gọi email_send (pending), rồi gọi thêm tool khác (bị khóa), rồi kết thúc lượt tự nhiên. */
    function pauseScript(extra: 'none' | 'second_tool' = 'none') {
      return async function* ({ tools }: { tools: Map<string, CapturedTool> }) {
        yield sdkInit;
        yield sdkAssistant('m1', [
          { type: 'tool_use', id: 'tu1', name: 'mcp__cc__email_send', input: EMAIL_INPUT },
        ]);
        await tools.get('email_send')!.handler(EMAIL_INPUT);
        if (extra === 'second_tool')
          await tools.get('artifact_publish')!.handler({ title: 't', content: 'c' });
        yield sdkAssistant('m2', [{ type: 'text', text: 'Đã gửi đề xuất, chờ duyệt' }]);
        yield { type: 'result', subtype: 'success', result: 'Đã gửi đề xuất, chờ duyệt' };
      };
    }

    it('pending_approval: agent kết thúc lượt rồi provider phát paused_for_approval, giữ sessionId, không phát finished', async () => {
      const { provider } = sdkProvider(pauseScript());
      const h = ioHarness({ email_send: PENDING });
      const events = await collect(provider, request('claude_agent_sdk'), h.io());
      expect(events.some((e) => e.type === 'session' && e.sessionId === 'session-1')).toBe(true);
      expect(events.at(-1)).toEqual({ type: 'paused_for_approval', approvalRequestId: 'apr-1' });
      expect(types(events)).not.toContain('finished');
      expect(h.saved).toHaveLength(0); // chỉ messages_api cần lưu hội thoại
    });

    it('run_locked cho tool tiếp theo: không thực thi (broker trả khóa), vẫn một lần tạm dừng với id đầu tiên', async () => {
      const { provider } = sdkProvider(pauseScript('second_tool'));
      const h = ioHarness({ email_send: PENDING, artifact_publish: LOCKED });
      const events = await collect(provider, request('claude_agent_sdk'), h.io());
      expect(events.filter((e) => e.type === 'paused_for_approval')).toHaveLength(1);
      expect(events.at(-1)).toEqual({ type: 'paused_for_approval', approvalRequestId: 'apr-1' });
      expect(h.invoked.map((i) => i.name)).toEqual(['email_send', 'artifact_publish']);
    });

    it('agent không chịu dừng tới maxTurns: vẫn coi là tạm dừng thay vì lỗi', async () => {
      const { provider } = sdkProvider(async function* ({ tools }) {
        yield sdkInit;
        await tools.get('email_send')!.handler(EMAIL_INPUT);
        yield { type: 'result', subtype: 'error_max_turns' };
      });
      const h = ioHarness({ email_send: PENDING });
      const events = await collect(provider, request('claude_agent_sdk'), h.io());
      expect(events.at(-1)).toEqual({ type: 'paused_for_approval', approvalRequestId: 'apr-1' });
      expect(types(events)).not.toContain('error');
    });

    it('resume: dùng lại session đã giữ và đưa kết quả duyệt làm prompt', async () => {
      const { provider, captured } = sdkProvider(async function* () {
        yield sdkInit;
        yield sdkAssistant('m3');
        yield { type: 'result', subtype: 'success', result: 'Hoàn tất' };
      });
      const notice = 'Kết quả phê duyệt: đã duyệt';
      const events = await collect(
        provider,
        request('claude_agent_sdk', { input: notice, resumeSessionId: 'session-1' }),
        ioHarness({}).io(),
      );
      expect(captured.options?.resume).toBe('session-1');
      expect(captured.prompt).toBe(notice);
      expect(types(events)).toContain('finished');
    });
  });

  describe('fake', () => {
    const fakeRequest = (
      objective: string,
      runtimeKind: 'messages_api' | 'claude_agent_sdk' = 'claude_agent_sdk',
    ) =>
      request(runtimeKind, {
        input: renderInput({
          task_objective: objective,
          acceptance_criteria: [{ id: 'c1', text: 'Có nội dung' }],
          expected_output: 'Báo cáo',
        }),
      });

    it('kịch bản prompt injection: pending_approval → paused_for_approval, không nộp artifact, không gọi tool khác', async () => {
      const h = ioHarness({ email_send: PENDING });
      const events = await collect(
        new FakeModelProvider(),
        fakeRequest('Viết báo cáo [[fake:prompt_injection]]'),
        h.io(),
      );
      expect(events.at(-1)).toEqual({ type: 'paused_for_approval', approvalRequestId: 'apr-1' });
      expect(events.some((e) => e.type === 'session')).toBe(true);
      expect(h.invoked.map((i) => i.name)).toEqual(['email_send']);
      expect(types(events)).not.toContain('finished');
    });

    it('run_locked cũng làm fake tạm dừng thay vì tiếp tục nộp kết quả', async () => {
      const h = ioHarness({ email_send: LOCKED });
      const events = await collect(
        new FakeModelProvider(),
        fakeRequest('Gửi email tóm tắt cho khách hàng'),
        h.io(),
      );
      expect(events.at(-1)?.type).toBe('paused_for_approval');
      expect(h.invoked.map((i) => i.name)).toEqual(['email_send']);
    });

    it('resume sau duyệt: đọc kết quả phê duyệt, nộp artifact nêu kết quả và hoàn tất, không đề xuất lại email', async () => {
      const h = ioHarness({});
      const notice = renderInput({
        approval_result: {
          actionType: 'email.send',
          decision: 'rejected',
          reason: 'Không gửi cho người lạ',
          executed: false,
        },
      });
      const events = await collect(
        new FakeModelProvider(),
        request('claude_agent_sdk', { input: notice, resumeSessionId: 'fake-session-x' }),
        h.io(),
      );
      expect(types(events)).toContain('finished');
      expect(h.invoked.map((i) => i.name)).toEqual(['artifact_publish']);
      const published = h.invoked[0]!.input as { content: string };
      expect(published.content).toContain('bị từ chối');
      expect(published.content).toContain('Không gửi cho người lạ');
    });
  });
});
