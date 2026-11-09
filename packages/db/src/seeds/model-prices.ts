import { modelPrice } from '../schema/usage';
import type { Seeder } from '../seed';

type PriceSeed = {
  modelId: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
};

/**
 * Giá USD cho mỗi triệu token, lấy từ trang giá chính thức của Claude API
 * (https://platform.claude.com/docs/en/about-claude/pricing và trang tổng quan của từng model),
 * tra cứu ngày 2026-11-09. Cache write là mức bộ nhớ đệm 5 phút; Haiku 5.5 lấy mức cho prompt ≤ 100K token.
 *
 * LƯU Ý: bảng giá chính ở thời điểm tra cứu vẫn liệt kê Sonnet 5/Haiku 4.5, chưa khớp hẳn với trang
 * riêng của Sonnet 5.5/Haiku 5.5. Rà lại với trang giá trước khi dùng số liệu này để tính chi phí thật;
 * đổi giá bằng cách thêm dòng mới với `effective_from` mới, không sửa dòng cũ.
 */
export const modelPrices: readonly PriceSeed[] = [
  { modelId: 'claude-fable-5-1', input: '10', output: '50', cacheRead: '0.25', cacheWrite: '12.5' },
  { modelId: 'claude-opus-5-5', input: '4', output: '20', cacheRead: '0.2', cacheWrite: '5' },
  { modelId: 'claude-sonnet-5-5', input: '2', output: '10', cacheRead: '0.1', cacheWrite: '2.5' },
  {
    modelId: 'claude-haiku-5-5',
    input: '0.1',
    output: '0.5',
    cacheRead: '0.01',
    cacheWrite: '0.125',
  },
];

/** Ngày hiệu lực của bộ giá khởi tạo. */
export const INITIAL_PRICE_EFFECTIVE_FROM = new Date('2026-11-09T00:00:00.000Z');

export const modelPriceSeeder: Seeder = {
  name: 'model-prices',
  async run(db) {
    for (const p of modelPrices) {
      await db
        .insert(modelPrice)
        .values({
          modelId: p.modelId,
          inputPerMtok: p.input,
          outputPerMtok: p.output,
          cacheReadPerMtok: p.cacheRead,
          cacheWritePerMtok: p.cacheWrite,
          effectiveFrom: INITIAL_PRICE_EFFECTIVE_FROM,
        })
        .onConflictDoNothing({ target: [modelPrice.modelId, modelPrice.effectiveFrom] });
    }
  },
};
