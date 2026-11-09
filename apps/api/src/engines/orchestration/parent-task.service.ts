import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  DomainError,
  type OrchestrationEngine,
  type RequestContext,
  type TaskEngine,
} from '@claude-company/contracts';
import { ORCHESTRATION_ENGINE, TASK_ENGINE } from '../../platform/engine-tokens';

/**
 * Hoàn tất task cha (FR-018, R10): khi mọi task con `completed`, AI Manager đã phân rã tổng hợp artifact
 * (run `synthesize`), task cha `in_progress → in_review`, rồi một AI Manager KHÁC review. Task cha chỉ
 * `completed` qua Human Approval của chính nó.
 */
@Injectable()
export class ParentTaskService {
  constructor(private readonly moduleRef: ModuleRef) {}

  private get tasks(): TaskEngine {
    return this.moduleRef.get<TaskEngine>(TASK_ENGINE, { strict: false });
  }
  private get orchestration(): OrchestrationEngine {
    return this.moduleRef.get<OrchestrationEngine>(ORCHESTRATION_ENGINE, { strict: false });
  }

  /** `true` nếu đã đưa run `synthesize` vào hàng đợi. Gọi lại nhiều lần an toàn (enqueueRun khử trùng). */
  async maybeSynthesize(ctx: RequestContext, parentTaskId: string): Promise<boolean> {
    const parent = await this.tasks.get(ctx, parentTaskId);
    if (parent.status !== 'in_progress' || parent.subtasks.length === 0) return false;
    if (!parent.subtasks.every((s) => s.status === 'completed')) return false;
    try {
      await this.orchestration.enqueueRun(ctx, parentTaskId, 'synthesize');
      return true;
    } catch (error) {
      // Thiếu AI Manager phân rã: enqueueRun ném NO_AI_MANAGER nhưng task cha chưa bị chặn, nên chặn tại đây.
      if (error instanceof DomainError && error.code === 'NO_AI_MANAGER') {
        await this.tasks
          .transition({ ...ctx, actor: { kind: 'system' } }, parentTaskId, 'block', {
            blockedReason: 'NO_AI_MANAGER',
          })
          .catch(() => undefined);
        return false;
      }
      throw error;
    }
  }
}
