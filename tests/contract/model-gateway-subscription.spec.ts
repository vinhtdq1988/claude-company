import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildSdkEnv,
  cliJsonSchema,
  ClaudeAgentSdkProvider,
  createModelGateway,
  type AgentRunEvent,
  type AgentRunIO,
  type AgentRunRequest,
  type ModelGateway,
  type ToolCallResult,
} from '@claude-company/model-gateway';

/**
 * `MODEL_PROVIDER=claude_subscription` (chỉ chạy local): cả hai runtime đi qua Agent SDK, KHÔNG truyền API key vào
 * subprocess để Claude Code CLI dùng đăng nhập subscription; decompose/review có structured output; vai trò
 * `messages_api` lưu session khi tạm dừng chờ duyệt. Dùng `queryFn` giả nên không gọi mạng, không tốn token.
 */

const TOOL = {
  name: 'email_send',
  actionType: 'email.send',
  description: 'Gửi email',
  inputSchema: { type: 'object' },
  zodShape: { to: z.string() },
};

const request = (over: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
  runtimeKind: 'claude_agent_sdk',
  modelId: 'claude-haiku-5-5',
  systemPrompt: 'Bạn là AI Employee.',
  input: 'Viết báo cáo',
  tools: [TOOL],
  limits: { maxCostUsd: 1, maxTokens: 4096, timeoutMs: 5_000 },
  ...over,
});

type Handler = (args: unknown) => Promise<unknown>;

function fakeProvider(
  script: () => AsyncGenerator<unknown>,
  over: { subscription?: boolean; apiKey?: string } = {},
) {
  const tools = new Map<string, Handler>();
  const captured: { options?: Record<string, unknown> } = {};
  const provider = new ClaudeAgentSdkProvider({
    ...over,
    baseEnv: {
      PATH: '/usr/bin',
      HOME: '/home/x',
      ANTHROPIC_API_KEY: 'sk-trong-env',
      DATABASE_URL: 'postgres://secret',
    },
    mcp: {
      tool: ((name: string, _d: string, _s: unknown, handler: Handler) => {
        tools.set(name, handler);
        return { name } as never;
      }) as never,
      createSdkMcpServer: (() => ({ type: 'sdk', name: 'cc', instance: {} })) as never,
    },
    queryFn: ({ options }) => {
      captured.options = options as unknown as Record<string, unknown>;
      return script() as never;
    },
  });
  return { provider, tools, captured };
}

function io(toolResult: ToolCallResult = { status: 'ok' }) {
  const saved: unknown[] = [];
  const handle: AgentRunIO = {
    invokeTool: async () => toolResult,
    beforeModelCall: async () => true,
    saveConversation: async (m) => void saved.push(m),
    signal: new AbortController().signal,
  };
  return { io: handle, saved };
}

async function collect(gateway: ModelGateway, req: AgentRunRequest, h: AgentRunIO) {
  const events: AgentRunEvent[] = [];
  for await (const e of gateway.runAgent(req, h)) events.push(e);
  return events;
}

const init = { type: 'system', subtype: 'init', session_id: 'session-1' };
const success = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  result: 'Xong',
  ...extra,
});

describe('Contract: ModelGateway — claude_subscription (chỉ local)', () => {
  describe('env của subprocess', () => {
    it('không truyền ANTHROPIC_API_KEY dù có trong env hoặc option; vẫn chỉ gồm PATH, HOME', () => {
      const env = buildSdkEnv({
        subscription: true,
        apiKey: 'sk-test',
        baseEnv: {
          PATH: '/usr/bin',
          HOME: '/home/x',
          ANTHROPIC_API_KEY: 'sk-env',
          SESSION_SECRET: 'x',
        },
      });
      expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH']);
      expect(JSON.stringify(env)).not.toContain('sk-');
    });

    it('chế độ anthropic (production) vẫn truyền API key như cũ', () => {
      const env = buildSdkEnv({
        apiKey: 'sk-prod',
        baseEnv: { PATH: '/usr/bin', HOME: '/home/x' },
      });
      expect(env.ANTHROPIC_API_KEY).toBe('sk-prod');
    });

    it('options.env gửi vào SDK trong chế độ subscription không có key', async () => {
      const { provider, captured } = fakeProvider(
        async function* () {
          yield init;
          yield success();
        },
        { subscription: true },
      );
      await collect(provider, request(), io().io);
      expect(Object.keys(captured.options?.env as object).sort()).toEqual(['HOME', 'PATH']);
    });
  });

  describe('gateway', () => {
    it('cả claude_agent_sdk lẫn messages_api đi qua Agent SDK, không cần apiKey', async () => {
      const runtimes: string[] = [];
      const gateway = createModelGateway({
        provider: 'claude_subscription',
        agentSdk: {
          baseEnv: { PATH: '/usr/bin', HOME: '/home/x', ANTHROPIC_API_KEY: 'sk-env' },
          queryFn: ({ options }) => {
            runtimes.push(String((options.env as Record<string, string>).ANTHROPIC_API_KEY));
            return (async function* () {
              yield init;
              yield success();
            })() as never;
          },
        },
      });
      for (const runtimeKind of ['claude_agent_sdk', 'messages_api'] as const) {
        const events = await collect(gateway, request({ runtimeKind }), io().io);
        expect(events.at(-1)).toMatchObject({ type: 'finished' });
      }
      expect(runtimes).toEqual(['undefined', 'undefined']);
    });
  });

  describe('structured output (decompose, review)', () => {
    const schema = z.object({ mode: z.enum(['confirm', 'split']), reason: z.string() });
    const structured = () =>
      request({ runtimeKind: 'messages_api', tools: [], structuredOutput: schema });

    it('yêu cầu SDK trả JSON theo schema và hoàn tất bằng object đã kiểm tra', async () => {
      const { provider, captured } = fakeProvider(async function* () {
        yield init;
        yield success({ structured_output: { mode: 'confirm', reason: 'Đủ rõ' } });
      });
      const events = await collect(provider, structured(), io().io);
      expect(captured.options?.outputFormat).toMatchObject({ type: 'json_schema' });
      expect(captured.options?.tools).toEqual([]);
      expect(events.at(-1)).toMatchObject({
        type: 'finished',
        output: { mode: 'confirm', reason: 'Đủ rõ' },
      });
    });

    it('chấp nhận JSON ở dạng chuỗi khi SDK không có structured_output', async () => {
      const { provider } = fakeProvider(async function* () {
        yield init;
        yield { type: 'result', subtype: 'success', result: '{"mode":"split","reason":"Lớn"}' };
      });
      const events = await collect(provider, structured(), io().io);
      expect(events.at(-1)).toMatchObject({
        type: 'finished',
        output: { mode: 'split', reason: 'Lớn' },
      });
    });

    it('sai schema hoặc không phải JSON → INVALID_OUTPUT, không thử lại', async () => {
      for (const result of [
        success({ structured_output: { mode: 'khac', reason: 1 } }),
        { type: 'result', subtype: 'success', result: 'không phải json' },
        { type: 'result', subtype: 'error_max_structured_output_retries' },
      ]) {
        const { provider } = fakeProvider(async function* () {
          yield init;
          yield result;
        });
        const events = await collect(provider, structured(), io().io);
        expect(events.at(-1)).toMatchObject({
          type: 'error',
          code: 'INVALID_OUTPUT',
          retryable: false,
        });
      }
    });

    it('schema gửi cho CLI không có $schema (CLI không giải được URL draft 2020-12; đã gặp khi chạy thật)', async () => {
      expect(cliJsonSchema(schema)).not.toHaveProperty('$schema');
      expect(cliJsonSchema(schema)).toMatchObject({ type: 'object' });
      const { provider, captured } = fakeProvider(async function* () {
        yield init;
        yield success({ structured_output: { mode: 'confirm', reason: 'x' } });
      });
      await collect(provider, structured(), io().io);
      expect(captured.options?.outputFormat).not.toHaveProperty('schema.$schema');
    });

    it('tool nội bộ StructuredOutput chỉ được phép khi run cần structured output; tool lạ vẫn bị từ chối', async () => {
      type Hook = (
        input: unknown,
      ) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>;
      const hookOf = async (req: AgentRunRequest) => {
        const { provider, captured } = fakeProvider(async function* () {
          yield init;
          yield success({ structured_output: { mode: 'confirm', reason: 'x' } });
        });
        await collect(provider, req, io().io);
        const hooks = captured.options?.hooks as { PreToolUse: Array<{ hooks: Hook[] }> };
        return {
          hook: hooks.PreToolUse[0]!.hooks[0]!,
          allowed: captured.options?.allowedTools as string[],
        };
      };
      const withSchema = await hookOf(structured());
      expect(await withSchema.hook({ tool_name: 'StructuredOutput' })).toEqual({});
      expect(withSchema.allowed).toContain('StructuredOutput');
      expect(
        (await withSchema.hook({ tool_name: 'Bash' })).hookSpecificOutput?.permissionDecision,
      ).toBe('deny');

      const plain = await hookOf(request());
      expect(
        (await plain.hook({ tool_name: 'StructuredOutput' })).hookSpecificOutput
          ?.permissionDecision,
      ).toBe('deny');
      expect(plain.allowed).not.toContain('StructuredOutput');
    });

    it('run không có structuredOutput không đặt outputFormat', async () => {
      const { provider, captured } = fakeProvider(async function* () {
        yield init;
        yield success();
      });
      await collect(provider, request(), io().io);
      expect(captured.options).not.toHaveProperty('outputFormat');
    });
  });

  describe('tạm dừng chờ Human Approval', () => {
    async function run(runtimeKind: 'claude_agent_sdk' | 'messages_api') {
      const tools = new Map<string, Handler>();
      const provider = new ClaudeAgentSdkProvider({
        subscription: true,
        baseEnv: { PATH: '/usr/bin', HOME: '/home/x' },
        mcp: {
          tool: ((name: string, _d: string, _s: unknown, handler: Handler) => {
            tools.set(name, handler);
            return { name } as never;
          }) as never,
          createSdkMcpServer: (() => ({ type: 'sdk', name: 'cc', instance: {} })) as never,
        },
        // Gọi handler MCP đúng như SDK làm khi agent dùng tool.
        queryFn: () =>
          (async function* () {
            yield init;
            await tools.get('email_send')?.({ to: 'a@b.vn' });
            yield success();
          })() as never,
      });
      const h = io({ status: 'pending_approval', output: { approvalRequestId: 'ap-1' } });
      const events = await collect(provider, request({ runtimeKind }), h.io);
      return { events, saved: h.saved };
    }

    it('vai trò messages_api lưu session làm hội thoại để nối lại sau khi duyệt', async () => {
      const { events, saved } = await run('messages_api');
      expect(events.at(-1)).toEqual({ type: 'paused_for_approval', approvalRequestId: 'ap-1' });
      expect(saved).toEqual([{ sessionId: 'session-1' }]);
    });

    it('vai trò claude_agent_sdk không lưu hội thoại (run-loop nối lại bằng session của SDK)', async () => {
      const { events, saved } = await run('claude_agent_sdk');
      expect(events.at(-1)).toMatchObject({ type: 'paused_for_approval' });
      expect(saved).toEqual([]);
    });

    it('resume dùng lại session đã lưu', async () => {
      const { provider, captured } = fakeProvider(async function* () {
        yield init;
        yield success();
      });
      await collect(
        provider,
        request({ runtimeKind: 'messages_api', resumeSessionId: 'session-1' }),
        io().io,
      );
      expect(captured.options?.resume).toBe('session-1');
    });
  });
});
