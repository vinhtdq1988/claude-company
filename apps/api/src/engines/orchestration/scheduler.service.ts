import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  DomainError,
  type EmployeeEngine,
  type RequestContext,
  type TaskDetail,
  type TaskEngine,
} from '@claude-company/contracts';
import type { Redis } from 'ioredis';
import { REDIS } from '../../platform/config/infra.providers';
import { EMPLOYEE_ENGINE, TASK_ENGINE } from '../../platform/engine-tokens';
import { TaskLock } from '../../platform/queue/queues';

/** Khóa phân tán ngắn giữ trong lúc kiểm tra slot và `start`, để hai lần lập lịch không cùng lấy slot cuối. */
const LOCK_TTL_MS = 15_000;

/** Số task `assigned` tối đa xét mỗi lần lập lịch cho một nhân viên. */
const CANDIDATE_LIMIT = 50;

/**
 * Lập lịch hàng chờ slot (FR-007, US2-AS5): task `assigned` của nhân viên được `start` theo priority rồi
 * deadline khi nhân viên còn slot và (với task con) mọi phụ thuộc đã `completed`. Nhân viên `suspended` không nhận run mới.
 */
@Injectable()
export class TaskScheduler {
  private readonly logger = new Logger(TaskScheduler.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private get tasks(): TaskEngine {
    return this.moduleRef.get<TaskEngine>(TASK_ENGINE, { strict: false });
  }
  private get employees(): EmployeeEngine {
    return this.moduleRef.get<EmployeeEngine>(EMPLOYEE_ENGINE, { strict: false });
  }

  /**
   * Lấy các task đang chờ của một nhân viên cho tới khi hết slot. Trả số task đã `start`.
   * Chuyển `start` làm phát `task.status_changed` → listener tạo run `execute`.
   */
  async scheduleEmployee(ctx: RequestContext, employeeId: string): Promise<number> {
    const lock = await TaskLock.acquire(this.redis, `employee:${employeeId}`, LOCK_TTL_MS);
    if (!lock) return 0; // đang có lần lập lịch khác cho nhân viên này; nó sẽ thấy cả task mới
    try {
      const employee = await this.employees.get(ctx, employeeId).catch(() => null);
      if (!employee || employee.status !== 'active') return 0;
      const capacity = await this.employees.getCapacity(ctx, employeeId);
      let free = capacity.max - capacity.active;
      if (free <= 0) return 0;

      const waiting = await this.tasks.list(ctx, {
        assigneeKind: 'ai_employee',
        assigneeId: employeeId,
        statusIn: ['assigned'],
        order: 'queue',
        limit: CANDIDATE_LIMIT,
      });
      let started = 0;
      for (const candidate of waiting.items) {
        if (free <= 0) break;
        const detail = await this.tasks.get(ctx, candidate.id);
        if (!(await this.isReady(ctx, detail))) continue;
        try {
          await this.tasks.transition(ctx, candidate.id, 'start');
          free -= 1;
          started += 1;
        } catch (error) {
          // Task vừa bị hủy/chặn trong lúc xét: bỏ qua, xét task kế tiếp.
          if (!(error instanceof DomainError) || error.code !== 'TASK_INVALID_TRANSITION') {
            this.logger.error(
              `Không start được task ${candidate.id}`,
              error instanceof Error ? error : String(error),
            );
          }
        }
      }
      return started;
    } finally {
      await lock.release();
    }
  }

  /**
   * Sẵn sàng `start` khi: task con có mọi phụ thuộc `completed`; task gốc giao trực tiếp đã được AI Manager
   * xác nhận (`mode = confirm`) hoặc đang chờ đúng bước đó thì chưa sẵn sàng.
   */
  async isReady(ctx: RequestContext, task: TaskDetail): Promise<boolean> {
    if (task.parentTaskId === null) {
      return task.decompositionPlan?.mode === 'confirm';
    }
    if (task.dependsOn.length === 0) return true;
    const deps = await this.tasks.list(ctx, { ids: task.dependsOn, limit: task.dependsOn.length });
    return deps.items.length === task.dependsOn.length && deps.items.every((t) => t.status === 'completed');
  }
}
