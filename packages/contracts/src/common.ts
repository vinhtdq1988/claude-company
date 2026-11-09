import { z } from 'zod';

export const uuidSchema = z.string().uuid();

/** Người thực hiện thao tác: người thật, AI Employee (kèm run) hoặc hệ thống (sweeper, bootstrap). */
export type Actor =
  | { kind: 'human'; memberId: string }
  | { kind: 'ai'; employeeId: string; runId: string }
  | { kind: 'system' };

/** Ngữ cảnh của mọi thao tác engine (trừ createCompany): áp tenant + scope. */
export type RequestContext = {
  companyId: string;
  actor: Actor;
  traceId: string;
};

/** Ngữ cảnh của createCompany: chưa có company nên chỉ có người dùng. */
export type BootstrapContext = {
  userId: string;
  traceId: string;
};

export const scopeKindSchema = z.enum(['company', 'org_unit', 'team', 'ai_employee']);
export type ScopeKind = z.infer<typeof scopeKindSchema>;

/** Tham chiếu tới một đối tượng để kiểm tra phạm vi quản lý. `id` bỏ trống khi kind = company. */
export type ScopeRef = { kind: ScopeKind; id?: string };

export const memberRefSchema = z.object({
  kind: z.enum(['ai', 'human']),
  id: uuidSchema,
});
export type MemberRef = z.infer<typeof memberRefSchema>;

/**
 * Phạm vi quản lý đã mở rộng của một human_member (đơn vị con, team, nhân viên).
 * CEO có `companyWide = true`.
 */
export type ManagedScope = {
  companyWide: boolean;
  orgUnitIds: string[];
  teamIds: string[];
  employeeIds: string[];
};

export type Page<T> = { items: T[]; nextCursor: string | null };

export const pageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

export const humanRoleSchema = z.enum(['ceo', 'manager']);
export type HumanRole = z.infer<typeof humanRoleSchema>;

export type HumanMember = {
  id: string;
  companyId: string;
  userId: string;
  role: HumanRole;
  title: string | null;
  displayName: string;
  disabledAt: string | null;
};

export type Membership = {
  companyId: string;
  memberId: string;
  role: HumanRole;
};

/** Quyền ứng dụng cấp trên ScopeGuard / PermissionEngine.authorize. */
export type AppPermission =
  | 'org.read'
  | 'org.manage'
  | 'employee.read'
  | 'employee.manage'
  | 'member.manage'
  | 'workspace.manage'
  | 'task.read'
  | 'task.manage'
  | 'task.decide'
  | 'approval.decide'
  | 'budget.manage'
  | 'run.read'
  | 'usage.read';
