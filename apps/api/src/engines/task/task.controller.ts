import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  createTaskSchema,
  DomainError,
  TASK_STATUSES,
  taskDecisionSchema,
  taskListQuerySchema,
  taskMessageBodySchema,
  taskTransitionSchema,
  type AppPermission,
  type CommunicationEngine,
  type CreateTaskBody,
  type ExecutedAction,
  type OrchestrationEngine,
  type OrganizationEngine,
  type Page,
  type PermissionEngine,
  type RequestContext,
  type Task,
  type TaskDecisionBody,
  type TaskDetail,
  type TaskEngine,
  type TaskMessage,
  type TaskStatus,
  type TaskTransitionBody,
} from '@claude-company/contracts';
import { withTenant } from '@claude-company/db';
import {
  COMMUNICATION_ENGINE,
  ORCHESTRATION_ENGINE,
  ORGANIZATION_ENGINE,
  PERMISSION_ENGINE,
  TASK_ENGINE,
} from '../../platform/engine-tokens';
import { ZodValidationPipe } from '../../platform/http/zod.pipe';
import { StorageService } from '../../platform/storage/storage.service';
import { Ctx } from '../../platform/tenancy/ctx.decorator';
import { MemberScope, RequireScope } from '../../platform/tenancy/scope.decorators';
import { TaskRepository } from './task.repository';
import { z } from 'zod';

type ListQuery = z.infer<typeof taskListQuerySchema>;

function memberIdOf(ctx: RequestContext): string {
  if (ctx.actor.kind !== 'human') {
    throw new DomainError('FORBIDDEN', 'Chỉ người dùng được truy cập qua API');
  }
  return ctx.actor.memberId;
}

/** Tham số `status` dạng "a,b,c" → danh sách trạng thái hợp lệ. */
function parseStatuses(raw: string | undefined): TaskStatus[] | undefined {
  if (!raw) return undefined;
  const values = raw.split(',').map((s) => s.trim());
  const invalid = values.filter((v) => !(TASK_STATUSES as readonly string[]).includes(v));
  if (invalid.length > 0) {
    throw new DomainError('VALIDATION_FAILED', 'Trạng thái task không hợp lệ', { invalid });
  }
  return values as TaskStatus[];
}

/**
 * Mục Tasks của contracts/rest-api.md. Phạm vi quản lý được cưỡng chế phía server theo assignee của task:
 * tạo task do `TaskEngine.create` kiểm tra (`403 ASSIGNEE_OUT_OF_SCOPE`), các route còn lại gọi
 * `PermissionEngine.authorize` trên assignee của task (`403 FORBIDDEN`).
 */
@Controller('companies/:companyId')
export class TaskController {
  constructor(
    @Inject(TASK_ENGINE) private readonly tasks: TaskEngine,
    @Inject(PERMISSION_ENGINE) private readonly permissions: PermissionEngine,
    @Inject(ORGANIZATION_ENGINE)
    private readonly organization: Pick<OrganizationEngine, 'resolveManagedScope'>,
    @Inject(COMMUNICATION_ENGINE) private readonly communication: CommunicationEngine,
    @Inject(ORCHESTRATION_ENGINE)
    private readonly orchestration: Pick<OrchestrationEngine, 'listExecutedActions'>,
    private readonly repo: TaskRepository,
    private readonly storage: StorageService,
  ) {}

  /** Tải task và kiểm tra quyền trên assignee của nó; ngoài phạm vi → 403. */
  private async authorizeTask(
    ctx: RequestContext,
    permission: AppPermission,
    taskId: string,
  ): Promise<TaskDetail> {
    const task = await this.tasks.get(ctx, taskId);
    await this.permissions.authorize(ctx, permission, {
      kind: task.assigneeKind,
      id: task.assigneeId,
    });
    return task;
  }

  /** Task Board: chỉ task có assignee trong phạm vi của người xem (FR-021, FR-028). */
  @Get('tasks')
  @RequireScope('task.read')
  async list(
    @Ctx() ctx: RequestContext,
    @Query(new ZodValidationPipe(taskListQuerySchema)) query: ListQuery,
  ): Promise<Page<Task>> {
    const scope = await this.organization.resolveManagedScope(ctx, memberIdOf(ctx));
    return this.tasks.list(ctx, {
      statusIn: parseStatuses(query.status),
      assigneeKind: query.assigneeKind,
      assigneeId: query.assigneeId,
      orgUnitId: query.orgUnitId,
      priority: query.priority,
      overdue: query.overdue === undefined ? undefined : query.overdue === 'true',
      deadlineBefore: query.deadlineBefore,
      rootOnly: true,
      scope,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  /**
   * Tạo ở `draft`; `?assign=true` chuyển ngay sang `assigned`. Quyền theo phạm vi do `TaskEngine.create`
   * kiểm tra trên assignee, nên route chỉ cần là thành viên (thiếu trường → `422 TASK_FIELDS_REQUIRED`).
   */
  @Post('tasks')
  @HttpCode(201)
  @MemberScope()
  async create(
    @Ctx() ctx: RequestContext,
    @Body() body: unknown,
    @Query('assign') assign?: string,
  ): Promise<Task> {
    const parsed = createTaskSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError('TASK_FIELDS_REQUIRED', 'Thiếu hoặc sai trường bắt buộc của task', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const created = await this.tasks.create(ctx, parsed.data as CreateTaskBody);
    return assign === 'true' ? this.tasks.transition(ctx, created.id, 'assign') : created;
  }

  @Get('tasks/:id')
  @MemberScope()
  get(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<TaskDetail> {
    return this.authorizeTask(ctx, 'task.read', id);
  }

  /** Chuyển trạng thái do người dùng kích hoạt: `assign`, `cancel`, `resume`. */
  @Post('tasks/:id/transitions')
  @HttpCode(200)
  @MemberScope()
  async transition(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(taskTransitionSchema)) body: TaskTransitionBody,
  ): Promise<Task> {
    await this.authorizeTask(ctx, 'task.manage', id);
    return this.tasks.transition(ctx, id, body.action, { reason: body.reason });
  }

  /** Human Manager quyết định ở `awaiting_human_approval`; `reason` bắt buộc với mọi quyết định. */
  @Post('tasks/:id/decisions')
  @HttpCode(200)
  @MemberScope()
  async decide(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(taskDecisionSchema)) body: TaskDecisionBody,
  ): Promise<Task> {
    await this.authorizeTask(ctx, 'task.decide', id);
    return this.tasks.recordDecision(ctx, id, body);
  }

  @Get('tasks/:id/executed-actions')
  @MemberScope()
  async executedActions(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
  ): Promise<ExecutedAction[]> {
    await this.authorizeTask(ctx, 'task.read', id);
    return this.orchestration.listExecutedActions(ctx, id);
  }

  @Get('tasks/:id/messages')
  @MemberScope()
  async messages(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<TaskMessage[]> {
    await this.authorizeTask(ctx, 'task.read', id);
    return this.communication.listTaskMessages(ctx, id);
  }

  /** Tin nhắn người gửi tới AI được đưa vào run kế tiếp như dữ liệu (FR-022). */
  @Post('tasks/:id/messages')
  @HttpCode(201)
  @MemberScope()
  async postMessage(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(taskMessageBodySchema)) body: { body: string },
  ): Promise<TaskMessage> {
    await this.authorizeTask(ctx, 'task.read', id);
    return this.communication.postTaskMessage(ctx, id, body.body);
  }

  /** Stream nội dung artifact sau khi kiểm tra phạm vi của task chứa nó. */
  @Get('artifacts/:id/content')
  @MemberScope()
  async artifactContent(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
  ): Promise<StreamableFile> {
    const artifact = await withTenant(ctx.companyId, (tx) =>
      this.repo.findArtifact(tx, ctx.companyId, id),
    );
    if (!artifact) throw new DomainError('NOT_FOUND', 'Không tìm thấy artifact');
    await this.authorizeTask(ctx, 'task.read', artifact.taskId);
    return new StreamableFile(await this.storage.getStream(artifact.storageKey), {
      type: artifact.mimeType,
    });
  }
}
