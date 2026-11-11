import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import {
  createAssistantRequestSchema,
  DomainError,
  type CeoAssistantState,
  type EmployeeEngine,
  type OrchestrationEngine,
  type RequestContext,
  type Task,
  type TaskEngine,
} from '@claude-company/contracts';
import type { AppConfig } from '../../platform/config/config';
import { CONFIG } from '../../platform/config/infra.providers';
import {
  EMPLOYEE_ENGINE,
  ORCHESTRATION_ENGINE,
  TASK_ENGINE,
} from '../../platform/engine-tokens';
import { Ctx } from '../../platform/tenancy/ctx.decorator';
import { RequireScope } from '../../platform/tenancy/scope.decorators';

/** Tiêu chí chung của task yêu cầu trước khi trợ lý đề xuất tiêu chí thật (R14 Decision 5). */
const PLACEHOLDER_CRITERION = 'Nộp báo cáo artifact nêu thao tác đã thực hiện và kết quả';
const PLACEHOLDER_OUTPUT = 'Báo cáo artifact nêu thao tác đã thực hiện và kết quả';
const TITLE_PREVIEW_MAX = 80;

/**
 * Mục CEO AI Assistant của contracts/rest-api.md (US9). Chỉ CEO (quyền cấp công ty `employee.manage`): Manager thường
 * nhận `403`. Controller chỉ gọi interface của Employee, Task và Orchestration Engine, không có đường quyền riêng.
 */
@Controller('companies/:companyId/ceo-assistant')
export class CeoAssistantController {
  constructor(
    @Inject(EMPLOYEE_ENGINE) private readonly employees: Pick<EmployeeEngine, 'getCeoAssistant'>,
    @Inject(TASK_ENGINE) private readonly tasks: Pick<TaskEngine, 'create' | 'updateDraft'>,
    @Inject(ORCHESTRATION_ENGINE)
    private readonly orchestration: Pick<OrchestrationEngine, 'enqueueRun' | 'applyTaskProposal'>,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  @RequireScope('employee.manage')
  async state(@Ctx() ctx: RequestContext): Promise<CeoAssistantState> {
    const assistant = await this.employees.getCeoAssistant(ctx);
    return { assistant, canCreate: assistant === null };
  }

  /**
   * Tạo task `draft` giao cho trợ lý với giá trị tạm, đặt `proposal_status = pending` rồi xếp run `propose`.
   * Người giao là CEO; hệ thống (không phải người dùng) điền tiêu chí và deadline tạm để thỏa ràng buộc đủ trường.
   */
  @Post('requests')
  @HttpCode(201)
  @RequireScope('employee.manage')
  async createRequest(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<Task> {
    const parsed = createAssistantRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError('TASK_FIELDS_REQUIRED', 'Yêu cầu gửi trợ lý phải có nội dung (goal)', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const { goal, priority, deadline } = parsed.data;
    const assistant = await this.employees.getCeoAssistant(ctx);
    if (!assistant || assistant.status !== 'active') {
      throw new DomainError(
        'CEO_ASSISTANT_REQUIRED',
        'Chưa có CEO AI Assistant đang hoạt động để nhận yêu cầu',
        { assistantStatus: assistant?.status ?? null },
      );
    }

    const task = await this.tasks.create(ctx, {
      title: goal.length > TITLE_PREVIEW_MAX ? `${goal.slice(0, TITLE_PREVIEW_MAX - 1)}…` : goal,
      objective: goal,
      assignee: { kind: 'ai_employee', id: assistant.id },
      deadline:
        deadline ??
        new Date(Date.now() + this.config.ASSISTANT_DEFAULT_DEADLINE_HOURS * 3_600_000).toISOString(),
      priority: priority ?? 'medium',
      acceptanceCriteria: [PLACEHOLDER_CRITERION],
      expectedOutput: PLACEHOLDER_OUTPUT,
      proposalStatus: 'pending',
    });
    try {
      await this.orchestration.enqueueRun(ctx, task.id, 'propose');
    } catch (error) {
      // Không xếp được run đề xuất: đánh dấu `failed` để CEO sửa tay thay vì treo ở `pending`.
      await this.orchestration
        .applyTaskProposal({ ...ctx, actor: { kind: 'system' } }, task.id, {
          failed: true,
          reason: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      throw error;
    }
    return { ...task, proposalStatus: 'pending' };
  }
}
