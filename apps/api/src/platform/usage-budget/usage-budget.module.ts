import { Global, Module } from '@nestjs/common';
import { BUDGET_SERVICE, DASHBOARD_READER, MODEL_CATALOG } from '../engine-tokens';
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
    { provide: DASHBOARD_READER, useExisting: DashboardService },
  ],
  exports: [
    MODEL_CATALOG,
    ModelCatalogService,
    BUDGET_SERVICE,
    UsageBudgetService,
    DASHBOARD_READER,
  ],
})
export class UsageBudgetModule {}
