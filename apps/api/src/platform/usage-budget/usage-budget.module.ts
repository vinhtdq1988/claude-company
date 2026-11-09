import { Global, Module } from '@nestjs/common';
import { MODEL_CATALOG } from '../engine-tokens';
import { ModelCatalogService } from './model-catalog.service';

/** Phần Usage & Budget của platform. US6 bổ sung `BudgetService` vào module này. */
@Global()
@Module({
  providers: [ModelCatalogService, { provide: MODEL_CATALOG, useExisting: ModelCatalogService }],
  exports: [MODEL_CATALOG, ModelCatalogService],
})
export class UsageBudgetModule {}
