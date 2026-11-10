import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  DomainError,
  type CommunicationEngine,
  type EmployeeEngine,
  type OrganizationEngine,
  type RequestContext,
  type TaskDetail,
  type TaskEngine,
} from '@claude-company/contracts';
import type { Redis } from 'ioredis';
import { REDIS } from '../../platform/config/infra.providers';
import {
  COMMUNICATION_ENGINE,
  EMPLOYEE_ENGINE,
  ORGANIZATION_ENGINE,
  TASK_ENGINE,
} from '../../platform/engine-tokens';
import { TaskLock } from '../../platform/queue/queues';
import { ScopeConcurrency } from './concurrency-limits';

/** Khóa phân tán ngắn giữ trong lúc kiểm tra slot và `start`, để hai lần lập lịch không cùng lấy slot cuối. */
const LOCK_TTL_MS = 15_000;

/** Chờ khóa phạm vi (giới hạn theo company/đơn vị/team) tối đa ~1 giây trước khi bỏ lượt. */
const SCOPE_LOCK_ATTEMPTS = 20;
const SCOPE_LOCK_WAIT_MS = 50;

/** Số task `assigned` tối đa xét mỗi lần lập lịch cho một nhân viên. */
const CANDIDATE_LIMIT = 50;

/** Khóa cảnh báo quá tải sống lâu hơn một ngày để chắc chắn phủ hết ngày lịch của công ty. */
const OVERLOAD_KEY_TTL_SECONDS = 26 * 60 * 60;

/** Ngày lịch `YYYY-MM-DD` của một thời điểm theo múi giờ công ty. */
function dayOf(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Lập lịch hàng chờ slot (FR-007, US2-AS5, US6): task `assigned` của nhân viên được `start` theo priority rồi
 * deadline khi nhân viên còn slot, các scope company/đơn vị/team của nhân viên còn slot theo `max_concurrent_tasks`,
 * và (với task con) mọi phụ thuộc đã `completed`. Nhân viên `suspended` không nhận run mới.
 */
@Injectable()
export class TaskScheduler {
  private readonly logger = new Logger(TaskScheduler.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly scopeLimits: ScopeConcurrency,
  ) {}

  private get tasks(): TaskEngine {
    return this.moduleRef.get<TaskEngine>(TASK_ENGINE, { strict: false });
  }
  private get employees(): EmployeeEngine {
    return this.moduleRef.get<EmployeeEngine>(EMPLOYEE_ENGINE, { strict: false });
  }
  private get communication(): CommunicationEngine {
    return this.moduleRef.get<CommunicationEngine>(COMMUNICATION_ENGINE, { strict: false });
  }
  private get organization(): OrganizationEngine {
    return this.moduleRef.get<OrganizationEngine>(ORGANIZATION_ENGINE, { strict: false });
  }

  /**
   * Lấy các task đang chờ của một nhân viên cho tới khi hết slot. Trả số task đã `start`.
   * Chuyển `start` làm phát `task.status_changed` → listener tạo run `execute`.
   */
  async scheduleEmployee(ctx: RequestContext, employeeId: string): Promise<number> {
    const lock = await TaskLock.acquire(this.redis, `employee:${employeeId}`, LOCK_TTL_MS);
    if (!lock) return 0; // đang có lần lập lịch khác cho nhân viên này; nó sẽ thấy cả task mới
    let scopeLock: TaskLock | null = null;
    try {
      const employee = await this.employees.get(ctx, employeeId).catch(() => null);
      if (!employee || employee.status !== 'active') return 0;
      const capacity = await this.employees.getCapacity(ctx, employeeId);
      const limits = await this.scopeLimits.limitsOf(ctx, employeeId);
      if (limits.length > 0) {
        // Nhân viên cùng scope không có chung khóa nhân viên, nên cần khóa công ty để không cùng lấy slot cuối.
        scopeLock = await this.acquireScopeLock(ctx);
        if (!scopeLock) return 0;
      }
      let free = capacity.max - capacity.active;
      if (limits.length > 0) free = Math.min(free, await this.scopeLimits.freeSlots(ctx, limits));

      const waiting = await this.tasks.list(ctx, {
        assigneeKind: 'ai_employee',
        assigneeId: employeeId,
        statusIn: ['assigned'],
        order: 'queue',
        limit: CANDIDATE_LIMIT,
      });
      let started = 0;
      let queued = 0;
      for (const candidate of waiting.items) {
        const detail = await this.tasks.get(ctx, candidate.id);
        if (!(await this.isReady(ctx, detail))) continue;
        if (free <= 0) {
          queued += 1; // sẵn sàng nhưng chưa có slot
          continue;
        }
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
      if (queued >= capacity.max) {
        await this.warnOverload(ctx, employee.name, employeeId, queued, capacity.max);
      }
      return started;
    } finally {
      await scopeLock?.release();
      await lock.release();
    }
  }

  /**
   * Một slot vừa được giải phóng: lập lịch cho nhân viên đó, rồi cho các nhân viên cùng scope đang bị giới hạn
   * `max_concurrent_tasks` của company/đơn vị/team giữ lại.
   */
  async scheduleAfterRelease(ctx: RequestContext, employeeId: string): Promise<number> {
    let started = await this.scheduleEmployee(ctx, employeeId);
    const limits = await this.scopeLimits.limitsOf(ctx, employeeId).catch(() => []);
    const others = new Set<string>();
    for (const limit of limits) {
      for (const id of await this.scopeLimits.waitingEmployeeIds(ctx, limit)) {
        if (id !== employeeId) others.add(id);
      }
    }
    for (const id of others) started += await this.scheduleEmployee(ctx, id);
    return started;
  }

  /** Giới hạn đồng thời vừa đổi: lập lịch lại mọi nhân viên có task đang chờ slot. */
  async scheduleAllWaiting(ctx: RequestContext): Promise<number> {
    const waiting = await this.tasks.list(ctx, {
      assigneeKind: 'ai_employee',
      statusIn: ['assigned'],
      order: 'queue',
      limit: 200,
    });
    let started = 0;
    for (const id of new Set(waiting.items.map((t) => t.assigneeId))) {
      started += await this.scheduleEmployee(ctx, id);
    }
    return started;
  }

  private async acquireScopeLock(ctx: RequestContext): Promise<TaskLock | null> {
    for (let attempt = 0; attempt < SCOPE_LOCK_ATTEMPTS; attempt += 1) {
      const lock = await TaskLock.acquire(this.redis, `scopes:${ctx.companyId}`, LOCK_TTL_MS);
      if (lock) return lock;
      await sleep(SCOPE_LOCK_WAIT_MS);
    }
    return null;
  }

  /**
   * `overload_warning` khi số task sẵn sàng nhưng chờ slot đạt `max_concurrent_tasks` của nhân viên, tối đa một lần
   * mỗi ngày lịch (múi giờ công ty) cho mỗi nhân viên. Lỗi gửi thông báo không làm hỏng việc lập lịch.
   */
  private async warnOverload(
    ctx: RequestContext,
    name: string,
    employeeId: string,
    queued: number,
    max: number,
  ): Promise<void> {
    try {
      const company = await this.organization.getCompany(ctx);
      const key = `overload:${ctx.companyId}:${employeeId}:${dayOf(new Date(), company.timezone)}`;
      const first = await this.redis.set(key, '1', 'EX', OVERLOAD_KEY_TTL_SECONDS, 'NX');
      if (first !== 'OK') return;
      await this.communication.notifyRouted(ctx, {
        type: 'overload_warning',
        employeeId,
        title: `${name} đang quá tải`,
        body: `${queued} task đang chờ slot (giới hạn đồng thời ${max}).`,
      });
    } catch (error) {
      this.logger.warn(`Không gửi được cảnh báo quá tải: ${String(error)}`);
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
    return (
      deps.items.length === task.dependsOn.length &&
      deps.items.every((t) => t.status === 'completed')
    );
  }
}
