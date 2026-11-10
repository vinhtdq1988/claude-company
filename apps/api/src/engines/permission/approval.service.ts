import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  DomainError,
  type ApprovalFilter,
  type ApprovalRequest,
  type CommunicationEngine,
  type EmployeeEngine,
  type OrchestrationEngine,
  type OrganizationEngine,
  type Page,
  type PermissionEngine,
  type RequestContext,
  type TaskEngine,
  type ToolInvocationRef,
} from '@claude-company/contracts';
import { withGlobal } from '@claude-company/db';
import { payloadHashOf } from '@claude-company/policy';
import { sql } from 'drizzle-orm';
import type { AppConfig } from '../../platform/config/config';
import { CONFIG } from '../../platform/config/infra.providers';
import {
  COMMUNICATION_ENGINE,
  EMPLOYEE_ENGINE,
  ORCHESTRATION_ENGINE,
  ORGANIZATION_ENGINE,
  TASK_ENGINE,
} from '../../platform/engine-tokens';
import { EventPublisher } from '../../platform/events/event-publisher';
import { inTenant } from '../../platform/tenancy/tenant-store';
import { pickApprover } from './approver';
import { ApprovalRepository, toApproval, type ApprovalRow } from './approval.repository';

const MAX_LIST = 200;

/**
 * Human Approval (US4, FR-025/026): tạo yêu cầu đủ ngữ cảnh, ghi nhận quyết định có lý do và ràng buộc payload bằng
 * hash, nhắc người duyệt. Không bao giờ tự duyệt và không thực thi hành động: việc thực thi thuộc job
 * `action.execute-approved` của worker sau khi `approval.decided` được phát.
 */
@Injectable()
export class ApprovalService implements Pick<
  PermissionEngine,
  | 'createApprovalRequest'
  | 'decideApproval'
  | 'getApproval'
  | 'listApprovals'
  | 'remindPendingApprovals'
  | 'listCompaniesWithPendingApprovals'
> {
  private readonly logger = new Logger(ApprovalService.name);

  constructor(
    private readonly repo: ApprovalRepository,
    private readonly events: EventPublisher,
    private readonly moduleRef: ModuleRef,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private get orchestration(): OrchestrationEngine {
    return this.moduleRef.get<OrchestrationEngine>(ORCHESTRATION_ENGINE, { strict: false });
  }
  private get tasks(): TaskEngine {
    return this.moduleRef.get<TaskEngine>(TASK_ENGINE, { strict: false });
  }
  private get employees(): EmployeeEngine {
    return this.moduleRef.get<EmployeeEngine>(EMPLOYEE_ENGINE, { strict: false });
  }
  private get organization(): OrganizationEngine {
    return this.moduleRef.get<OrganizationEngine>(ORGANIZATION_ENGINE, { strict: false });
  }
  private get communication(): CommunicationEngine {
    return this.moduleRef.get<CommunicationEngine>(COMMUNICATION_ENGINE, { strict: false });
  }

  // --- tạo yêu cầu ---

  async createApprovalRequest(
    ctx: RequestContext,
    inv: ToolInvocationRef,
    summary: string,
    rationale: string,
  ): Promise<ApprovalRequest> {
    if (ctx.actor.kind !== 'ai') {
      throw new DomainError('FORBIDDEN', 'Chỉ run của AI Employee mới tạo được yêu cầu phê duyệt');
    }
    const actor = ctx.actor;
    // Không tin dữ liệu người gọi truyền vào: đọc lại bản ghi ledger rồi mới lấy payload từ đó.
    const trusted = await this.orchestration.findToolInvocationByKey(ctx, inv.idempotencyKey);
    if (
      !trusted ||
      trusted.id !== inv.id ||
      trusted.runId !== actor.runId ||
      trusted.permissionLevel !== 'human_approval'
    ) {
      throw new DomainError(
        'FORBIDDEN',
        'Chỉ tạo yêu cầu phê duyệt cho hành động Human Approval trong chính run này',
      );
    }
    const existing = await inTenant(ctx, (tx) =>
      this.repo.findByInvocation(tx, ctx.companyId, trusted.id),
    );
    if (existing) return toApproval(existing);
    if (trusted.status !== 'pending_approval') {
      throw new DomainError(
        'APPROVAL_NOT_PENDING',
        'Hành động này không còn ở trạng thái chờ duyệt',
      );
    }

    const task = await this.tasks.get(ctx, trusted.taskId);
    const members = await this.employees.listHumanMembers(ctx);
    const approverMemberId = pickApprover(task.createdByMemberId, members);
    const payload = trusted.input;
    const created = await inTenant(ctx, async (tx) => {
      const row = await this.repo.insert(tx, {
        companyId: ctx.companyId,
        toolInvocationId: trusted.id,
        agentRunId: trusted.runId,
        taskId: trusted.taskId,
        aiEmployeeId: actor.employeeId,
        actionType: trusted.actionType,
        summary,
        rationale,
        payload,
        payloadHash: payloadHashOf(payload),
        approverMemberId,
      });
      await this.events.publish(tx, ctx, {
        type: 'approval.requested',
        aggregateKind: 'approval_request',
        aggregateId: row.id,
        payload: {
          approvalRequestId: row.id,
          taskId: row.taskId,
          employeeId: row.aiEmployeeId,
          actionType: row.actionType,
          approverMemberId,
        },
      });
      return row;
    });

    await this.notifyApprover(ctx, created, task.title, false);
    return toApproval(created);
  }

  /** Thông báo lỗi không làm hỏng yêu cầu: sweeper nhắc lại sau (FR-041). */
  private async notifyApprover(
    ctx: RequestContext,
    row: ApprovalRow,
    taskTitle: string,
    reminder: boolean,
  ): Promise<void> {
    try {
      await this.communication.notifyRouted(ctx, {
        type: 'approval_needed',
        title: `${reminder ? 'Nhắc: ' : ''}Cần bạn phê duyệt — ${row.summary}`,
        body: `Task "${taskTitle}". ${row.rationale}`.slice(0, 1_000),
        taskId: row.taskId,
        approvalRequestId: row.id,
        approverMemberId: row.approverMemberId ?? undefined,
      });
    } catch (error) {
      this.logger.warn(`Không gửi được thông báo phê duyệt ${row.id}: ${String(error)}`);
    }
  }

  // --- quyết định ---

  async decideApproval(
    ctx: RequestContext,
    id: string,
    d: { decision: 'approve' | 'reject'; reason: string; payloadHash: string },
  ): Promise<ApprovalRequest> {
    if (ctx.actor.kind !== 'human') {
      throw new DomainError('FORBIDDEN', 'Chỉ người thật được quyết định yêu cầu phê duyệt');
    }
    const reason = d.reason?.trim();
    if (!reason) {
      throw new DomainError('VALIDATION_FAILED', 'Lý do là bắt buộc với mọi quyết định', {
        field: 'reason',
      });
    }
    const memberId = ctx.actor.memberId;
    const decided = await inTenant(ctx, async (tx) => {
      const row = await this.repo.findById(tx, ctx.companyId, id, { forUpdate: true });
      if (!row) throw new DomainError('NOT_FOUND', 'Không tìm thấy yêu cầu phê duyệt');
      // Người ngoài phạm vi quản lý của nhân viên không được quyết định (FR-028).
      const inScope = await this.organization.isInScope(ctx, memberId, {
        kind: 'ai_employee',
        id: row.aiEmployeeId,
      });
      if (!inScope) throw new DomainError('FORBIDDEN', 'Ngoài phạm vi quản lý của bạn');
      if (row.status !== 'pending') {
        throw new DomainError('APPROVAL_NOT_PENDING', 'Yêu cầu này đã có quyết định', {
          status: row.status,
        });
      }
      // Hash gửi lên phải khớp bản người duyệt đã xem, và payload lưu trữ phải còn nguyên vẹn.
      if (d.payloadHash !== row.payloadHash || payloadHashOf(row.payload) !== row.payloadHash) {
        throw new DomainError(
          'APPROVAL_PAYLOAD_CHANGED',
          'Nội dung hành động đã thay đổi, hãy tải lại và xem lại',
        );
      }
      const updated = await this.repo.decidePending(tx, ctx.companyId, id, {
        status: d.decision === 'approve' ? 'approved' : 'rejected',
        decidedBy: memberId,
        decisionReason: reason,
      });
      if (!updated) {
        throw new DomainError('APPROVAL_NOT_PENDING', 'Yêu cầu này đã có quyết định');
      }
      await this.events.publish(tx, ctx, {
        type: 'approval.decided',
        aggregateKind: 'approval_request',
        aggregateId: id,
        payload: {
          approvalRequestId: id,
          decision: d.decision,
          taskId: updated.taskId,
          employeeId: updated.aiEmployeeId,
          approverMemberId: updated.approverMemberId,
          decidedBy: memberId,
        },
      });
      return updated;
    });
    return toApproval(decided);
  }

  // --- truy vấn ---

  async getApproval(ctx: RequestContext, id: string): Promise<ApprovalRequest> {
    const row = await inTenant(ctx, (tx) => this.repo.findById(tx, ctx.companyId, id));
    if (!row) throw new DomainError('NOT_FOUND', 'Không tìm thấy yêu cầu phê duyệt');
    return (await this.enrich(ctx, [row]))[0] as ApprovalRequest;
  }

  async listApprovals(ctx: RequestContext, filter: ApprovalFilter): Promise<Page<ApprovalRequest>> {
    const limit = Math.min(filter.limit ?? 50, MAX_LIST);
    const rows = await inTenant(ctx, (tx) =>
      this.repo.list(tx, ctx.companyId, {
        status: filter.status,
        taskId: filter.taskId,
        employeeIds: filter.employeeIds,
        limit,
      }),
    );
    return { items: await this.enrich(ctx, rows), nextCursor: null };
  }

  /** Gắn tên task và nhân viên để hộp phê duyệt đọc được; thiếu thì để trống thay vì làm hỏng danh sách. */
  private async enrich(ctx: RequestContext, rows: ApprovalRow[]): Promise<ApprovalRequest[]> {
    const taskTitles = new Map<string, string>();
    for (const taskId of new Set(rows.map((r) => r.taskId))) {
      const task = await this.tasks.get(ctx, taskId).catch(() => undefined);
      if (task) taskTitles.set(taskId, task.title);
    }
    const names = new Map<string, string>();
    for (const employeeId of new Set(rows.map((r) => r.aiEmployeeId))) {
      const employee = await this.employees.get(ctx, employeeId).catch(() => undefined);
      if (employee) names.set(employeeId, employee.name);
    }
    return rows.map((row) => ({
      ...toApproval(row),
      taskTitle: taskTitles.get(row.taskId),
      employeeName: names.get(row.aiEmployeeId),
    }));
  }

  // --- nhắc, hủy, chuyển người duyệt ---

  async remindPendingApprovals(ctx: RequestContext, now: Date): Promise<number> {
    const due = await inTenant(ctx, (tx) =>
      this.repo.listDueForReminder(tx, ctx.companyId, {
        firstBefore: new Date(now.getTime() - this.config.APPROVAL_REMINDER_FIRST_MS),
        repeatBefore: new Date(now.getTime() - this.config.APPROVAL_REMINDER_REPEAT_MS),
      }),
    );
    let reminded = 0;
    for (const row of due) {
      await inTenant(ctx, (tx) => this.repo.markReminded(tx, ctx.companyId, row.id, now));
      const task = await this.tasks.get(ctx, row.taskId).catch(() => undefined);
      await this.notifyApprover(ctx, row, task?.title ?? '', true);
      reminded += 1;
    }
    return reminded;
  }

  async listCompaniesWithPendingApprovals(): Promise<string[]> {
    const result = await withGlobal((tx) =>
      tx.execute<{ company_id: string }>(
        sql`select list_companies_with_pending_approvals() as company_id`,
      ),
    );
    return result.rows.map((r) => r.company_id);
  }

  /**
   * Task rời `in_progress` (hủy, chặn…): run chờ duyệt bị hủy nên yêu cầu đang chờ chuyển sang `cancelled`, và
   * bản ghi ledger thành `failed` để lần đề xuất lại sau `resume` không bị chặn bởi bản ghi cũ (action-policy.md).
   */
  async cancelPendingForTask(ctx: RequestContext, taskId: string, reason: string): Promise<number> {
    const cancelled = await inTenant(ctx, async (tx) => {
      const pending = await this.repo.listPendingOfTask(tx, ctx.companyId, taskId);
      const done: ApprovalRow[] = [];
      for (const row of pending) {
        const updated = await this.repo.decidePending(tx, ctx.companyId, row.id, {
          status: 'cancelled',
          decidedBy: null,
          decisionReason: reason,
        });
        if (!updated) continue;
        await this.events.publish(tx, ctx, {
          type: 'approval.cancelled',
          aggregateKind: 'approval_request',
          aggregateId: row.id,
          payload: { approvalRequestId: row.id, taskId, employeeId: row.aiEmployeeId },
        });
        done.push(updated);
      }
      return done;
    });
    for (const row of cancelled) {
      await this.orchestration.updateToolInvocation(ctx, row.toolInvocationId, {
        status: 'failed',
        result: { cancelled: true, message: reason },
      });
    }
    return cancelled.length;
  }

  /** Người duyệt bị vô hiệu: mọi yêu cầu đang chờ của họ chuyển cho CEO (FR-026). */
  async reassignFromDeactivated(ctx: RequestContext, memberId: string): Promise<number> {
    const rows = await inTenant(ctx, (tx) =>
      this.repo.listPendingOfApprover(tx, ctx.companyId, memberId),
    );
    if (rows.length === 0) return 0;
    const members = await this.employees.listHumanMembers(ctx);
    const ceoId = pickApprover(
      null,
      members.filter((m) => m.id !== memberId),
    );
    for (const row of rows) {
      await inTenant(ctx, async (tx) => {
        await this.repo.reassign(tx, ctx.companyId, row.id, ceoId);
        await this.events.publish(tx, ctx, {
          type: 'approval.reassigned',
          aggregateKind: 'approval_request',
          aggregateId: row.id,
          payload: { approvalRequestId: row.id, from: memberId, to: ceoId },
        });
      });
      const task = await this.tasks.get(ctx, row.taskId).catch(() => undefined);
      await this.notifyApprover(ctx, { ...row, approverMemberId: ceoId }, task?.title ?? '', false);
    }
    return rows.length;
  }
}
