import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  GATEWAY_ERROR,
  type AgentRunEvent,
  type AgentRunIO,
  type AgentRunRequest,
  type ModelGateway,
} from '../types';

/** Số lượt model tối đa trong một run, chặn vòng lặp tool-use vô hạn khi model không chịu dừng. */
const MAX_TURNS = 40;

type Message = { role: 'user' | 'assistant'; content: unknown };

export type MessagesApiProviderOptions = {
  apiKey?: string;
  /** Trỏ tới proxy hoặc server giả (test dùng HTTP mock). */
  baseURL?: string;
  /** Thay client (test). Mặc định tạo client từ `apiKey` / `baseURL`. */
  client?: Pick<Anthropic, 'messages'>;
};

function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    return status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500);
  }
  return false;
}

/**
 * Runtime `messages_api` (vai trò tài liệu/phân tích, AI Manager): vòng lặp tool-use tự viết trên
 * `@anthropic-ai/sdk`. Kiểm soát từng lượt: `beforeModelCall` trước mỗi request, `model_call_started` ngay
 * trước request, `max_tokens` theo `limits`. Mọi tool đi qua `io.invokeTool`.
 */
export class MessagesApiProvider implements ModelGateway {
  private readonly client: Pick<Anthropic, 'messages'>;

  constructor(options: MessagesApiProviderOptions = {}) {
    this.client =
      options.client ??
      new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL, maxRetries: 0 });
  }

  async *runAgent(req: AgentRunRequest, io: AgentRunIO): AsyncGenerator<AgentRunEvent> {
    // Resume sau phê duyệt: hội thoại đã lưu kết thúc bằng kết quả tool `pending_approval`/`run_locked`; kết quả duyệt
    // (`req.input`) được thêm thành một lượt user mới (engine-interfaces.md).
    const messages: Message[] = Array.isArray(req.resumeConversation)
      ? [...(req.resumeConversation as Message[]), { role: 'user', content: req.input }]
      : [{ role: 'user', content: req.input }];
    const useTools = !req.structuredOutput && req.tools.length > 0;
    const toolByName = new Map(req.tools.map((t) => [t.name, t]));
    const outputFormat = req.structuredOutput
      ? { type: 'json_schema' as const, schema: z.toJSONSchema(req.structuredOutput) as Record<string, unknown> }
      : undefined;

    let previousInput = 0;
    let lastText = '';
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      // Ước tính theo R6: input của lượt trước + nội dung mới + max_tokens.
      const newBytes = turn === 0 ? Buffer.byteLength(JSON.stringify(messages)) : 2_000;
      const estInputTokens = previousInput + Math.ceil(newBytes / 3);
      const estOutputTokens = req.limits.maxTokens;
      if (
        !(await io.beforeModelCall({
          modelId: req.modelId,
          estTokens: estInputTokens + estOutputTokens,
          estInputTokens,
          estOutputTokens,
        }))
      ) {
        yield {
          type: 'error',
          code: GATEWAY_ERROR.BUDGET_EXCEEDED,
          message: 'Hết ngân sách trước lượt gọi model',
          retryable: false,
        };
        return;
      }

      yield { type: 'model_call_started' };
      let response: Anthropic.Message;
      try {
        response = await this.client.messages.create(
          {
            model: req.modelId,
            max_tokens: req.limits.maxTokens,
            system: req.systemPrompt,
            messages: messages as Anthropic.MessageParam[],
            ...(useTools
              ? {
                  tools: req.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
                  })),
                }
              : {}),
            ...(outputFormat ? { output_config: { format: outputFormat } } : {}),
          },
          { signal: io.signal, timeout: req.limits.timeoutMs },
        );
      } catch (error) {
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
              retryable: isRetryable(error),
            };
        return;
      }

      const usage = response.usage;
      previousInput =
        usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      yield {
        type: 'model_call',
        messageId: response.id,
        modelId: response.model,
        usage: {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        },
      };

      messages.push({ role: 'assistant', content: response.content });
      const text = response.content
        .flatMap((b) => (b.type === 'text' ? [b.text] : []))
        .join('\n');
      if (text) {
        lastText = text;
        yield { type: 'text', text };
      }

      const toolUses = response.content.flatMap((b) => (b.type === 'tool_use' ? [b] : []));
      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
        if (response.stop_reason === 'max_tokens') {
          yield {
            type: 'error',
            code: GATEWAY_ERROR.INVALID_OUTPUT,
            message: 'Model bị cắt do chạm max_tokens',
            retryable: false,
          };
          return;
        }
        yield* this.finish(req, lastText);
        return;
      }

      const results: Array<Record<string, unknown>> = [];
      let pause: string | null = null;
      for (const use of toolUses) {
        yield { type: 'tool_call', name: use.name, status: 'started' };
        const spec = toolByName.get(use.name);
        const result = spec
          ? await io.invokeTool({ name: use.name, input: use.input, providerCallId: use.id })
          : { status: 'denied' as const, message: `Tool "${use.name}" chưa được cấp` };
        yield { type: 'tool_call', name: use.name, status: 'finished' };
        if (result.status === 'pending_approval' || result.status === 'run_locked') {
          pause ??= String((result.output as { approvalRequestId?: string } | undefined)?.approvalRequestId ?? '');
        }
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(result),
          is_error: result.status === 'error' || result.status === 'denied',
        });
      }
      messages.push({ role: 'user', content: results });

      if (pause !== null) {
        // Lưu hội thoại gồm kết quả `pending_approval`/`run_locked`; resume thêm kết quả duyệt thành lượt user mới.
        await io.saveConversation(messages);
        yield { type: 'paused_for_approval', approvalRequestId: pause };
        return;
      }
    }
    yield {
      type: 'error',
      code: GATEWAY_ERROR.MAX_TURNS,
      message: `Vượt quá ${MAX_TURNS} lượt model`,
      retryable: false,
    };
  }

  /** Kết thúc run; với structured output thì parse JSON và kiểm tra schema. */
  private *finish(req: AgentRunRequest, text: string): Generator<AgentRunEvent> {
    if (!req.structuredOutput) {
      yield { type: 'finished', output: { summary: text }, text };
      return;
    }
    try {
      const parsed = req.structuredOutput.safeParse(JSON.parse(text));
      if (!parsed.success) throw new Error(parsed.error.message);
      yield { type: 'finished', output: parsed.data, text };
    } catch (error) {
      yield {
        type: 'error',
        code: GATEWAY_ERROR.INVALID_OUTPUT,
        message: `Kết quả không đúng schema: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
      };
    }
  }
}
