import { Global, Module } from '@nestjs/common';
import { BUDGET_SERVICE, MODEL_CATALOG } from '../engine-tokens';
import { BudgetController } from './budget.controller';
import { UsageBudgetService } from './budget.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { ModelCatalogService } from './model-catalog.service';

/** Phần Usage & Budget của platform: danh mục model, `BudgetService`, API chính sách/usage và Company Dashboard. */
@Global()
@Module({
  controllers: [BudgetController, DashboardController],
  providers: [
    ModelCatalogService,
    UsageBudgetService,
    DashboardService,
    { provide: MODEL_CATALOG, useExisting: ModelCatalogService },
    { provide: BUDGET_SERVICE, useExisting: UsageBudgetService },
  ],
  exports: [MODEL_CATALOG, ModelCatalogService, BUDGET_SERVICE, UsageBudgetService],
})
export class UsageBudgetModule {}
