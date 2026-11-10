import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  createTaskSchema,
  DomainError,
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
        assignedByAiEmployeeId: input.assignedByAiEmployeeId ?? null,
        assigneeKind: body.assignee.kind,
        assigneeId: body.assignee.id,
        deadline: new Date(body.deadline),
        priority: body.priority,
        acceptanceCriteria: body.acceptanceCriteria.map((text, i) => ({ id: `c${i + 1}`, text })),
        expectedOutput: body.expectedOutput,
        status: 'draft',
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
        ...toTask(row),
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
    return { items: rows.map(toTask), nextCursor };
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
