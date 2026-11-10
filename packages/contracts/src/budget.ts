import { z } from 'zod';
import { uuidSchema } from './common';

// US3 (T108) dùng phần lõi (LimitRef, UsageRecordInput, UsageSummary); US6 (T167) bổ sung DTO của API chính sách ngân sách,
// usage và Company Dashboard.

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

// --- Chính sách ngân sách theo phạm vi (FR-031) ---

export const BUDGET_SCOPE_KINDS = ['company', 'org_unit', 'team', 'ai_employee'] as const;
export const budgetScopeKindSchema = z.enum(BUDGET_SCOPE_KINDS);
export type BudgetScopeKind = z.infer<typeof budgetScopeKindSchema>;

/** Ngưỡng cảnh báo mặc định khi phạm vi chưa khai báo (khớp `BUDGET_WARN_THRESHOLD`). */
export const DEFAULT_WARN_THRESHOLD = 0.8;

/**
 * Thân `PUT /budget-policies/{scopeKind}/{scopeId}`: thay toàn bộ chính sách của phạm vi. Trường bỏ trống hoặc `null`
 * nghĩa là phạm vi này không đặt giới hạn đó (vẫn chịu giới hạn của phạm vi cha; riêng công ty luôn có mặc định).
 * `maxConcurrentTasks` không nhận ở phạm vi `ai_employee` (đặt qua `PATCH /employees/{id}`); việc đó được kiểm tra theo
 * `scopeKind` trong đường dẫn, nên schema này không tự chặn được.
 */
export const putBudgetPolicySchema = z
  .object({
    monthlyTokenLimit: z.number().int().min(0).nullable().optional(),
    monthlyCostLimit: z.number().min(0).nullable().optional(),
    maxConcurrentTasks: z.number().int().min(1).max(1000).nullable().optional(),
    allowedModels: z.array(z.string().min(1)).min(1).nullable().optional(),
    warnThreshold: z.number().min(0).max(1).optional(),
  })
  .strict();
export type PutBudgetPolicyBody = z.infer<typeof putBudgetPolicySchema>;

export type BudgetPolicy = {
  scopeKind: BudgetScopeKind;
  scopeId: string;
  monthlyTokenLimit: number | null;
  monthlyCostLimit: number | null;
  /** Luôn `null` ở phạm vi `ai_employee`. */
  maxConcurrentTasks: number | null;
  allowedModels: string[] | null;
  warnThreshold: number;
  /**
   * `true` khi phạm vi chưa có bản ghi. Với công ty, giá trị trả về là hạn mức mặc định đang áp dụng
   * (không bao giờ là vô hạn); với phạm vi khác là "không đặt giới hạn riêng".
   */
  isDefault: boolean;
};

// --- Usage và Dashboard ---

/** Kỳ `YYYY-MM`, hoặc `all` cho mọi kỳ. */
export const usagePeriodSchema = z.union([
  z.literal('all'),
  z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
]);

export const usageQuerySchema = z.object({
  groupBy: z.enum(['employee', 'task', 'org_unit']).optional(),
  period: usagePeriodSchema.optional(),
  orgUnitId: uuidSchema.optional(),
  employeeId: uuidSchema.optional(),
  taskId: uuidSchema.optional(),
});
export type UsageQuery = z.infer<typeof usageQuerySchema>;

export const dashboardQuerySchema = z.object({
  orgUnitId: uuidSchema.optional(),
  period: usagePeriodSchema.optional(),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

/**
 * Company Dashboard (FR-040). Task đếm theo task gốc; token và chi phí tính trên mọi task kể cả task con, trong
 * `period` (mặc định tháng hiện tại theo múi giờ công ty); `allTime` là tổng mọi kỳ, khớp tổng theo task (SC-008).
 */
export type Dashboard = {
  orgUnitId: string | null;
  period: string;
  totalEmployees: number;
  activeTasks: number;
  completedTasks: number;
  /** `null` khi chưa có task gốc `completed` ("chưa có dữ liệu"). */
  onTimeCompletionRate: number | null;
  tokens: number;
  costUsd: number;
  allTime: { tokens: number; costUsd: number };
};

/** Giới hạn đồng thời áp lên một nhân viên từ chính sách của phạm vi (company, org_unit, team). */
export type ConcurrencyLimit = {
  scopeKind: Exclude<BudgetScopeKind, 'ai_employee'>;
  scopeId: string;
  max: number;
};
