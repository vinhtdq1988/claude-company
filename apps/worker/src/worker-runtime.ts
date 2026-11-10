import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  BUDGET_SERVICE,
  COMMUNICATION_ENGINE,
  CONFIG,
  EMPLOYEE_ENGINE,
  MEMORY_ENGINE,
  MODEL_CATALOG,
  OFFICE_SIMULATION_ENGINE,
  ORCHESTRATION_ENGINE,
  ORGANIZATION_ENGINE,
  PERMISSION_ENGINE,
  QUEUE_NAME,
  QueueService,
  REDIS,
  StorageService,
  TASK_ENGINE,
  TOOL_ADAPTER_LOOKUP,
  TaskLock,
  computeCostUsd,
  estimateSdkRun,
  sdkMaxBudgetUsd,
  sdkTokenCeiling,
  type AppConfig,
} from '@claude-company/api';
import type {
  BudgetService,
  CommunicationEngine,
  EmployeeEngine,
  MemoryEngine,
  ModelCatalog,
  OfficeSimulationEngine,
  OrchestrationEngine,
  OrganizationEngine,
  PermissionEngine,
  TaskEngine,
  ToolAdapter,
} from '@claude-company/contracts';
import type { ModelGateway } from '@claude-company/model-gateway';
import { executeApprovedAction, type ApprovalJobPayload } from './jobs/approval-jobs';
import { completeDisplayElapsed } from './jobs/office-jobs';
import { processJob } from './jobs/run-jobs';
import { sweepOnce } from './jobs/overdue-sweeper';
import { recoverOnce } from './jobs/recovery-sweeper';
import { ApprovalRequestGate } from './runtime/approval-gate';
import { InputBuilder } from './runtime/input-builder';
import { RunExecutor } from './runtime/run-loop';
import { MODEL_GATEWAY, SANDBOX_CLIENT } from './runtime/tokens';
import { ToolBroker } from './runtime/tool-broker';
import { createInternalHandlers } from './tools/internal-tools';
import { RunWorkspaceManager } from './tools/run-workspace';
import type { SandboxClient } from './tools/sandbox-client';
import { createWorkspaceHandlers } from './tools/workspace-tools';

/** Số run chạy song song tối đa trong một worker (~10 run đồng thời toàn hệ thống, plan.md). */
const CONCURRENCY = 5;

/**
 * Process worker: nhận job BullMQ chạy `agent_run` và chạy sweeper định kỳ. Ghép mọi phụ thuộc từ interface của
 * engine (Nguyên tắc VI): worker không truy cập bảng trực tiếp.
 */
@Injectable()
export class WorkerRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerRuntime.name);
  private worker: Worker | undefined;
  private sweeper: NodeJS.Timeout | undefined;
  private cached: RunExecutor | undefined;

  constructor(
    private readonly moduleRef: ModuleRef,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly queue: QueueService,
    private readonly storage: StorageService,
    @Inject(MODEL_GATEWAY) private readonly gateway: ModelGateway,
    @Inject(SANDBOX_CLIENT) private readonly sandbox: SandboxClient,
    @Inject(TOOL_ADAPTER_LOOKUP) private readonly adapters: { find(actionType: string): ToolAdapter | undefined },
  ) {}

  /** Engine được lấy muộn qua ModuleRef: provider alias (`useExisting`) chưa sẵn sàng trong constructor. */
  private engine<T>(token: symbol): T {
    return this.moduleRef.get<T>(token, { strict: false });
  }

  /** Ghép phụ thuộc lần đầu cần dùng, từ interface của engine (Nguyên tắc VI). */
  get executor(): RunExecutor {
    if (!this.cached) this.cached = this.buildExecutor();
    return this.cached;
  }

  private buildExecutor(): RunExecutor {
    const { config } = this;
    const tasks = this.engine<TaskEngine>(TASK_ENGINE);
    const employees = this.engine<EmployeeEngine>(EMPLOYEE_ENGINE);
    const orchestration = this.engine<OrchestrationEngine>(ORCHESTRATION_ENGINE);
    const communication = this.engine<CommunicationEngine>(COMMUNICATION_ENGINE);

    const handlers = new Map([
      ...createWorkspaceHandlers({ sandbox: this.sandbox, toolTimeoutMs: config.TOOL_TIMEOUT_MS }),
      ...createInternalHandlers({ tasks, communication, storage: this.storage }),
    ]);
    const permissions = this.engine<PermissionEngine>(PERMISSION_ENGINE);
    const broker = new ToolBroker({
      orchestration,
      permissions,
      tasks,
      handlers,
      // Human Approval: agent chỉ tạo đề xuất; hệ thống thực thi sau khi duyệt (action.execute-approved).
      humanApproval: new ApprovalRequestGate({ permissions, orchestration, tasks }),
      toolTimeoutMs: config.TOOL_TIMEOUT_MS,
    });
    return new RunExecutor({
      gateway: this.gateway,
      tasks,
      employees,
      orchestration,
      permissions,
      budget: this.engine<BudgetService>(BUDGET_SERVICE),
      communication,
      catalog: this.engine<ModelCatalog>(MODEL_CATALOG),
      broker,
      inputs: new InputBuilder({
        tasks,
        employees,
        organization: this.engine<OrganizationEngine>(ORGANIZATION_ENGINE),
        memory: this.engine<MemoryEngine>(MEMORY_ENGINE),
        communication,
        artifactContextMaxBytes: config.ARTIFACT_CONTEXT_MAX_BYTES,
      }),
      workspaces: new RunWorkspaceManager({
        baseDir: config.RUN_WORKTREES_PATH,
        workspaceRoot: config.WORKSPACE_HOST_PATH,
        sandbox: this.sandbox,
      }),
      cost: { computeCostUsd, estimateSdkRun, sdkMaxBudgetUsd, sdkTokenCeiling },
      config,
      lockTask: (taskId, ttlMs) => TaskLock.acquire(this.redis, taskId, ttlMs),
      logger: {
        error: (message, error) =>
          this.logger.error(message, error instanceof Error ? error.stack : String(error ?? '')),
        warn: (message) => this.logger.warn(message),
      },
    });
  }

  onModuleInit(): void {
    if (this.config.WORKER_CONSUME_JOBS) this.startConsumer();
    if (this.config.SWEEP_INTERVAL_MS > 0) {
      // Phục hồi ngay khi khởi động (sau downtime dài, run chết đã quá hạn heartbeat), rồi định kỳ cùng sweeper.
      void this.recover();
      this.sweeper = setInterval(() => void this.sweep(), this.config.SWEEP_INTERVAL_MS);
      this.sweeper.unref();
    }
  }

  /** Quét phục hồi run chết một lần (T182). Không ném lỗi. */
  recover() {
    return recoverOnce({
      orchestration: this.engine<OrchestrationEngine>(ORCHESTRATION_ENGINE),
      logger: {
        log: (message) => this.logger.log(message),
        error: (message, error) =>
          this.logger.error(message, error instanceof Error ? error.stack : String(error ?? '')),
      },
    });
  }

  private startConsumer(): void {
    this.worker = new Worker(
      QUEUE_NAME,
      (job) =>
        processJob(job, {
          executor: this.executor,
          enqueue: (name, payload, options) => this.queue.enqueue(name, payload, options),
          executeApproved: (payload) => this.executeApproved(payload),
          completedElapsed: (payload) =>
            completeDisplayElapsed(payload, {
              office: this.engine<OfficeSimulationEngine>(OFFICE_SIMULATION_ENGINE),
            }),
        }),
      { connection: this.redis.duplicate(), concurrency: CONCURRENCY },
    );
    this.worker.on('failed', (job, error) =>
      this.logger.error(`Job ${job?.name} ${job?.id} lỗi: ${error.message}`),
    );
  }

  /** Job `action.execute-approved`: hệ thống thực thi payload đã duyệt qua adapter rồi đánh thức run. */
  executeApproved(payload: ApprovalJobPayload) {
    return executeApprovedAction(payload, {
      permissions: this.engine<PermissionEngine>(PERMISSION_ENGINE),
      orchestration: this.engine<OrchestrationEngine>(ORCHESTRATION_ENGINE),
      tasks: this.engine<TaskEngine>(TASK_ENGINE),
      adapters: this.adapters,
      enqueue: (name, data, options) => this.queue.enqueue(name, data, options),
    });
  }

  async sweep() {
    try {
      return await sweepOnce({
        tasks: this.engine<TaskEngine>(TASK_ENGINE),
        orchestration: this.engine<OrchestrationEngine>(ORCHESTRATION_ENGINE),
        permissions: this.engine<PermissionEngine>(PERMISSION_ENGINE),
      });
    } catch (error) {
      this.logger.error('Sweeper lỗi', error instanceof Error ? error.stack : String(error));
      return undefined;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    await this.worker?.close();
  }
}
