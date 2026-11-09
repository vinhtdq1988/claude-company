// Type khung; US6 (T167) thay bằng Zod schema ngân sách.
export type LimitRef = {
  scopeKind: string;
  scopeId: string;
  kind: 'tokens' | 'cost' | 'concurrency';
  limit: number;
  used: number;
};

export type UsageRecordInput = {
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
