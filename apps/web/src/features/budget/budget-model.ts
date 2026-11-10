import type {
  BudgetPolicy,
  BudgetScopeKind,
  OrgChart,
  PutBudgetPolicyBody,
  Task,
} from '@claude-company/contracts';
import { DEFAULT_WARN_THRESHOLD } from '@claude-company/contracts';
import { flattenUnits } from '../org/org-tree';

// --- Định dạng số liệu ---

export const formatTokens = (value: number): string => value.toLocaleString('vi-VN');

/** Chi phí USD: tối thiểu 2 chữ số thập phân, tối đa 6 (khớp độ chính xác của sổ chi tiêu). */
export const formatUsd = (value: number): string =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;

/** Tỷ lệ `0..1` thành `%`; `null` là chưa có dữ liệu. */
export const formatRate = (value: number | null): string | null =>
  value === null ? null : `${Math.round(value * 100)}%`;

/** Mức dùng so với giới hạn, `null` nếu không có giới hạn (hoặc giới hạn bằng 0). */
export function usageRatio(used: number, limit: number | null): number | null {
  if (limit === null || limit <= 0) return null;
  return used / limit;
}

export type UsageLevel = 'ok' | 'warn' | 'over';

/** `warn` từ ngưỡng cảnh báo, `over` khi đã chạm giới hạn. */
export function usageLevel(ratio: number | null, threshold: number): UsageLevel {
  if (ratio === null) return 'ok';
  if (ratio >= 1) return 'over';
  return ratio >= threshold ? 'warn' : 'ok';
}

// --- Danh sách phạm vi để chọn ---

export type ScopeOption = {
  kind: BudgetScopeKind;
  id: string;
  label: string;
  depth: number;
};

export const scopeKey = (scope: Pick<ScopeOption, 'kind' | 'id'>): string =>
  `${scope.kind}:${scope.id}`;

/**
 * Các phạm vi có thể đặt giới hạn: công ty (chỉ CEO), từng đơn vị (thụt theo cấp), team và nhân viên. Server vẫn là
 * nơi cưỡng chế phạm vi; danh sách này chỉ giúp người dùng không phải nhập id.
 */
export function buildScopeOptions(input: {
  companyId: string;
  companyName: string;
  chart: OrgChart | undefined;
  employees: ReadonlyArray<{ id: string; name: string; status: string }>;
  isCeo: boolean;
}): ScopeOption[] {
  const options: ScopeOption[] = [];
  if (input.isCeo) {
    options.push({ kind: 'company', id: input.companyId, label: input.companyName, depth: 0 });
  }
  if (input.chart) {
    const walk = (nodes: OrgChart['roots'], depth: number) => {
      for (const node of nodes) {
        options.push({ kind: 'org_unit', id: node.id, label: node.name, depth });
        for (const team of node.teams) {
          options.push({ kind: 'team', id: team.id, label: team.name, depth: depth + 1 });
        }
        walk(node.children, depth + 1);
      }
    };
    walk(input.chart.roots, input.isCeo ? 1 : 0);
  }
  for (const e of input.employees) {
    if (e.status === 'archived') continue;
    options.push({ kind: 'ai_employee', id: e.id, label: e.name, depth: input.isCeo ? 1 : 0 });
  }
  return options;
}

/** Số đơn vị trong sơ đồ (dùng cho thông báo "chưa có đơn vị"). */
export const unitCount = (chart: OrgChart | undefined): number =>
  chart ? flattenUnits(chart.roots).length : 0;

// --- Biểu mẫu chính sách ---

export type PolicyFormState = {
  monthlyTokenLimit: string;
  monthlyCostLimit: string;
  maxConcurrentTasks: string;
  /** Model được chọn; rỗng nghĩa là không hạn chế. */
  allowedModels: string[];
  /** Phần trăm `0..100`. */
  warnPercent: string;
};

export function toFormState(policy: BudgetPolicy): PolicyFormState {
  return {
    monthlyTokenLimit: policy.monthlyTokenLimit === null ? '' : String(policy.monthlyTokenLimit),
    monthlyCostLimit: policy.monthlyCostLimit === null ? '' : String(policy.monthlyCostLimit),
    maxConcurrentTasks: policy.maxConcurrentTasks === null ? '' : String(policy.maxConcurrentTasks),
    allowedModels: policy.allowedModels ?? [],
    warnPercent: String(Math.round(policy.warnThreshold * 100)),
  };
}

export const emptyFormState = (): PolicyFormState => ({
  monthlyTokenLimit: '',
  monthlyCostLimit: '',
  maxConcurrentTasks: '',
  allowedModels: [],
  warnPercent: String(Math.round(DEFAULT_WARN_THRESHOLD * 100)),
});

export type PolicyField =
  'monthlyTokenLimit' | 'monthlyCostLimit' | 'maxConcurrentTasks' | 'warnPercent';
export type PolicyFormResult =
  | { ok: true; body: PutBudgetPolicyBody }
  | { ok: false; errors: Partial<Record<PolicyField, 'required' | 'invalid'>> };

const POSITIVE_INT = /^\d+$/;
const DECIMAL = /^\d+([.,]\d+)?$/;

/**
 * Chuyển biểu mẫu thành thân PUT. Ô trống là "không đặt giới hạn" (công ty thì bắt buộc nhập token và chi phí, vì
 * công ty luôn có giới hạn). `maxConcurrentTasks` không gửi cho phạm vi nhân viên (server trả 422 nếu có).
 */
export function parseFormState(
  state: PolicyFormState,
  scopeKind: BudgetScopeKind,
): PolicyFormResult {
  const errors: Partial<Record<PolicyField, 'required' | 'invalid'>> = {};
  const token = state.monthlyTokenLimit.trim();
  const cost = state.monthlyCostLimit.trim();
  const slots = state.maxConcurrentTasks.trim();
  const percent = state.warnPercent.trim();

  let monthlyTokenLimit: number | null = null;
  if (token === '') {
    if (scopeKind === 'company') errors.monthlyTokenLimit = 'required';
  } else if (!POSITIVE_INT.test(token)) errors.monthlyTokenLimit = 'invalid';
  else monthlyTokenLimit = Number.parseInt(token, 10);

  let monthlyCostLimit: number | null = null;
  if (cost === '') {
    if (scopeKind === 'company') errors.monthlyCostLimit = 'required';
  } else if (!DECIMAL.test(cost)) errors.monthlyCostLimit = 'invalid';
  else monthlyCostLimit = Number.parseFloat(cost.replace(',', '.'));

  let maxConcurrentTasks: number | null = null;
  if (scopeKind !== 'ai_employee' && slots !== '') {
    const n = POSITIVE_INT.test(slots) ? Number.parseInt(slots, 10) : Number.NaN;
    if (!Number.isInteger(n) || n < 1) errors.maxConcurrentTasks = 'invalid';
    else maxConcurrentTasks = n;
  }

  let warnThreshold = DEFAULT_WARN_THRESHOLD;
  if (percent === '') errors.warnPercent = 'required';
  else {
    const n = DECIMAL.test(percent) ? Number.parseFloat(percent.replace(',', '.')) : Number.NaN;
    if (Number.isNaN(n) || n < 0 || n > 100) errors.warnPercent = 'invalid';
    else warnThreshold = n / 100;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const body: PutBudgetPolicyBody = {
    monthlyTokenLimit,
    monthlyCostLimit,
    allowedModels: state.allowedModels.length > 0 ? state.allowedModels : null,
    warnThreshold,
  };
  if (scopeKind !== 'ai_employee') body.maxConcurrentTasks = maxConcurrentTasks;
  return { ok: true, body };
}

// --- Task bị chặn vì ngân sách ---

/** Task đang `blocked` vì hết ngân sách: người quản lý tăng hạn mức rồi `resume`. */
export const budgetBlockedTasks = <T extends Pick<Task, 'status' | 'blockedReason'>>(
  tasks: readonly T[],
): T[] => tasks.filter((t) => t.status === 'blocked' && t.blockedReason === 'BUDGET_EXCEEDED');
