import { CEO_ASSISTANT_TEMPLATE_KEY } from '@claude-company/contracts';
import { renderInput } from '@claude-company/model-gateway';
import type {
  EmployeeEngine,
  MemoryEngine,
  CommunicationEngine,
  OrganizationEngine,
  RequestContext,
  RunPurpose,
  Task,
  TaskDetail,
  TaskEngine,
} from '@claude-company/contracts';

export type ArtifactView = {
  id: string;
  title: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  content?: string;
  /** `true` khi nội dung đã bị cắt vì vượt `ARTIFACT_CONTEXT_MAX_BYTES`. */
  truncated?: boolean;
  note?: string;
};

const TEXT_MIME = /^(text\/|application\/(json|xml|yaml|x-yaml|markdown))/i;

export const isTextMime = (mime: string): boolean => TEXT_MIME.test(mime);

/**
 * Tổng nội dung artifact của một run không vượt `maxBytes`; artifact vượt phần còn lại bị cắt và gắn nhãn
 * `truncated`; artifact nhị phân chỉ đưa metadata (engine-interfaces.md, "Ngữ cảnh đầu vào theo purpose").
 */
export function fitArtifacts(
  items: Array<{ meta: Omit<ArtifactView, 'content' | 'truncated' | 'note'>; body: Buffer | null }>,
  maxBytes: number,
): ArtifactView[] {
  let remaining = maxBytes;
  return items.map(({ meta, body }) => {
    if (!isTextMime(meta.mimeType) || body === null) {
      return { ...meta, note: 'Artifact nhị phân hoặc không đọc được: chỉ có metadata' };
    }
    if (remaining <= 0) {
      return { ...meta, truncated: true, content: '', note: 'Hết dung lượng ngữ cảnh cho artifact' };
    }
    if (body.length <= remaining) {
      remaining -= body.length;
      return { ...meta, content: body.toString('utf8') };
    }
    const content = body.subarray(0, remaining).toString('utf8');
    remaining = 0;
    return { ...meta, truncated: true, content };
  });
}

export type InputBuilderDeps = {
  tasks: TaskEngine;
  employees: Pick<EmployeeEngine, 'list' | 'getCapacity'>;
  organization: Pick<OrganizationEngine, 'resolveManagedScope' | 'getOrgChart'>;
  memory: MemoryEngine;
  communication: Pick<CommunicationEngine, 'listTaskMessages'>;
  artifactContextMaxBytes: number;
};

const MEMORY_LIMIT = 5;
const MESSAGE_LIMIT = 20;

/** Lý do các vòng rework/reject trước, theo thứ tự thời gian. */
export function reworkReasons(task: Pick<TaskDetail, 'reviews'>): string[] {
  return task.reviews
    .filter((r) => r.decision === 'rework' || r.decision === 'reject')
    .map((r) => `[${r.stage}/${r.decision}] ${r.reason}`);
}

const INSTRUCTIONS: Record<RunPurpose, string> = {
  execute:
    'Hoàn thành task bên dưới bằng các tool bạn được cấp. Khi xong, nộp kết quả bằng tool artifact_publish ' +
    '(đây là cách duy nhất để giao kết quả). Đối chiếu từng tiêu chí nghiệm thu trong kết quả của bạn.',
  decompose:
    'Bạn là AI Manager. Phân tích task và trả về DUY NHẤT một JSON đúng schema kế hoạch phân rã. ' +
    'mode="confirm" (subtasks rỗng) nếu task đã đủ nhỏ để giao nguyên cho người được giao; ' +
    'mode="decompose" nếu cần chia thành task con. assigneeId của task con PHẢI lấy từ danh sách employees. ' +
    'dependsOn là chỉ số (bắt đầu từ 0) của task con khác trong danh sách subtasks.',
  review:
    'Bạn là reviewer độc lập. Với TỪNG tiêu chí nghiệm thu, đối chiếu nội dung artifact và trả về DUY NHẤT một JSON: ' +
    'decision ("pass" chỉ khi MỌI tiêu chí đạt, ngược lại "rework"), reason, và evidence (mỗi tiêu chí một mục: ' +
    'criterionId, verdict "met"|"not_met", explanation). Trả "not_met" kèm giải thích cho tiêu chí không kiểm chứng ' +
    'được từ nội dung nhận được.',
  synthesize:
    'Bạn là AI Manager. Tổng hợp kết quả của các task con thành MỘT artifact cho task cha và nộp bằng tool ' +
    'artifact_publish. Đối chiếu từng tiêu chí nghiệm thu của task cha.',
  propose:
    'Bạn là CEO AI Assistant. Từ yêu cầu của CEO trong task_objective, soạn đề xuất cho task và trả về DUY NHẤT một ' +
    'JSON {title, acceptanceCriteria[], expectedOutput, deadline, priority}. Mỗi tiêu chí nghiệm thu phải kiểm chứng ' +
    'được và bám sát lời CEO; deadline là thời điểm ISO 8601 trong tương lai (ưu tiên deadline CEO đã nêu); priority ' +
    'là low|medium|high|urgent. Chỉ nhắc tới đơn vị, Team, nhân viên có trong dữ liệu. Bước này không có tool nào.',
};

export function systemPromptFor(base: string, purpose: RunPurpose): string {
  return `${base}\n\n${INSTRUCTIONS[purpose]}`;
}

/**
 * Dựng `AgentRunRequest.input` theo "Ngữ cảnh đầu vào theo purpose": mọi nội dung lấy qua interface engine và
 * StorageService, và đều là dữ liệu (xem `renderInput`), không phải chỉ dẫn.
 */
export class InputBuilder {
  constructor(private readonly deps: InputBuilderDeps) {}

  async build(ctx: RequestContext, task: TaskDetail, purpose: RunPurpose, employeeId: string): Promise<string> {
    switch (purpose) {
      case 'execute':
        return this.execute(ctx, task, employeeId);
      case 'decompose':
        return this.decompose(ctx, task);
      case 'review':
        return this.review(ctx, task);
      case 'synthesize':
        return this.synthesize(ctx, task, employeeId);
      case 'propose':
        return this.propose(ctx, task);
    }
  }

  /**
   * Lời CEO, danh sách rút gọn đơn vị/Team/nhân viên đang hoạt động (id, tên, vị trí) và giá trị hiện tại của deadline,
   * priority (do CEO nêu hoặc giá trị tạm của hệ thống). Không có tool; CEO AI Assistant không được đưa vào danh sách.
   */
  private async propose(ctx: RequestContext, task: TaskDetail): Promise<string> {
    // Run `propose` có actor AI nên Organization Engine trả sơ đồ rỗng; đọc bằng ngữ cảnh hệ thống.
    const system: RequestContext = { ...ctx, actor: { kind: 'system' } };
    const [chart, profiles] = await Promise.all([
      this.deps.organization.getOrgChart(system),
      this.deps.employees.list(system, {}),
    ]);
    const units: Array<{ id: string; name: string; kind: string }> = [];
    const teams: Array<{ id: string; name: string; orgUnitId: string }> = [];
    const visit = (nodes: typeof chart.roots) => {
      for (const node of nodes) {
        units.push({ id: node.id, name: node.name, kind: node.kind });
        for (const team of node.teams) teams.push({ id: team.id, name: team.name, orgUnitId: node.id });
        visit(node.children);
      }
    };
    visit(chart.roots);
    return renderInput({
      task_objective: task.objective,
      org_units: units,
      teams,
      employees: profiles
        .filter((p) => p.status === 'active' && p.homeOrgUnitId !== null)
        .map((p) => ({ id: p.id, name: p.name, position: p.position })),
      current_values: {
        now: new Date().toISOString(),
        deadline: task.deadline,
        priority: task.priority,
      },
    });
  }

  private base(task: Task) {
    return {
      task_objective: task.objective,
      acceptance_criteria: task.acceptanceCriteria,
      expected_output: task.expectedOutput,
      review_round: task.reworkCount,
    };
  }

  private async execute(ctx: RequestContext, task: TaskDetail, employeeId: string): Promise<string> {
    const [memory, messages] = await Promise.all([
      this.deps.memory.recall(ctx, { employeeId, taskId: task.id }, MEMORY_LIMIT),
      this.deps.communication.listTaskMessages(ctx, task.id),
    ]);
    return renderInput({
      ...this.base(task),
      memory: memory.map((m) => m.content),
      manager_messages: messages
        .filter((m) => m.authorKind === 'human')
        .slice(-MESSAGE_LIMIT)
        .map((m) => m.body),
      rework_reasons: reworkReasons(task),
    });
  }

  private async decompose(ctx: RequestContext, task: TaskDetail): Promise<string> {
    // Nhân viên `active` trong phạm vi của người giao task (created_by_member_id), kèm kỹ năng và slot.
    const [scope, profiles] = await Promise.all([
      this.deps.organization.resolveManagedScope(ctx, task.createdByMemberId),
      this.deps.employees.list(ctx, {}),
    ]);
    // CEO AI Assistant tự thực hiện yêu cầu của CEO nên không bao giờ là người nhận task con (R10, R14).
    const inScope = profiles.filter(
      (p) =>
        p.status === 'active' &&
        p.roleTemplateKey !== CEO_ASSISTANT_TEMPLATE_KEY &&
        (scope.companyWide || scope.employeeIds.includes(p.id)),
    );
    const employees = await Promise.all(
      inScope.map(async (p) => {
        const capacity = await this.deps.employees.getCapacity(ctx, p.id);
        return {
          id: p.id,
          name: p.name,
          position: p.position,
          kind: p.kind,
          skills: p.skills,
          seniority: p.seniority,
          active: capacity.active,
          max: capacity.max,
        };
      }),
    );
    const { review_round: _ignored, ...rest } = this.base(task);
    return renderInput({ ...rest, employees });
  }

  private async review(ctx: RequestContext, task: TaskDetail): Promise<string> {
    const current = task.artifacts.filter((a) => a.createdAt >= (this.roundStart(task) ?? ''));
    const artifacts = await this.loadArtifacts(ctx, current.length > 0 ? current : task.artifacts);
    return renderInput({
      ...this.base(task),
      artifacts,
      rework_reasons: reworkReasons(task),
    });
  }

  private async synthesize(ctx: RequestContext, task: TaskDetail, _employeeId: string): Promise<string> {
    const children = await Promise.all(task.subtasks.map((s) => this.deps.tasks.get(ctx, s.id)));
    // Tổng dung lượng artifact chia đều cho các task con để không task nào chiếm hết trần.
    const share = Math.max(1, Math.floor(this.deps.artifactContextMaxBytes / Math.max(children.length, 1)));
    const subtaskResults = [];
    for (const child of children) {
      subtaskResults.push({
        title: child.title,
        objective: child.objective,
        review: child.reviews.map((r) => `[${r.stage}/${r.decision}] ${r.reason}`),
        artifacts: await this.loadArtifacts(ctx, child.artifacts, share),
      });
    }
    return renderInput({
      ...this.base(task),
      subtask_results: subtaskResults,
      rework_reasons: reworkReasons(task),
    });
  }

  /** Artifact mới nhất từ lúc vòng hiện tại bắt đầu: bỏ qua kết quả của các vòng đã bị rework. */
  private roundStart(task: TaskDetail): string | undefined {
    const lastRework = [...task.reviews].reverse().find((r) => r.decision === 'rework' || r.decision === 'reject');
    return lastRework?.decidedAt;
  }

  private async loadArtifacts(
    ctx: RequestContext,
    artifacts: TaskDetail['artifacts'],
    maxBytes = this.deps.artifactContextMaxBytes,
  ): Promise<ArtifactView[]> {
    const items = await Promise.all(
      artifacts.map(async (a) => ({
        meta: {
          id: a.id,
          title: a.title,
          kind: a.kind,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
        },
        body: isTextMime(a.mimeType)
          ? await this.deps.tasks
              .readArtifact(ctx, a.id, maxBytes + 1)
              .then((r) => r.content)
              .catch(() => null)
          : null,
      })),
    );
    return fitArtifacts(items, maxBytes);
  }
}
