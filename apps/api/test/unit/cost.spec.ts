import { describe, expect, it } from 'vitest';
import {
  computeCostUsd,
  estimateMessagesApiTurn,
  estimateSdkRun,
  periodOf,
  sdkMaxBudgetUsd,
  sdkTokenCeiling,
  totalTokens,
} from '../../src/platform/usage-budget/cost';

const price = { inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75 };

describe('cost', () => {
  it('chi phí = token × giá cấu hình, tính cả cache', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 400_000,
    };
    // 3 + 1.5 + 0.6 + 1.5
    expect(computeCostUsd(usage, price)).toBe(6.6);
    expect(totalTokens(usage)).toBe(3_500_000);
  });

  it('làm tròn 6 chữ số thập phân', () => {
    expect(
      computeCostUsd(
        { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        price,
      ),
    ).toBe(0.000018);
  });

  it('periodOf theo múi giờ công ty: 23:30 UTC ngày cuối tháng đã là tháng sau ở Asia/Ho_Chi_Minh', () => {
    const instant = new Date('2026-11-30T23:30:00Z');
    expect(periodOf(instant, 'UTC')).toBe('2026-11');
    expect(periodOf(instant, 'Asia/Ho_Chi_Minh')).toBe('2026-12');
  });

  it('ước tính lượt messages_api: lượt đầu chỉ có phần nội dung mới + max_tokens', () => {
    const e = estimateMessagesApiTurn({ newContentBytes: 3_000, maxTokens: 4_000, price });
    expect(e.estTokens).toBe(1_000 + 4_000);
    expect(e.estCostUsd).toBeCloseTo((1_000 * 3 + 4_000 * 15) / 1e6, 6);
  });

  it('ước tính lượt sau cộng input của lượt trước', () => {
    const e = estimateMessagesApiTurn({
      previousInputTokens: 10_000,
      newContentBytes: 10,
      maxTokens: 100,
      price,
    });
    expect(e.estTokens).toBe(10_000 + 4 + 100);
  });

  it('ước tính run SDK: mặc định theo cấu hình, giảm theo phần còn lại của trần task', () => {
    expect(estimateSdkRun({ reserveUsd: 2, reserveTokens: 200_000 })).toEqual({
      blocked: false,
      estTokens: 200_000,
      estCostUsd: 2,
    });
    expect(
      estimateSdkRun({
        reserveUsd: 2,
        reserveTokens: 200_000,
        costCapRemaining: 0.5,
        tokenCapRemaining: 50_000,
      }),
    ).toEqual({ blocked: false, estTokens: 50_000, estCostUsd: 0.5 });
  });

  it('trần task còn 0 thì chặn', () => {
    expect(estimateSdkRun({ reserveUsd: 2, reserveTokens: 1, costCapRemaining: 0 })).toEqual({
      blocked: true,
    });
    expect(estimateSdkRun({ reserveUsd: 2, reserveTokens: 1, tokenCapRemaining: 0 })).toEqual({
      blocked: true,
    });
  });

  it('headroom của maxBudgetUsd và ngưỡng token', () => {
    expect(sdkMaxBudgetUsd(2, 0.1)).toBe(1.8);
    expect(sdkTokenCeiling(200_000, 0.1)).toBe(180_000);
  });
});
