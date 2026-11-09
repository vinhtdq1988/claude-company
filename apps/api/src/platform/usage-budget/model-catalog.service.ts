import { Injectable } from '@nestjs/common';
import type { ModelCatalog, ModelInfo } from '@claude-company/contracts';
import { withGlobal } from '@claude-company/db';
import { modelPrice } from '@claude-company/db/schema/usage';
import { desc, lte } from 'drizzle-orm';

/**
 * Danh mục model cấu hình sẵn và giá. Đây là nơi duy nhất đọc `model_price`; engine khác hỏi qua
 * interface `ModelCatalog`. Mỗi model lấy dòng giá có `effective_from` mới nhất không vượt quá hiện tại.
 */
@Injectable()
export class ModelCatalogService implements ModelCatalog {
  async listModels(): Promise<ModelInfo[]> {
    const rows = await withGlobal((tx) =>
      tx
        .selectDistinctOn([modelPrice.modelId])
        .from(modelPrice)
        .where(lte(modelPrice.effectiveFrom, new Date()))
        .orderBy(modelPrice.modelId, desc(modelPrice.effectiveFrom)),
    );
    return rows.map((r) => ({
      modelId: r.modelId,
      inputPerMtok: Number(r.inputPerMtok),
      outputPerMtok: Number(r.outputPerMtok),
      cacheReadPerMtok: Number(r.cacheReadPerMtok),
      cacheWritePerMtok: Number(r.cacheWritePerMtok),
    }));
  }

  async hasModel(modelId: string): Promise<boolean> {
    return (await this.listModels()).some((m) => m.modelId === modelId);
  }
}
