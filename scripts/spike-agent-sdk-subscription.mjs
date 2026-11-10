// Spike: chạy runtime `claude_agent_sdk` bằng đăng nhập subscription (Claude Code CLI đã `claude login`) thay vì API key.
// CHỈ dùng trên máy cá nhân để thử nghiệm; điều khoản Anthropic không cho dùng subscription cá nhân để chạy dịch vụ.
//
//   node --import @swc-node/register/esm-register scripts/spike-agent-sdk-subscription.mjs [modelId]
//
// Cố ý KHÔNG truyền ANTHROPIC_API_KEY: nếu biến này có trong môi trường, CLI sẽ ưu tiên nó và tính tiền theo token.
import process from 'node:process';
import { z } from 'zod';
import { createModelGateway } from '../packages/model-gateway/src/index.ts';

const modelId = process.argv[2] ?? 'claude-haiku-5-5';
const out = (line) => process.stdout.write(`${line}\n`);

const baseEnv = { ...process.env };
delete baseEnv.ANTHROPIC_API_KEY;
// Dùng token dài hạn (`claude setup-token`) nếu có, nếu không CLI đọc đăng nhập lưu trong thư mục HOME.
// Đúng đường đi của `MODEL_PROVIDER=claude_subscription`: cả hai runtime qua Agent SDK, không có API key.
const provider = createModelGateway({ provider: 'claude_subscription', agentSdk: { baseEnv } });

const calls = [];
const io = {
  async invokeTool(call) {
    calls.push(call);
    out(`  [tool] ${call.name} ${JSON.stringify(call.input)}`);
    return { status: 'ok', output: { echoed: call.input } };
  },
  async beforeModelCall() {
    return true;
  },
  async saveConversation() {},
  signal: new globalThis.AbortController().signal,
};

const req = {
  runtimeKind: 'claude_agent_sdk',
  modelId,
  systemPrompt: 'Bạn là trợ lý thử nghiệm. Trả lời ngắn gọn bằng tiếng Việt.',
  input: 'Gọi tool echo với text "xin chào" đúng một lần, sau đó tóm tắt kết quả trong một câu.',
  tools: [
    {
      name: 'echo',
      actionType: 'task.message.post',
      description: 'Trả lại đúng văn bản đã gửi.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      zodShape: { text: z.string() },
    },
  ],
  workspacePath: process.cwd(),
  limits: { maxCostUsd: 0.5, maxTokens: 20_000, timeoutMs: 120_000, maxTurns: 4 },
};

out(
  `Model: ${modelId} | ANTHROPIC_API_KEY trong env: ${process.env.ANTHROPIC_API_KEY ? 'có (đã bỏ khi chạy)' : 'không'}`,
);

async function run(title, request, expect) {
  out(`--- ${title}`);
  let failed = false;
  let finished = null;
  for await (const event of provider.runAgent(request, io)) {
    if (event.type === 'text') out(`  [text] ${event.text}`);
    else if (event.type === 'model_call')
      out(`  [usage] ${event.modelId} ${JSON.stringify(event.usage)}`);
    else if (event.type === 'error') {
      failed = true;
      out(`  [error] ${event.code}: ${event.message}`);
    } else if (event.type === 'finished') {
      finished = event;
      out(`  [finished] ${JSON.stringify(event.output)}`);
    } else out(`  [${event.type}]`);
  }
  const ok = !failed && finished !== null && expect(finished);
  out(ok ? '  => đạt' : '  => KHÔNG đạt');
  return ok;
}

const plan = z.object({ mode: z.enum(['confirm', 'split']), reason: z.string() });
const results = [
  await run('claude_agent_sdk + tool MCP', req, () => calls.length === 1),
  await run(
    'messages_api + structured output (decompose)',
    {
      ...req,
      runtimeKind: 'messages_api',
      tools: [],
      input: 'Task: viết một đoạn giới thiệu 2 câu. Hãy chọn mode "confirm" và nêu lý do ngắn.',
      structuredOutput: plan,
    },
    (f) => plan.safeParse(f.output).success,
  ),
];
out(results.every(Boolean) ? 'KẾT QUẢ: đạt cả hai' : 'KẾT QUẢ: có lỗi');
process.exit(results.every(Boolean) ? 0 : 1);
