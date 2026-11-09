import type { RuntimeKind } from '@claude-company/contracts';
import type { ZodType } from 'zod';

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/**
 * Tool cấp cho agent, sinh từ danh mục ActionType (`buildToolSpecs`). `name` là ActionType đổi `.` thành `_`.
 * `zodShape` là các trường Zod của input: Agent SDK nhận tool định nghĩa bằng Zod raw shape, còn
 * Messages API dùng `inputSchema` (JSON Schema sinh từ cùng schema Zod).
 */
export type ToolSpec = {
  name: string;
  actionType: string;
  description: string;
  inputSchema: Record<string, unknown>;
  zodShape?: Record<string, ZodType>;
};

export type AgentRunRequest = {
  runtimeKind: RuntimeKind;
  modelId: string;
  systemPrompt: string;
  /** Mục tiêu + tiêu chí + ngữ cảnh memory (đánh dấu là dữ liệu). */
  input: string;
  /** Chỉ tool đã cấp. */
  tools: ToolSpec[];
  workspacePath?: string;
  resumeSessionId?: string;
  /** `messages_api`: hội thoại đã lưu khi tạm dừng chờ duyệt. */
  resumeConversation?: unknown;
  limits: { maxCostUsd: number; maxTokens: number; timeoutMs: number; maxTurns?: number };
  /** Decompose / review: kết quả phải đúng schema này. */
  structuredOutput?: ZodType;
};

export type ToolResultStatus = 'ok' | 'pending_approval' | 'run_locked' | 'denied' | 'error';

export type ToolCallResult = {
  status: ToolResultStatus;
  output?: unknown;
  message?: string;
};

export type AgentRunIO = {
  /**
   * Mọi lời gọi tool đi qua đây → ToolBroker → PermissionEngine. Provider KHÔNG được thực thi tool theo cách khác.
   */
  invokeTool(call: { name: string; input: unknown; providerCallId: string }): Promise<ToolCallResult>;
  /**
   * Gọi trước mỗi lượt model; `false` → provider dừng ngay. Chỉ `messages_api` và fake;
   * `claude_agent_sdk` dùng reservation theo run + `maxBudgetUsd`.
   */
  beforeModelCall(est: {
    modelId: string;
    estTokens: number;
    /** Tách theo R6 để tính chi phí ước tính: input giá thường + `max_tokens` giá output. */
    estInputTokens?: number;
    estOutputTokens?: number;
  }): Promise<boolean>;
  /** Chỉ `messages_api`: gọi trước khi phát `paused_for_approval`. */
  saveConversation(messages: unknown): Promise<void>;
  signal: AbortSignal;
};

export type AgentRunEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'model_call_started' }
  | { type: 'model_call'; messageId: string; modelId: string; usage: TokenUsage }
  | { type: 'tool_call'; name: string; status: 'started' | 'finished' }
  | { type: 'text'; text: string }
  | { type: 'progress'; percent: number; summary: string }
  | { type: 'paused_for_approval'; approvalRequestId: string }
  | { type: 'finished'; output: unknown; text: string }
  | { type: 'error'; code: string; message: string; retryable: boolean };

export interface ModelGateway {
  runAgent(req: AgentRunRequest, io: AgentRunIO): AsyncIterable<AgentRunEvent>;
}

/** Mã lỗi provider dùng chung với run-loop. */
export const GATEWAY_ERROR = {
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  MAX_TURNS: 'MAX_TURNS',
} as const;

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}
