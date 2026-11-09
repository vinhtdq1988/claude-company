import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  DomainError,
  type EmployeeEngine,
  type RequestContext,
  type ReviewResult,
  type Task,
  type TaskEngine,
} from '@claude-company/contracts';
import { EMPLOYEE_ENGINE, TASK_ENGINE } from '../../platform/engine-tokens';
import { pickReviewer, type SelectionCandidate } from './manager-selection';

type ReviewSubject = Task & { decomposedByEmployeeId: string | null; subtasks: Task[] };

/**
 * Chọn reviewer AI độc lập (D5) và áp dụng kết quả review (FR-018): ghi bằng chứng từng criterion rồi quyết định
 * `pass` hoặc `rework` kèm lý do. Hệ thống không tin `pass` của AI nếu bằng chứng chưa đủ.
 */
@Injectable()
export class ReviewFlowService {
  constructor(private readonly moduleRef: ModuleRef) {}

  private get tasks(): TaskEngine {
    return this.moduleRef.get<TaskEngine>(TASK_ENGINE, { strict: false });
  }
  private get employees(): EmployeeEngine {
    return this.moduleRef.get<EmployeeEngine>(EMPLOYEE_ENGINE, { strict: false });
  }

  /**
   * Task lá: người thực thi là assignee. Task cha (đã phân rã): người thực thi là AI Manager đã tổng hợp, và AI
   * Manager không làm task con nào được ưu tiên (FR-018). Trả `undefined` khi không có (`NO_INDEPENDENT_REVIEWER`).
   */
  async selectReviewer(
    ctx: RequestContext,
    task: ReviewSubject,
  ): Promise<SelectionCandidate | undefined> {
    const isParent = task.subtasks.length > 0 || task.assigneeKind !== 'ai_employee';
    const executorId = isParent ? task.decomposedByEmployeeId : task.assigneeId;
    if (!executorId) return undefined;
    const profiles = await this.employees.list(ctx, {});
    return pickReviewer({
      executorId,
      employees: profiles.map((p) => ({
        id: p.id,
        kind: p.kind,
        status: p.status,
        homeOrgUnitId: p.homeOrgUnitId,
        teamIds: p.teamIds,
        manager: p.manager,
      })),
      involvedIds: isParent
        ? task.subtasks.filter((s) => s.assigneeKind === 'ai_employee').map((s) => s.assigneeId)
        : [],
    });
  }

  /** `ctx.actor` là AI Manager của run `review`. */
  async applyReviewResult(ctx: RequestContext, taskId: string, result: ReviewResult): Promise<void> {
    if (ctx.actor.kind !== 'ai') {
      throw new DomainError('FORBIDDEN', 'Kết quả review phải do AI Manager ghi');
    }
    await this.tasks.recordEvidence(ctx, taskId, result.evidence);
    if (result.decision === 'pass') {
      try {
        await this.tasks.recordDecision(ctx, taskId, { decision: 'pass', reason: result.reason });
        return;
      } catch (error) {
        // AI nói đạt nhưng bằng chứng chưa đủ cho từng criterion: coi là cần làm lại, không cho đi tiếp.
        if (!(error instanceof DomainError) || error.code !== 'EVIDENCE_INCOMPLETE') throw error;
        await this.tasks.recordDecision(ctx, taskId, {
          decision: 'rework',
          reason: `${result.reason} (Chưa đủ bằng chứng đạt cho mọi tiêu chí nghiệm thu: ${JSON.stringify(error.details)})`,
        });
        return;
      }
    }
    await this.tasks.recordDecision(ctx, taskId, { decision: 'rework', reason: result.reason });
  }
}
