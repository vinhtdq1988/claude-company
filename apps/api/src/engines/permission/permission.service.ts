import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  type AppPermission,
  type EmployeeEngine,
  type OrganizationEngine,
  type PermissionEngine,
  type PermissionLevel,
  type RequestContext,
  type ScopeRef,
} from '@claude-company/contracts';
import { actionPolicy } from '@claude-company/db/schema/permission';
import { evaluatePermission, type PolicyEntry } from '@claude-company/policy';
import { and, eq } from 'drizzle-orm';
import { EMPLOYEE_ENGINE, ORGANIZATION_ENGINE } from '../../platform/engine-tokens';
import { inTenant } from '../../platform/tenancy/tenant-store';
import { ApprovalService } from './approval.service';

/** Quyền ứng dụng chỉ đọc: cấp công ty mở cho mọi thành viên (dữ liệu trả về được lọc theo phạm vi). */
function isReadPermission(permission: AppPermission): boolean {
  return permission.endsWith('.read');
}

@Injectable()
export class PermissionService implements PermissionEngine {
  constructor(
    private readonly approvals: ApprovalService,
    @Inject(ORGANIZATION_ENGINE)
    private readonly organization: Pick<OrganizationEngine, 'isInScope' | 'resolveOrgUnitChain'>,
    @Inject(EMPLOYEE_ENGINE) private readonly employees: Pick<EmployeeEngine, 'get'>,
  ) {}

  /**
   * Quyết định thuần theo loại action, tool_grants và policy; không nhận nội dung prompt/task (SC-003).
   * Policy áp dụng theo cây: company → org_unit (cùng tổ tiên) → team → ai_employee.
   */
  async evaluate(
    ctx: RequestContext,
    req: { employeeId: string; actionType: string; input: unknown },
  ): Promise<{ level: PermissionLevel; reason: string }> {
    const employee = await this.employees.get(ctx, req.employeeId);
    const orgUnitChain = await this.organization.resolveOrgUnitChain(ctx, employee.homeOrgUnitId);
    const rows = await inTenant(ctx, (tx) =>
      tx
        .select()
        .from(actionPolicy)
        .where(
          and(
            eq(actionPolicy.companyId, ctx.companyId),
            eq(actionPolicy.actionType, req.actionType),
          ),
        ),
    );
    const applicable = new Set<string>([employee.id, ...employee.teamIds, ...orgUnitChain]);
    const policies: PolicyEntry[] = rows
      .filter((r) => r.scopeKind === 'company' || (r.scopeId !== null && applicable.has(r.scopeId)))
      .map((r) => ({
        actionType: r.actionType,
        level: r.level,
        scopeKind: r.scopeKind,
        scopeId: r.scopeId,
      }));

    return evaluatePermission({
      actionType: req.actionType,
      toolGrants: employee.toolGrants,
      policies,
      input: req.input,
    });
  }

  // --- Human Approval: ủy quyền cho ApprovalService (US4) ---

  createApprovalRequest: PermissionEngine['createApprovalRequest'] = (
    ctx,
    inv,
    summary,
    rationale,
  ) => this.approvals.createApprovalRequest(ctx, inv, summary, rationale);
  decideApproval: PermissionEngine['decideApproval'] = (ctx, id, d) =>
    this.approvals.decideApproval(ctx, id, d);
  getApproval: PermissionEngine['getApproval'] = (ctx, id) => this.approvals.getApproval(ctx, id);
  listApprovals: PermissionEngine['listApprovals'] = (ctx, filter) =>
    this.approvals.listApprovals(ctx, filter);
  remindPendingApprovals: PermissionEngine['remindPendingApprovals'] = (ctx, now) =>
    this.approvals.remindPendingApprovals(ctx, now);
  listCompaniesWithPendingApprovals: PermissionEngine['listCompaniesWithPendingApprovals'] = () =>
    this.approvals.listCompaniesWithPendingApprovals();

  /** Scope guard cho mọi request HTTP/WS; ngoài phạm vi → FORBIDDEN (403). */
  async authorize(ctx: RequestContext, permission: AppPermission, target: ScopeRef): Promise<void> {
    if (ctx.actor.kind !== 'human') {
      throw new DomainError('FORBIDDEN', 'Chỉ người dùng được truy cập qua API');
    }
    if (target.kind === 'company' && isReadPermission(permission)) return;
    const inScope = await this.organization.isInScope(ctx, ctx.actor.memberId, target);
    if (!inScope)
      throw new DomainError('FORBIDDEN', 'Ngoài phạm vi quản lý của bạn', { permission });
  }
}
