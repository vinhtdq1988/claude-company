import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  CEO_ASSISTANT_TEMPLATE_KEY,
  createTaskSchema,
  DomainError,
  taskDraftPatchSchema,
  type Artifact,
  type ArtifactInput,
  type DecompositionPlan,
  type EmployeeEngine,
  type EvidenceInput,
  type ManagedScope,
  type OrgChartNode,
  type OrganizationEngine,
  type Page,
  type RequestContext,
  type Task,
  type TaskAction,
  type TaskDecisionInput,
  type TaskDetail,
  type TaskDraftPatch,
  type TaskEngine,
  type TaskFilter,
  type TaskInput,
  type TaskStats,
  type TaskStatus,
} from '@claude-company/contracts';
import { newId, withGlobal, type Tx } from '@claude-company/db';
import { sql } from 'drizzle-orm';
import type { AppConfig } from '../../platform/config/config';
import { CONFIG } from '../../platform/config/infra.providers';
import { EMPLOYEE_ENGINE, ORGANIZATION_ENGINE } from '../../platform/engine-tokens';
import { EventPublisher } from '../../platform/events/event-publisher';
import { StorageService } from '../../platform/storage/storage.service';
import { inTenant } from '../../platform/tenancy/tenant-store';
import { DecompositionService } from './decomposition.service';
import { checkEvidence, type CompletenessReport } from './evidence-completeness';
import {
  toArtifact,
  toEvidence,
  toReview,
  toTask,
  TaskRepository,
  type AssigneeSets,
  type TaskRow,
} from './task.repository';
import { computeStats } from './task-stats';
import { TaskTransitions } from './task-transitions';

/** Action người dùng/hệ thống được gọi qua `transition`; `pass`/`approve`/`rework` chỉ đi qua `recordDecision`. */
const PUBLIC_ACTIONS: readonly TaskAction[] = [
  'assign',
  'start',
  'submit',
  'block',
  'resume',
  'cancel',
];

/** Mã lý do chặn được hệ thống đặt: bắt buộc khi `block`. */
const MAX_REWORK_REACHED = 'MAX_REWORK_REACHED';
const HUMAN_REJECTED = 'HUMAN_REJECTED';

/**
 * Task Engine: vòng đời FR-020a, artifact, bằng chứng và quyết định review. Chỉ truy cập bảng của mình;
 * nhân viên, đơn vị và phạm vi quản lý lấy qua interface của engine khác (lấy muộn qua ModuleRef vì
 * Employee/Organization Engine cũng phụ thuộc ngược vào TaskEngine).
 */
@Injectable()
export class TaskService implements TaskEngine {
  constructor(
    private readonly repo: TaskRepository,
    private readonly events: EventPublisher,
    private readonly decomposition: DecompositionService,
    private readonly transitions: TaskTransitions,
    private readonly storage: StorageService,
    private readonly moduleRef: ModuleRef,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private get employees(): EmployeeEngine {
    return this.moduleRef.get<EmployeeEngine>(EMPLOYEE_ENGINE, { strict: false });
  }

  private get organization(): OrganizationEngine {
    return this.moduleRef.get<OrganizationEngine>(ORGANIZATION_ENGINE, { strict: false });
  }

  // --- tạo ---

  async create(ctx: RequestContext, input: TaskInput): Promise<Task> {
    const parsed = createTaskSchema.safeParse(input);
    if (!parsed.success) {
      throw new DomainError('TASK_FIELDS_REQUIRED', 'Thiếu hoặc sai trường bắt buộc của task', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const body = parsed.data;
    const createdBy =
      input.createdByMemberId ?? (ctx.actor.kind === 'human' ? ctx.actor.memberId : undefined);
    if (!createdBy) {
      throw new DomainError('TASK_FIELDS_REQUIRED', 'Task phải có người giao là người thật');
    }

    const inScope = await this.organization.isInScope(ctx, createdBy, {
      kind: body.assignee.kind,
      id: body.assignee.id,
    });
    if (!inScope) {
      throw new DomainError('ASSIGNEE_OUT_OF_SCOPE', 'Người nhận việc nằm ngoài phạm vi quản lý', {
        assignee: body.assignee,
      });
    }
    await this.assertAssigneeExists(ctx, body.assignee);

    const created = await inTenant(ctx, async (tx) => {
      const dependsOn = [...new Set(body.dependsOn ?? [])];
      if (dependsOn.length > 0) {
        const found = await this.repo.findMany(tx, ctx.companyId, dependsOn);
        if (found.length !== dependsOn.length) {
          throw new DomainError('NOT_FOUND', 'Task phụ thuộc không tồn tại');
        }
      }
      const id = newId();
      const row = await this.repo.insert(tx, {
        id,
        companyId: ctx.companyId,
        parentTaskId: input.parentTaskId ?? null,
        title: body.title,
        objective: body.objective,
        createdByMemberId: createdBy,
        // Thao tác của CEO AI Assistant thay mặt CEO: người giao vẫn là người thật, trợ lý được ghi nhận riêng (FR-050).
        assignedByAiEmployeeId:
          input.assignedByAiEmployeeId ??
          (ctx.actor.kind === 'human' ? (ctx.actor.via?.employeeId ?? null) : null),
        assigneeKind: body.assignee.kind,
        assigneeId: body.assignee.id,
        deadline: new Date(body.deadline),
        priority: body.priority,
        acceptanceCriteria: body.acceptanceCriteria.map((text, i) => ({ id: `c${i + 1}`, text })),
        expectedOutput: body.expectedOutput,
        status: 'draft',
        proposalStatus: input.proposalStatus ?? null,
        tokenCap: body.tokenCap ?? null,
        costCap: body.costCap === undefined ? null : String(body.costCap),
      });
      await this.repo.insertDependencies(
        tx,
        ctx.companyId,
        dependsOn.map((dependsOnTaskId) => ({ taskId: id, dependsOnTaskId })),
      );
      await this.events.publish(tx, ctx, {
        type: 'task.created',
        aggregateKind: 'task',
        aggregateId: id,
        payload: this.transitions.snapshot(row, { status: row.status }),
      });
      return row;
    });
    return toTask(created);
  }

  // --- sửa task nháp ---

  async updateDraft(
    ctx: RequestContext,
    taskId: string,
    patch: TaskDraftPatch | Record<string, never>,
    meta?: { proposalStatus: 'ready' | 'failed' },
  ): Promise<Task> {
    const byUser = ctx.actor.kind === 'human';
    if (meta && byUser) {
      throw new DomainError('FORBIDDEN', 'Chỉ hệ thống được đặt trạng thái đề xuất');
    }
    let fields: TaskDraftPatch | Record<string, never> = {};
    // Kết quả `failed` không mang trường nào; mọi trường hợp khác phải qua cùng bộ kiểm tra như lúc tạo task.
    if (!(meta?.proposalStatus === 'failed' && Object.keys(patch).length === 0)) {
      const parsed = taskDraftPatchSchema.safeParse(patch);
      if (!parsed.success) {
        throw new DomainError('TASK_FIELDS_REQUIRED', 'Trường cần sửa thiếu hoặc không hợp lệ', {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      fields = parsed.data;
    }
    const data = fields as TaskDraftPatch;
    const row = await inTenant(ctx, async (tx) => {
      const current = await this.requireTask(tx, ctx, taskId, true);
      if (current.status !== 'draft') {
        throw new DomainError('TASK_NOT_DRAFT', 'Chỉ sửa được task ở trạng thái nháp', {
          taskId,
          status: current.status,
        });
      }
      if (byUser && current.proposalStatus === 'pending') {
        throw new DomainError('PROPOSAL_PENDING', 'CEO AI Assistant đang soạn đề xuất cho task này', {
          taskId,
        });
      }
      if (meta && current.proposalStatus !== 'pending') {
        // Đề xuất đến muộn hoặc trùng (CEO đã sửa tay/chạy lại): không ghi đè.
        throw new DomainError('CONFLICT', 'Task không còn chờ đề xuất', { taskId });
      }
      const updated = await this.repo.update(tx, ctx.companyId, taskId, {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.objective !== undefined ? { objective: data.objective } : {}),
        ...(data.deadline !== undefined ? { deadline: new Date(data.deadline) } : {}),
        ...(data.priority !== undefined ? { priority: data.priority } : {}),
        ...(data.acceptanceCriteria !== undefined
          ? { acceptanceCriteria: data.acceptanceCriteria.map((text, i) => ({ id: `c${i + 1}`, text })) }
          : {}),
        ...(data.expectedOutput !== undefined ? { expectedOutput: data.expectedOutput } : {}),
        ...(data.tokenCap !== undefined ? { tokenCap: data.tokenCap } : {}),
        ...(data.costCap !== undefined
          ? { costCap: data.costCap === null ? null : String(data.costCap) }
          : {}),
        ...(meta ? { proposalStatus: meta.proposalStatus } : {}),
      });
      if (meta) {
        await this.events.publish(tx, ctx, {
          type: 'task.proposal_applied',
          aggregateKind: 'task',
          aggregateId: taskId,
          payload: { taskId, status: meta.proposalStatus },
        });
      }
      return updated;
    });
    return this.withAssistantLabel(ctx, toTask(row));
  }

  // --- chuyển trạng thái ---

  async transition(
    ctx: RequestContext,
    taskId: string,
    action: TaskAction,
    meta: { reason?: string; blockedReason?: string; resumeTo?: TaskStatus } = {},
  ): Promise<Task> {
    if (!PUBLIC_ACTIONS.includes(action)) {
      throw new DomainError(
        'TASK_INVALID_TRANSITION',
        `Hành động "${action}" chỉ đi qua quyết định review`,
        { action },
      );
    }
    if (action === 'block' && !meta.blockedReason) {
      throw new DomainError('VALIDATION_FAILED', 'Chặn task phải có blockedReason', {
        field: 'blockedReason',
      });
    }
    const row = await inTenant(ctx, async (tx) => {
      const current = await this.requireTask(tx, ctx, taskId, true);
      const extra: Partial<TaskRow> = {};
      // Giá trị tạm của task yêu cầu gửi trợ lý chưa được thay bằng đề xuất: không giao nhầm (FR-047).
      if (action === 'assign' && current.proposalStatus === 'pending') {
        throw new DomainError('PROPOSAL_PENDING', 'CEO AI Assistant đang soạn đề xuất cho task này', {
          taskId,
        });
      }
      if (action === 'resume') {
        if (current.blockedReason === 'SUBTASK_CANCELLED') {
          throw new DomainError(
            'SUBTASK_CANCELLED',
            'Task con đã bị hủy: chỉ có thể hủy task cha',
            { taskId },
          );
        }
        await this.assertAssigneeNotSuspended(ctx, current);
        // Mọi `resume` lúc đã đạt ngưỡng rework đặt lại mốc, tổng `rework_count` không giảm (D1).
        if (current.reworkCount - current.reworkBaseline >= this.config.MAX_REWORK) {
          extra.reworkBaseline = current.reworkCount;
        }
      }
      return this.transitions.move(tx, ctx, current, action, {
        blockedReason: meta.blockedReason,
        resumeTo: meta.resumeTo,
        extra,
      });
    });
    return toTask(row);
  }

  // --- artifact và bằng chứng ---

  async attachArtifact(
    ctx: RequestContext,
    taskId: string,
    artifact: ArtifactInput,
  ): Promise<Artifact> {
    const row = await inTenant(ctx, async (tx) => {
      const current = await this.requireTask(tx, ctx, taskId, true);
      if (current.status !== 'in_progress') {
        throw new DomainError(
          'TASK_INVALID_TRANSITION',
          'Chỉ nộp artifact khi task đang ở trạng thái in_progress',
          { from: current.status },
        );
      }
      const inserted = await this.repo.insertArtifact(tx, {
        companyId: ctx.companyId,
        taskId,
        agentRunId: artifact.agentRunId ?? (ctx.actor.kind === 'ai' ? ctx.actor.runId : null),
        createdByEmployeeId: ctx.actor.kind === 'ai' ? ctx.actor.employeeId : null,
        kind: artifact.kind,
        title: artifact.title,
        storageKey: artifact.storageKey,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        checksumSha256: artifact.checksumSha256,
        round: current.reworkCount,
      });
      await this.events.publish(tx, ctx, {
        type: 'task.artifact_attached',
        aggregateKind: 'task',
        aggregateId: taskId,
        payload: { taskId, artifactId: inserted.id, kind: inserted.kind },
      });
      return inserted;
    });
    return toArtifact(row);
  }

  async recordEvidence(
    ctx: RequestContext,
    taskId: string,
    evidence: EvidenceInput[],
  ): Promise<void> {
    if (ctx.actor.kind === 'system') {
      throw new DomainError('FORBIDDEN', 'Bằng chứng phải do người review ghi');
    }
    const reviewer =
      ctx.actor.kind === 'ai'
        ? ({ kind: 'ai', id: ctx.actor.employeeId } as const)
        : ({ kind: 'human', id: ctx.actor.memberId } as const);

    await inTenant(ctx, async (tx) => {
      const current = await this.requireTask(tx, ctx, taskId, true);
      if (!['in_review', 'awaiting_human_approval'].includes(current.status)) {
        throw new DomainError('TASK_INVALID_TRANSITION', 'Chỉ ghi bằng chứng khi task đang review', {
          from: current.status,
        });
      }
      const criterionIds = new Set(current.acceptanceCriteria.map((c) => c.id));
      const unknown = evidence.filter((e) => !criterionIds.has(e.criterionId));
      if (unknown.length > 0) {
        throw new DomainError('VALIDATION_FAILED', 'Bằng chứng trỏ tới criterion không tồn tại', {
          criterionIds: unknown.map((e) => e.criterionId),
        });
      }
      if (reviewer.kind === 'ai') await this.assertIndependentReviewer(tx, ctx, current, reviewer.id);
      await this.repo.insertEvidence(
        tx,
        evidence.map((e) => ({
          companyId: ctx.companyId,
          taskId,
          criterionId: e.criterionId,
          artifactId: e.artifactId ?? null,
          reviewerKind: reviewer.kind,
          reviewerId: reviewer.id,
          verdict: e.verdict,
          explanation: e.explanation,
          round: current.reworkCount,
        })),
      );
      await this.events.publish(tx, ctx, {
        type: 'task.evidence_recorded',
        aggregateKind: 'task',
        aggregateId: taskId,
        payload: { taskId, count: evidence.length, reviewerKind: reviewer.kind },
      });
    });
  }

  async readArtifact(
    ctx: RequestContext,
    artifactId: string,
    maxBytes: number,
  ): Promise<{ content: Buffer; truncated: boolean }> {
    const row = await inTenant(ctx, (tx) => this.repo.findArtifact(tx, ctx.companyId, artifactId));
    if (!row) throw new DomainError('NOT_FOUND', 'Không tìm thấy artifact');
    const full = await this.storage.getBuffer(row.storageKey);
    return { content: full.subarray(0, maxBytes), truncated: full.length > maxBytes };
  }

  // --- quyết định review ---

  async recordDecision(
    ctx: RequestContext,
    taskId: string,
    d: TaskDecisionInput,
  ): Promise<Task> {
    const reason = d.reason?.trim();
    if (!reason) {
      throw new DomainError('VALIDATION_FAILED', 'Lý do là bắt buộc với mọi quyết định', {
        field: 'reason',
      });
    }
    const row = await inTenant(ctx, async (tx) => {
      const current = await this.requireTask(tx, ctx, taskId, true);
      const reviewer = this.resolveReviewer(ctx, current, d.decision);
      if (reviewer.kind === 'ai') await this.assertIndependentReviewer(tx, ctx, current, reviewer.id);

      const record = (decision: TaskDecisionInput['decision']) =>
        this.repo.insertReview(tx, {
          companyId: ctx.companyId,
          taskId,
          stage: reviewer.kind === 'ai' ? 'ai_review' : 'human_approval',
          reviewerKind: reviewer.kind,
          reviewerId: reviewer.id,
          decision,
          reason,
        });

      switch (d.decision) {
        case 'approve':
        case 'pass': {
          const report = await this.completeness(tx, ctx, current);
          if (!report.complete) {
            throw new DomainError(
              'EVIDENCE_INCOMPLETE',
              'Chưa đủ bằng chứng đối chiếu từng acceptance criterion',
              { missing: report.missing, notMet: report.notMet, hasArtifact: report.hasArtifact },
            );
          }
          await record(d.decision);
          return this.transitions.move(tx, ctx, current, d.decision === 'approve' ? 'approve' : 'pass', {
            decision: d.decision,
            extra: d.decision === 'approve' ? { completedAt: new Date() } : {},
          });
        }
        case 'reject': {
          // D1: ghi review_record rồi đi cạnh `block`; không tự chạy lại, không escalate dù chạm ngưỡng.
          await record('reject');
          return this.transitions.move(tx, ctx, current, 'block', {
            decision: 'reject',
            blockedReason: HUMAN_REJECTED,
            resumeTo: 'in_progress',
            extra: { reworkCount: current.reworkCount + 1 },
          });
        }
        case 'rework': {
          await record('rework');
          const reworkCount = current.reworkCount + 1;
          if (reworkCount - current.reworkBaseline >= this.config.MAX_REWORK) {
            return this.transitions.move(tx, ctx, current, 'block', {
              decision: 'rework',
              blockedReason: MAX_REWORK_REACHED,
              resumeTo: 'in_progress',
              extra: { reworkCount },
            });
          }
          return this.transitions.move(tx, ctx, current, 'rework', {
            decision: 'rework',
            extra: { reworkCount },
          });
        }
      }
    });
    return toTask(row);
  }

  async applyDecomposition(
    ctx: RequestContext,
    parentTaskId: string,
    plan: DecompositionPlan,
  ): Promise<Task[]> {
    return this.decomposition.apply(ctx, parentTaskId, plan);
  }

  // --- truy vấn ---

  async get(ctx: RequestContext, id: string): Promise<TaskDetail> {
    return inTenant(ctx, async (tx) => {
      const row = await this.requireTask(tx, ctx, id, false);
      // Tuần tự: các truy vấn dùng chung một client của transaction (pg không hỗ trợ truy vấn đồng thời).
      const children = await this.repo.listChildren(tx, ctx.companyId, id);
      const dependsOn = await this.repo.listDependencyIds(tx, ctx.companyId, id);
      const artifacts = await this.repo.listArtifacts(tx, ctx.companyId, id);
      const evidence = await this.repo.listEvidence(tx, ctx.companyId, id);
      const reviews = await this.repo.listReviews(tx, ctx.companyId, id);
      return {
        ...(await this.withAssistantLabel(ctx, toTask(row))),
        subtasks: children.map(toTask),
        dependsOn,
        decompositionPlan: row.decompositionPlan ?? null,
        decomposedByEmployeeId: row.decomposedByEmployeeId,
        artifacts: artifacts.map(toArtifact),
        evidence: evidence.map(toEvidence),
        reviews: reviews.map(toReview),
      };
    });
  }

  async list(ctx: RequestContext, filter: TaskFilter): Promise<Page<Task>> {
    const assignees = await this.resolveAssignees(ctx, filter);
    const { rows, nextCursor } = await inTenant(ctx, (tx) =>
      this.repo.list(tx, ctx.companyId, filter, assignees),
    );
    const items = rows.map(toTask);
    return {
      items: filter.withAssignerLabel ? await this.withAssistantLabels(ctx, items) : items,
      nextCursor,
    };
  }

  async getStats(
    ctx: RequestContext,
    filter: { employeeId?: string; orgUnitId?: string; scope?: ManagedScope },
  ): Promise<TaskStats> {
    let assignees: AssigneeSets | undefined;
    if (filter.employeeId) {
      assignees = { employeeIds: [filter.employeeId], teamIds: [], orgUnitIds: [] };
    } else {
      // Dashboard của Manager: giao phạm vi quản lý với bộ lọc đơn vị, giống `list`.
      assignees = await this.resolveAssignees(ctx, {
        scope: filter.scope,
        orgUnitId: filter.orgUnitId,
      });
    }
    const rows = await inTenant(ctx, (tx) =>
      this.repo.statsRows(tx, ctx.companyId, {
        assignees,
        // Dashboard chỉ đếm task gốc; `performance` của nhân viên đếm cả task con (data-model).
        rootOnly: filter.employeeId === undefined,
      }),
    );
    return computeStats(rows);
  }

  async markOverdue(ctx: RequestContext, now: Date): Promise<Task[]> {
    const rows = await inTenant(ctx, async (tx) => {
      const updated = await this.repo.markOverdue(tx, ctx.companyId, now);
      for (const row of updated) {
        await this.events.publish(tx, ctx, {
          type: 'task.overdue',
          aggregateKind: 'task',
          aggregateId: row.id,
          payload: this.transitions.snapshot(row, { status: row.status }),
        });
      }
      return updated;
    });
    return rows.map(toTask);
  }

  async listCompaniesWithOpenTasks(): Promise<string[]> {
    const result = await withGlobal((tx) =>
      tx.execute<{ company_id: string }>(
        sql`select list_companies_with_open_tasks() as company_id`,
      ),
    );
    return result.rows.map((r) => r.company_id);
  }

  // --- nội bộ ---

  /**
   * Tên CEO AI Assistant đã tạo task thay người giao (`assignedByEmployee`). Task do AI Manager phân rã cũng có
   * `assigned_by_ai_employee_id` nhưng không phải việc của trợ lý nên không gắn nhãn.
   */
  private async assistantLabels(
    ctx: RequestContext,
    ids: readonly string[],
  ): Promise<Map<string, { id: string; name: string }>> {
    const labels = new Map<string, { id: string; name: string }>();
    for (const id of new Set(ids)) {
      const employee = await this.employees.get(ctx, id).catch(() => null);
      if (employee?.roleTemplateKey === CEO_ASSISTANT_TEMPLATE_KEY) {
        labels.set(id, { id, name: employee.name });
      }
    }
    return labels;
  }

  private async withAssistantLabel(ctx: RequestContext, t: Task): Promise<Task> {
    const [labelled] = await this.withAssistantLabels(ctx, [t]);
    return labelled ?? t;
  }

  private async withAssistantLabels(ctx: RequestContext, tasks: Task[]): Promise<Task[]> {
    const ids = tasks.flatMap((t) => (t.assignedByAiEmployeeId ? [t.assignedByAiEmployeeId] : []));
    if (ids.length === 0) return tasks;
    const labels = await this.assistantLabels(ctx, ids);
    return tasks.map((t) => ({
      ...t,
      assignedByEmployee: t.assignedByAiEmployeeId
        ? (labels.get(t.assignedByAiEmployeeId) ?? null)
        : null,
    }));
  }

  private async requireTask(
    tx: Tx,
    ctx: RequestContext,
    id: string,
    forUpdate: boolean,
  ): Promise<TaskRow> {
    const row = await this.repo.find(tx, ctx.companyId, id, { forUpdate });
    if (!row) throw new DomainError('NOT_FOUND', 'Không tìm thấy task');
    return row;
  }

  private async assertAssigneeExists(
    ctx: RequestContext,
    assignee: { kind: 'ai_employee' | 'team' | 'org_unit'; id: string },
  ): Promise<void> {
    if (assignee.kind === 'ai_employee') {
      const employee = await this.employees.get(ctx, assignee.id);
      if (employee.status === 'archived') {
        throw new DomainError('NO_SUITABLE_ASSIGNEE', 'AI Employee đã được lưu trữ');
      }
    } else if (assignee.kind === 'org_unit') {
      const unit = await this.organization.getOrgUnit(ctx, assignee.id);
      if (!unit) throw new DomainError('NOT_FOUND', 'Không tìm thấy đơn vị');
    }
  }

  private async assertAssigneeNotSuspended(ctx: RequestContext, row: TaskRow): Promise<void> {
    if (row.assigneeKind !== 'ai_employee') return;
    const employee = await this.employees.get(ctx, row.assigneeId);
    if (employee.status === 'suspended') {
      throw new DomainError('EMPLOYEE_SUSPENDED', 'Nhân viên đang bị tạm ngưng', {
        employeeId: employee.id,
      });
    }
  }

  /** Người ra quyết định phải đúng loại actor: người thật `approve|reject|rework`, AI Manager `pass|rework`. */
  private resolveReviewer(
    ctx: RequestContext,
    task: TaskRow,
    decision: TaskDecisionInput['decision'],
  ): { kind: 'ai' | 'human'; id: string } {
    if (ctx.actor.kind === 'human') {
      if (!['approve', 'reject', 'rework'].includes(decision)) {
        throw new DomainError('FORBIDDEN', 'Quyết định này chỉ dành cho AI Manager');
      }
      if (task.status !== 'awaiting_human_approval') {
        throw new DomainError('TASK_INVALID_TRANSITION', 'Task không ở trạng thái chờ duyệt', {
          from: task.status,
        });
      }
      return { kind: 'human', id: ctx.actor.memberId };
    }
    if (ctx.actor.kind === 'ai') {
      if (!['pass', 'rework'].includes(decision)) {
        throw new DomainError('FORBIDDEN', 'Quyết định này chỉ dành cho người thật');
      }
      if (task.status !== 'in_review') {
        throw new DomainError('TASK_INVALID_TRANSITION', 'Task không ở trạng thái in_review', {
          from: task.status,
        });
      }
      return { kind: 'ai', id: ctx.actor.employeeId };
    }
    throw new DomainError('FORBIDDEN', 'Quyết định review phải do người review thực hiện');
  }

  /** `reviewer_id ≠` AI Employee đã tạo artifact của vòng hiện tại (Nguyên tắc VII). */
  private async assertIndependentReviewer(
    tx: Tx,
    ctx: RequestContext,
    task: TaskRow,
    reviewerId: string,
  ): Promise<void> {
    const artifacts = await this.repo.listArtifacts(tx, ctx.companyId, task.id);
    const authored = artifacts.some(
      (a) => a.round === task.reworkCount && a.createdByEmployeeId === reviewerId,
    );
    if (authored) {
      throw new DomainError(
        'REVIEWER_NOT_INDEPENDENT',
        'Người review không được là người đã tạo artifact',
        { reviewerId },
      );
    }
  }

  private async completeness(
    tx: Tx,
    ctx: RequestContext,
    task: TaskRow,
  ): Promise<CompletenessReport> {
    const artifacts = await this.repo.listArtifacts(tx, ctx.companyId, task.id);
    const evidence = await this.repo.listEvidence(tx, ctx.companyId, task.id);
    return checkEvidence({
      criteria: task.acceptanceCriteria,
      evidence,
      round: task.reworkCount,
      artifactsInRound: artifacts.filter((a) => a.round === task.reworkCount).length,
    });
  }

  // --- mở rộng phạm vi để lọc ---

  /** Phạm vi quản lý + bộ lọc đơn vị → tập assignee. `undefined` nghĩa là không giới hạn. */
  private async resolveAssignees(
    ctx: RequestContext,
    filter: TaskFilter,
  ): Promise<AssigneeSets | undefined> {
    const fromScope = filter.scope ? this.scopeSets(filter.scope) : undefined;
    const fromUnit = filter.orgUnitId ? await this.expandOrgUnit(ctx, filter.orgUnitId) : undefined;
    if (fromScope && fromUnit) {
      const keep = (a: string[], b: string[]) => a.filter((x) => b.includes(x));
      return {
        employeeIds: keep(fromScope.employeeIds, fromUnit.employeeIds),
        teamIds: keep(fromScope.teamIds, fromUnit.teamIds),
        orgUnitIds: keep(fromScope.orgUnitIds, fromUnit.orgUnitIds),
      };
    }
    return fromScope ?? fromUnit;
  }

  private scopeSets(scope: ManagedScope): AssigneeSets | undefined {
    if (scope.companyWide) return undefined;
    return {
      employeeIds: scope.employeeIds,
      teamIds: scope.teamIds,
      orgUnitIds: scope.orgUnitIds,
    };
  }

  /** Đơn vị, đơn vị con, team và nhân viên (`home_org_unit_id`) thuộc một đơn vị. */
  private async expandOrgUnit(ctx: RequestContext, orgUnitId: string): Promise<AssigneeSets> {
    const chart = await this.organization.getOrgChart(ctx);
    const subtree = findSubtree(chart.roots, orgUnitId);
    if (!subtree) return { employeeIds: [], teamIds: [], orgUnitIds: [] };
    const orgUnitIds: string[] = [];
    const teamIds: string[] = [];
    const walk = (node: OrgChartNode) => {
      orgUnitIds.push(node.id);
      teamIds.push(...node.teams.map((t) => t.id));
      node.children.forEach(walk);
    };
    walk(subtree);
    // Tuần tự: trong request, các lời gọi engine dùng chung transaction (một client pg).
    const employees = [];
    for (const id of orgUnitIds) employees.push(...(await this.employees.list(ctx, { orgUnitId: id })));
    return { employeeIds: employees.map((e) => e.id), teamIds, orgUnitIds };
  }
}

function findSubtree(nodes: OrgChartNode[], id: string): OrgChartNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findSubtree(node.children, id);
    if (found) return found;
  }
  return undefined;
}
