import { Global, Module } from '@nestjs/common';
import { BUDGET_SERVICE, MODEL_CATALOG } from '../engine-tokens';
import { UsageBudgetService } from './budget.service';
import { ModelCatalogService } from './model-catalog.service';

/** Phần Usage & Budget của platform: danh mục model và `BudgetService` lõi (US6 bổ sung API chính sách và Dashboard). */
@Global()
@Module({
  providers: [
    ModelCatalogService,
    UsageBudgetService,
    { provide: MODEL_CATALOG, useExisting: ModelCatalogService },
    { provide: BUDGET_SERVICE, useExisting: UsageBudgetService },
  ],
  exports: [MODEL_CATALOG, ModelCatalogService, BUDGET_SERVICE, UsageBudgetService],
})
export class UsageBudgetModule {}
