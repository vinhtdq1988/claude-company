import type { PermissionLevel, ScopeKind } from '@claude-company/contracts';
import { getActionDefinition, maxLevel } from './catalog';

/** Một dòng `action_policy` đã được lọc theo phạm vi của nhân viên (company → org_unit → team → employee). */
export type PolicyEntry = {
  actionType: string;
  level: PermissionLevel;
  scopeKind: ScopeKind;
  scopeId?: string | null;
};

export type EvaluateInput = {
  actionType: string;
  /** `ai_employee.tool_grants`. */
  toolGrants: readonly string[];
  policies: readonly PolicyEntry[];
  /**
   * Input đã chuẩn hóa của tool. Hàm KHÔNG đọc nội dung này để quyết định:
   * kết quả chỉ phụ thuộc loại action, grant và policy (SC-003, US4-AS4).
   * Không có tham số nào mang nội dung prompt, task hay tin nhắn.
   */
  input?: unknown;
};

export type EvaluateResult = { level: PermissionLevel; reason: string };

/**
 * Mức hiệu lực = max(floor, mọi policy áp dụng). Thuần, tất định.
 * Action ngoài danh mục hoặc ngoài `tool_grants` luôn là `restricted`.
 */
export function evaluatePermission({
  actionType,
  toolGrants,
  policies,
}: EvaluateInput): EvaluateResult {
  const def = getActionDefinition(actionType);
  if (!def) {
    return { level: 'restricted', reason: `Action "${actionType}" chưa được phân loại` };
  }
  if (!toolGrants.includes(actionType)) {
    return { level: 'restricted', reason: `Nhân viên không được cấp tool "${actionType}"` };
  }
  const applicable = policies.filter((p) => p.actionType === actionType).map((p) => p.level);
  const level = maxLevel(def.defaultLevel, def.floor, ...applicable);
  const raised = level !== maxLevel(def.defaultLevel, def.floor);
  return {
    level,
    reason: raised
      ? `Policy nâng mức của "${actionType}" lên ${level}`
      : `Mức mặc định của "${actionType}" là ${level}`,
  };
}
