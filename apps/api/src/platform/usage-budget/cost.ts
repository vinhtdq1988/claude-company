/** Giá một triệu token (USD) của một model, lấy từ `ModelCatalog` / bảng `model_price`. */
export type TokenPrice = {
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheWritePerMtok: number;
};

export type TokenCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

const MTOK = 1_000_000;

/** Làm tròn tới 6 chữ số thập phân, khớp `numeric(12,6)` của `usage_ledger`. */
export function roundUsd(value: number): number {
  return Math.round(value * MTOK) / MTOK;
}

/** Chi phí thực tế = token × bảng giá cấu hình, thống nhất giữa mọi provider (R3, R6). */
export function computeCostUsd(usage: TokenCounts, price: TokenPrice): number {
  const cost =
    (usage.inputTokens * price.inputPerMtok +
      usage.outputTokens * price.outputPerMtok +
      usage.cacheReadTokens * price.cacheReadPerMtok +
      usage.cacheWriteTokens * price.cacheWritePerMtok) /
    MTOK;
  return roundUsd(cost);
}

export function totalTokens(usage: TokenCounts): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** `YYYY-MM` của một thời điểm theo múi giờ công ty (tháng lịch, R6). */
export function periodOf(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  if (!year || !month) throw new Error(`Không tính được kỳ cho múi giờ ${timezone}`);
  return `${year}-${month}`;
}

export type Estimate = { estTokens: number; estCostUsd: number };

/**
 * Ước tính cho một lượt `messages_api` (R6): `estTokens = input ước tính + max_tokens`, trong đó input ước tính là
 * `input + cache tokens` của lượt trước cộng `ceil(byte nội dung mới / 3)`; lượt đầu chỉ có phần sau.
 * Chi phí tính input giá thường (không giảm giá cache) cộng `max_tokens` giá output.
 */
export function estimateMessagesApiTurn(input: {
  previousInputTokens?: number;
  newContentBytes: number;
  maxTokens: number;
  price: TokenPrice;
}): Estimate {
  const estInput = (input.previousInputTokens ?? 0) + Math.ceil(input.newContentBytes / 3);
  return {
    estTokens: estInput + input.maxTokens,
    estCostUsd: roundUsd(
      (estInput * input.price.inputPerMtok + input.maxTokens * input.price.outputPerMtok) / MTOK,
    ),
  };
}

export type SdkRunEstimate = (Estimate & { blocked: false }) | { blocked: true };

/**
 * Ước tính reservation một lần cho cả run `claude_agent_sdk` (R6): `SDK_RUN_RESERVE_*`, giảm xuống phần còn lại
 * của `cost_cap`/`token_cap` nếu task có trần; phần còn lại bằng 0 thì chặn.
 */
export function estimateSdkRun(input: {
  reserveUsd: number;
  reserveTokens: number;
  costCapRemaining?: number | null;
  tokenCapRemaining?: number | null;
}): SdkRunEstimate {
  const usd =
    input.costCapRemaining === null || input.costCapRemaining === undefined
      ? input.reserveUsd
      : Math.min(input.reserveUsd, input.costCapRemaining);
  const tokens =
    input.tokenCapRemaining === null || input.tokenCapRemaining === undefined
      ? input.reserveTokens
      : Math.min(input.reserveTokens, input.tokenCapRemaining);
  if (usd <= 0 || tokens <= 0) return { blocked: true };
  return { blocked: false, estTokens: tokens, estCostUsd: roundUsd(usd) };
}

/**
 * Ngân sách USD cho `maxBudgetUsd` của Agent SDK: phần đã giữ trừ headroom, vì ước tính phía client của SDK
 * có thể vượt thêm một phản hồi (R3).
 */
export function sdkMaxBudgetUsd(reservedUsd: number, headroom: number): number {
  return roundUsd(reservedUsd * (1 - headroom));
}

/** Ngưỡng token khóa tool của run SDK: `reserved_tokens × (1 − headroom)`. */
export function sdkTokenCeiling(reservedTokens: number, headroom: number): number {
  return Math.floor(reservedTokens * (1 - headroom));
}
