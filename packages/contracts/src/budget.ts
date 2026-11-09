// US3 (T108) dùng phần lõi dưới đây; US6 (T167) bổ sung Zod schema cho API chính sách ngân sách.

/** Giới hạn bị chạm; `scopeKind = 'task'` khi chạm trần `token_cap`/`cost_cap` của task. */
export type LimitRef = {
  scopeKind: string;
  scopeId: string;
  kind: 'tokens' | 'cost' | 'concurrency';
  limit: number;
  used: number;
};

/** Mức sử dụng thực tế của một lượt gọi model, ghi vào `usage_ledger` (chỉ INSERT). */
export type UsageRecordInput = {
  /** `message.id` của nhà cung cấp: khóa chống đếm trùng. */
  providerMessageId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
};

export type UsageSummary = {
  period: string;
  tokens: number;
  costUsd: number;
  groups: Array<{ key: string; tokens: number; costUsd: number }>;
};
