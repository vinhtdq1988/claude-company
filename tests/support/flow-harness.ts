import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type {
  BudgetService,
  CommunicationEngine,
  EmployeeEngine,
  EmployeeProfile,
  EmployeeProfileInput,
  MemoryEngine,
  OrchestrationEngine,
  OrganizationEngine,
  OrgChart,
  OrgChartNode,
  PermissionEngine,
  RequestContext,
  TaskEngine,
} from '@claude-company/contracts';
import { closeDatabase, newId, withGlobal } from '@claude-company/db';
import { user } from '@claude-company/db/schema/auth';
import { createModelGateway, type FakeModelProviderOptions } from '@claude-company/model-gateway';
import { OutboxRelay } from '../../apps/api/src/platform/events/outbox-relay';
import { loadConfig, type AppConfig } from '../../apps/api/src/platform/config/config';
import { CONFIG, REDIS } from '../../apps/api/src/platform/config/infra.providers';
import {
  BUDGET_SERVICE,
  COMMUNICATION_ENGINE,
  EMPLOYEE_ENGINE,
  MEMORY_ENGINE,
  ORCHESTRATION_ENGINE,
  ORGANIZATION_ENGINE,
  PERMISSION_ENGINE,
  TASK_ENGINE,
} from '../../apps/api/src/platform/engine-tokens';
import { QueueService, type JobName, type JobPayload } from '../../apps/api/src/platform/queue/queues';
import { StorageService } from '../../apps/api/src/platform/storage/storage.service';
import { processJob } from '../../apps/worker/src/jobs/run-jobs';
import { MODEL_GATEWAY } from '../../apps/worker/src/runtime/tokens';
import { WorkerModule } from '../../apps/worker/src/worker.module';
import { WorkerRuntime } from '../../apps/worker/src/worker-runtime';
import type { StartedInfra } from './containers';

/** Redis tối thiểu cho `TaskLock` và relay outbox; đủ để chạy luồng nghiệp vụ khi không có Redis thật. */
export class FakeRedis {
  private readonly store = new Map<string, string>();
  readonly published: string[] = [];

  async set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> {
    if (args.includes('NX') && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async pexpire(): Promise<number> {
    return 1;
  }
  async eval(_script: string, _n: number, key: string, token: string): Promise<number> {
    if (this.store.get(key) === token) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }
  async publish(_channel: string, message: string): Promise<number> {
    this.published.push(message);
    return 0;
  }
  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) if (this.store.delete(key)) removed += 1;
    return removed;
  }
  duplicate(): this {
    return this;
  }
  disconnect(): void {}
  async quit(): Promise<void> {}
}

export type QueuedJob = { name: JobName; payload: JobPayload; jobId: string; delayMs: number };

/** Thay `QueueService`: ghi job vào bộ nhớ để test chủ động chạy (`harness.settle()`), khử trùng theo jobId. */
export class InProcessQueue {
  readonly jobs: QueuedJob[] = [];
  readonly seen = new Set<string>();
  /** Mọi job từng được xếp hàng, để test kiểm tra. */
  readonly history: QueuedJob[] = [];

  async enqueue(
    name: JobName,
    payload: JobPayload,
    options: { jobId?: string; delayMs?: number } = {},
  ): Promise<string> {
    const jobId = options.jobId ?? randomUUID();
    if (!this.seen.has(jobId)) {
      this.seen.add(jobId);
      const job = { name, payload, jobId, delayMs: options.delayMs ?? 0 };
      this.jobs.push(job);
      this.history.push(job);
    }
    return jobId;
  }

  /** Lấy job đầu tiên thỏa `accept` (mặc định mọi job). */
  next(accept: (job: QueuedJob) => boolean = () => true): QueuedJob | undefined {
    const index = this.jobs.findIndex(accept);
    return index < 0 ? undefined : this.jobs.splice(index, 1)[0];
  }
}

/** Thay `StorageService`: artifact lưu trong bộ nhớ. */
export class MemoryStorage {
  readonly objects = new Map<string, Buffer>();
  async onModuleInit(): Promise<void> {}
  async put(input: {
    companyId: string;
    body: Buffer | Uint8Array | string;
    key?: string;
  }): Promise<{ key: string; checksumSha256: string; sizeBytes: number }> {
    const body = typeof input.body === 'string' ? Buffer.from(input.body) : Buffer.from(input.body);
    const key = input.key ?? `${input.companyId}/${randomUUID()}`;
    this.objects.set(key, body);
    return { key, checksumSha256: 'x'.repeat(64), sizeBytes: body.length };
  }
  async getBuffer(key: string): Promise<Buffer> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`Không có object ${key}`);
    return found;
  }
  async getStream(key: string): Promise<Readable> {
    return Readable.from(await this.getBuffer(key));
  }
}

const flatten = (nodes: OrgChartNode[]): OrgChartNode[] =>
  nodes.flatMap((n) => [n, ...flatten(n.children)]);

export type Scene = {
  companyId: string;
  ceo: { userId: string; memberId: string };
  /** Department theo tên: Development, BA, QA. */
  units: Record<string, string>;
  ctx(actor?: RequestContext['actor']): RequestContext;
  humanCtx(memberId: string): RequestContext;
};

export interface FlowHarness {
  app: INestApplicationContext;
  config: AppConfig;
  queue: InProcessQueue;
  storage: MemoryStorage;
  redis: FakeRedis;
  relay: OutboxRelay;
  runtime: WorkerRuntime;
  org: OrganizationEngine;
  employees: EmployeeEngine;
  tasks: TaskEngine;
  orchestration: OrchestrationEngine;
  communication: CommunicationEngine;
  memory: MemoryEngine;
  budget: BudgetService;
  permission: PermissionEngine;
  /** Chạy outbox relay và job trong hàng đợi cho tới khi hệ thống yên (không còn sự kiện/job mới). */
  settle(maxRounds?: number): Promise<void>;
  /** Một vòng: phát sự kiện chưa phát rồi chạy tối đa một job. `false` khi không còn gì để làm. */
  step(hold?: JobName[]): Promise<boolean>;
  /** Như `settle` nhưng để nguyên các job có tên trong `hold` trong hàng đợi (dựng tình huống "run sắp chạy"). */
  settleExcept(hold: JobName[], maxRounds?: number): Promise<void>;
  newScene(name?: string): Promise<Scene>;
  hire(scene: Scene, overrides?: Partial<EmployeeProfileInput>): Promise<EmployeeProfile>;
  /** Thêm một human_member (Manager) vào công ty. */
  addManager(scene: Scene): Promise<{ userId: string; memberId: string }>;
  close(): Promise<void>;
}

export type HarnessOptions = {
  infra: StartedInfra;
  env?: Record<string, string>;
  fake?: FakeModelProviderOptions;
};

/**
 * Dựng toàn bộ engine thật (Organization, Employee, Task, Orchestration, Communication, Memory, Budget, Permission)
 * cùng `RunExecutor` của worker trên PostgreSQL thật (RLS bật). Chỉ Redis, BullMQ và S3 được thay bằng bản trong
 * bộ nhớ, nên chạy được cả khi không có Docker. Model dùng FakeModelProvider tất định.
 */
export async function createFlowHarness(options: HarnessOptions): Promise<FlowHarness> {
  if (!options.infra.databaseUrl) throw new Error('Gọi prepareDatabase(infra) trước createFlowHarness');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: options.infra.databaseUrl,
    REDIS_URL: 'redis://127.0.0.1:1',
    SESSION_SECRET: 'test-session-secret-test-session-secret',
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_BUCKET: 'test',
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'test-secret',
    MODEL_PROVIDER: 'fake',
    OUTBOX_POLL_MS: '0',
    SWEEP_INTERVAL_MS: '0',
    WORKER_CONSUME_JOBS: 'false',
    RUN_HEARTBEAT_INTERVAL_MS: '50',
    RETRY_BACKOFF_INITIAL_MS: '1',
    RETRY_BACKOFF_MAX_MS: '5',
    RUN_WORKTREES_PATH: `${process.env.TEMP ?? '/tmp'}/cc-worktrees-${randomUUID()}`,
    ...options.env,
  });
  const redis = new FakeRedis();
  const queue = new InProcessQueue();
  const storage = new MemoryStorage();

  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(CONFIG)
    .useValue(config)
    .overrideProvider(REDIS)
    .useValue(redis)
    .overrideProvider(QueueService)
    .useValue(queue)
    .overrideProvider(StorageService)
    .useValue(storage)
    .overrideProvider(MODEL_GATEWAY)
    .useValue(createModelGateway({ provider: 'fake', fake: options.fake }))
    .compile();
  const app = await moduleRef.init();

  const get = <T>(token: symbol | (new (...args: never[]) => T)) =>
    app.get<T>(token as never, { strict: false });
  const relay = get<OutboxRelay>(OutboxRelay);
  const runtime = get<WorkerRuntime>(WorkerRuntime);
  const org = get<OrganizationEngine>(ORGANIZATION_ENGINE);
  const employees = get<EmployeeEngine>(EMPLOYEE_ENGINE);

  const harness: FlowHarness = {
    app,
    config,
    queue,
    storage,
    redis,
    relay,
    runtime,
    org,
    employees,
    tasks: get<TaskEngine>(TASK_ENGINE),
    orchestration: get<OrchestrationEngine>(ORCHESTRATION_ENGINE),
    communication: get<CommunicationEngine>(COMMUNICATION_ENGINE),
    memory: get<MemoryEngine>(MEMORY_ENGINE),
    budget: get<BudgetService>(BUDGET_SERVICE),
    permission: get<PermissionEngine>(PERMISSION_ENGINE),

    async step(hold: JobName[] = []) {
      const published = await relay.tick();
      const job = queue.next((j) => !hold.includes(j.name));
      if (job) {
        await processJob(
          { id: job.jobId, name: job.name, data: job.payload },
          { executor: runtime.executor, enqueue: (n, p, o) => queue.enqueue(n, p, o) },
        );
      }
      return published > 0 || job !== undefined;
    },

    async settleExcept(hold, maxRounds = 300) {
      for (let round = 0; round < maxRounds; round += 1) {
        if (!(await harness.step(hold))) return;
      }
      throw new Error('settleExcept không hội tụ');
    },

    async settle(maxRounds = 300) {
      for (let round = 0; round < maxRounds; round += 1) {
        if (!(await harness.step())) return;
      }
      throw new Error('settle không hội tụ: vẫn còn sự kiện hoặc job mới sau quá nhiều vòng');
    },

    async newScene(name = 'Công ty thử nghiệm') {
      const userId = newId();
      await withGlobal((tx) =>
        tx.insert(user).values({
          id: userId,
          email: `ceo-${userId}@example.com`,
          passwordHash: 'x',
          displayName: 'CEO thử',
        }),
      );
      const created = await org.createCompany(
        { userId, traceId: 'scene' },
        { name, templateKey: 'software_company' },
      );
      const companyId = created.id;
      const memberships = await employees.findMemberships(userId);
      const memberId = memberships.find((m) => m.companyId === companyId)?.memberId;
      if (!memberId) throw new Error('CEO không có membership');
      const system: RequestContext = { companyId, actor: { kind: 'system' }, traceId: 'scene' };
      const chart: OrgChart = await org.getOrgChart(system);
      const units = Object.fromEntries(flatten(chart.roots).map((n) => [n.name, n.id]));
      return {
        companyId,
        ceo: { userId, memberId },
        units,
        ctx: (actor = { kind: 'system' }) => ({ companyId, actor, traceId: 'test' }),
        humanCtx: (member) => ({
          companyId,
          actor: { kind: 'human', memberId: member },
          traceId: 'test',
        }),
      };
    },

    async hire(scene, overrides = {}) {
      return employees.create(scene.ctx(), {
        name: 'AI Developer',
        avatarKey: 'developer',
        position: 'AI Developer',
        homeOrgUnitId: scene.units.Development!,
        kind: 'employee',
        roleTemplateKey: null,
        personality: 'cẩn thận',
        skills: ['typescript'],
        seniority: 'middle',
        modelId: 'claude-opus-5-5',
        runtimeKind: 'claude_agent_sdk',
        systemPrompt: 'Bạn là AI Developer.',
        toolGrants: ['workspace.read', 'artifact.publish', 'task.message.post'],
        workspaceId: null,
        manager: { kind: 'human', id: scene.ceo.memberId },
        maxConcurrentTasks: 2,
        ...overrides,
      });
    },

    async addManager(scene) {
      const userId = newId();
      await withGlobal((tx) =>
        tx.insert(user).values({
          id: userId,
          email: `mgr-${userId}@example.com`,
          passwordHash: 'x',
          displayName: 'Manager thử',
        }),
      );
      const member = await employees.addHumanMember(scene.ctx(), { userId, role: 'manager' });
      return { userId, memberId: member.id };
    },

    async close() {
      await app.close().catch(() => undefined);
      await closeDatabase().catch(() => undefined);
    },
  };
  return harness;
}

/** AI Manager mặc định cho kịch bản: messages_api, phân rã/review, manager là CEO. */
export function managerProfile(
  scene: Scene,
  overrides: Partial<EmployeeProfileInput> = {},
): Partial<EmployeeProfileInput> {
  return {
    name: 'AI Manager',
    position: 'AI Manager',
    kind: 'manager',
    runtimeKind: 'messages_api',
    toolGrants: ['workspace.read', 'artifact.publish', 'task.message.post', 'task.decompose.propose'],
    homeOrgUnitId: scene.units.Development!,
    ...overrides,
  };
}
