import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError, type EmployeeProfile, type Task, type TaskInput } from '@claude-company/contracts';
import { prepareDatabase, seedDatabase, startInfra, type StartedInfra } from '../support/containers';
import {
  createFlowHarness,
  managerProfile,
  type FlowHarness,
  type Scene,
} from '../support/flow-harness';

const day = 86_400_000;

/**
 * Contract test cho đề xuất của CEO AI Assistant (FR-047, R14 Decision 5): `TaskEngine.updateDraft`,
 * `OrchestrationEngine.applyTaskProposal` và run `propose` không chiếm slot.
 */
describe('Contract: task nháp và đề xuất của trợ lý (US9)', () => {
  let infra: StartedInfra;
  let h: FlowHarness;

  beforeAll(async () => {
    infra = await startInfra({ redis: false });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    h = await createFlowHarness({ infra });
  });

  afterAll(async () => {
    await h?.close();
    await infra?.stop();
  });

  const rejectsWith = async (promise: Promise<unknown>, code: string, status?: number) => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    if (status) expect((error as DomainError).httpStatus).toBe(status);
  };

  async function setup(): Promise<{ scene: Scene; assistant: EmployeeProfile }> {
    const scene = await h.newScene();
    const assistant = await h.employees.create(scene.humanCtx(scene.ceo.memberId), {
      name: 'CEO AI Assistant',
      avatarKey: 'manager',
      position: 'CEO AI Assistant',
      homeOrgUnitId: null,
      kind: 'employee',
      roleTemplateKey: 'ceo_assistant',
      personality: '',
      skills: [],
      seniority: 'senior',
      modelId: 'claude-opus-5-5',
      runtimeKind: 'messages_api',
      systemPrompt: 'Bạn là trợ lý của CEO.',
      toolGrants: ['company.query', 'artifact.publish', 'task.message.post'],
      workspaceId: null,
      manager: { kind: 'human', id: scene.ceo.memberId },
      maxConcurrentTasks: 2,
    });
    return { scene, assistant };
  }

  const draftInput = (assistant: EmployeeProfile, overrides: Partial<TaskInput> = {}): TaskInput => ({
    title: 'Yêu cầu của CEO',
    objective: 'Tổng hợp tình hình công ty',
    assignee: { kind: 'ai_employee', id: assistant.id },
    deadline: new Date(Date.now() + 3 * day).toISOString(),
    priority: 'medium',
    acceptanceCriteria: ['Nộp báo cáo artifact nêu thao tác đã thực hiện và kết quả'],
    expectedOutput: 'Báo cáo',
    ...overrides,
  });

  const pendingTask = async (scene: Scene, assistant: EmployeeProfile): Promise<Task> =>
    h.tasks.create(scene.humanCtx(scene.ceo.memberId), { ...draftInput(assistant), proposalStatus: 'pending' });

  const proposal = (overrides: Record<string, unknown> = {}) => ({
    title: 'Báo cáo tuần',
    acceptanceCriteria: ['Có số liệu tuần này', 'Nêu điểm nghẽn'],
    expectedOutput: 'Báo cáo tuần dạng markdown',
    deadline: new Date(Date.now() + 2 * day).toISOString(),
    priority: 'high' as const,
    ...overrides,
  });

  it('updateDraft chỉ nhận task draft và các trường cho phép; vẫn giữ TASK_FIELDS_REQUIRED', async () => {
    const { scene, assistant } = await setup();
    const ctx = scene.humanCtx(scene.ceo.memberId);
    const task = await h.tasks.create(ctx, draftInput(assistant));
    expect(task.proposalStatus).toBeNull();

    const updated = await h.tasks.updateDraft(ctx, task.id, {
      title: 'Tiêu đề mới',
      acceptanceCriteria: ['Một', 'Hai'],
      priority: 'urgent',
      tokenCap: 1000,
      costCap: 1.5,
    });
    expect(updated.title).toBe('Tiêu đề mới');
    expect(updated.acceptanceCriteria.map((c) => c.text)).toEqual(['Một', 'Hai']);
    expect(updated.priority).toBe('urgent');
    expect(updated.tokenCap).toBe(1000);
    expect(updated.costCap).toBe(1.5);

    // Trường ngoài danh sách (status, assignee…) hoặc giá trị rỗng → TASK_FIELDS_REQUIRED.
    await rejectsWith(h.tasks.updateDraft(ctx, task.id, { status: 'completed' } as never), 'TASK_FIELDS_REQUIRED', 422);
    await rejectsWith(h.tasks.updateDraft(ctx, task.id, { acceptanceCriteria: [] }), 'TASK_FIELDS_REQUIRED', 422);
    await rejectsWith(h.tasks.updateDraft(ctx, task.id, { title: '   ' }), 'TASK_FIELDS_REQUIRED', 422);
    await rejectsWith(h.tasks.updateDraft(ctx, task.id, {}), 'TASK_FIELDS_REQUIRED', 422);

    // Task đã rời draft → TASK_NOT_DRAFT.
    await h.tasks.transition(ctx, task.id, 'assign');
    await rejectsWith(h.tasks.updateDraft(ctx, task.id, { title: 'Không được' }), 'TASK_NOT_DRAFT', 409);
  });

  it('proposalStatus=pending chặn assign và sửa của người dùng nhưng không chặn kết quả của run propose', async () => {
    const { scene, assistant } = await setup();
    const ctx = scene.humanCtx(scene.ceo.memberId);
    const task = await pendingTask(scene, assistant);
    expect(task.proposalStatus).toBe('pending');

    await rejectsWith(h.tasks.transition(ctx, task.id, 'assign'), 'PROPOSAL_PENDING', 409);
    await rejectsWith(h.tasks.updateDraft(ctx, task.id, { title: 'Người dùng sửa' }), 'PROPOSAL_PENDING', 409);
    // Người dùng không tự đặt được trạng thái đề xuất.
    await rejectsWith(
      h.tasks.updateDraft(ctx, task.id, { title: 'x' }, { proposalStatus: 'ready' }),
      'FORBIDDEN',
      403,
    );

    const ai = scene.ctx({ kind: 'ai', employeeId: assistant.id, runId: '00000000-0000-4000-8000-000000000001' });
    const applied = await h.tasks.updateDraft(ai, task.id, { title: 'Đề xuất' }, { proposalStatus: 'ready' });
    expect(applied.proposalStatus).toBe('ready');
    // Sau `ready`, CEO sửa và giao được.
    await h.tasks.updateDraft(ctx, task.id, { title: 'CEO chỉnh' });
    const assigned = await h.tasks.transition(ctx, task.id, 'assign');
    expect(assigned.status).toBe('assigned');
    expect(assigned.title).toBe('CEO chỉnh');
  });

  it('applyTaskProposal: hợp lệ → ready, task vẫn draft; sai hoặc hết retry → failed, CEO vẫn sửa tay được', async () => {
    const { scene, assistant } = await setup();
    const ctx = scene.humanCtx(scene.ceo.memberId);
    const ai = scene.ctx({ kind: 'ai', employeeId: assistant.id, runId: '00000000-0000-4000-8000-000000000002' });

    const ok = await pendingTask(scene, assistant);
    await h.orchestration.applyTaskProposal(ai, ok.id, proposal());
    const after = await h.tasks.get(ctx, ok.id);
    expect(after.proposalStatus).toBe('ready');
    expect(after.status).toBe('draft'); // không đổi trạng thái task
    expect(after.title).toBe('Báo cáo tuần');
    expect(after.priority).toBe('high');
    expect(after.acceptanceCriteria).toHaveLength(2);

    const invalids: Array<Record<string, unknown>> = [
      { acceptanceCriteria: [] },
      { deadline: new Date(Date.now() - day).toISOString() },
      { priority: 'khẩn cấp' },
      { title: '' },
    ];
    for (const bad of invalids) {
      const task = await pendingTask(scene, assistant);
      await h.orchestration.applyTaskProposal(ai, task.id, proposal(bad) as never);
      const failed = await h.tasks.get(ctx, task.id);
      expect(failed.proposalStatus).toBe('failed');
      expect(failed.status).toBe('draft');
      expect(failed.title).toBe('Yêu cầu của CEO'); // giá trị tạm không bị ghi đè
      // CEO vẫn sửa tay và giao được.
      await h.tasks.updateDraft(ctx, task.id, { title: 'Sửa tay' });
      expect((await h.tasks.transition(ctx, task.id, 'assign')).status).toBe('assigned');
    }

    const exhausted = await pendingTask(scene, assistant);
    await h.orchestration.applyTaskProposal(ai, exhausted.id, { failed: true, reason: 'Hết lượt thử' });
    expect((await h.tasks.get(ctx, exhausted.id)).proposalStatus).toBe('failed');
  });

  it('enqueueRun propose không chiếm slot max_concurrent_tasks và chỉ dành cho trợ lý với task đang chờ đề xuất', async () => {
    const { scene, assistant } = await setup();
    const task = await pendingTask(scene, assistant);
    const ctx = scene.humanCtx(scene.ceo.memberId);

    await h.orchestration.enqueueRun(ctx, task.id, 'propose');
    expect(await h.employees.getCapacity(ctx, assistant.id)).toEqual({ active: 0, max: 2 });
    await h.settle();
    const done = await h.tasks.get(ctx, task.id);
    expect(done.proposalStatus).toBe('ready');
    expect(done.status).toBe('draft');
    expect(await h.employees.getCapacity(ctx, assistant.id)).toEqual({ active: 0, max: 2 });

    // Hết đề xuất đang chờ: không xếp run propose thứ hai.
    await rejectsWith(h.orchestration.enqueueRun(ctx, task.id, 'propose'), 'VALIDATION_FAILED', 422);
    // Không dành cho nhân viên khác.
    const dev = await h.hire(scene);
    const plain = await h.tasks.create(ctx, {
      ...draftInput(assistant),
      assignee: { kind: 'ai_employee', id: dev.id },
      proposalStatus: 'pending',
    });
    await rejectsWith(h.orchestration.enqueueRun(ctx, plain.id, 'propose'), 'VALIDATION_FAILED', 422);
  });

  it('đề xuất sai định dạng của model → proposalStatus=failed (không treo ở pending)', async () => {
    const { scene, assistant } = await setup();
    const ctx = scene.humanCtx(scene.ceo.memberId);
    const task = await h.tasks.create(ctx, {
      ...draftInput(assistant, { objective: 'Yêu cầu lỗi [[fake:proposal=invalid]]' }),
      proposalStatus: 'pending',
    });
    await h.orchestration.enqueueRun(ctx, task.id, 'propose');
    await h.settle();
    const after = await h.tasks.get(ctx, task.id);
    expect(after.proposalStatus).toBe('failed');
    expect(after.status).toBe('draft');
  });

  it('job decompose cho task của trợ lý chỉ chấp nhận mode=confirm; decompose → blocked NO_SUITABLE_ASSIGNEE', async () => {
    const { scene, assistant } = await setup();
    const ctx = scene.humanCtx(scene.ceo.memberId);
    await h.hire(scene, managerProfile(scene));
    await h.hire(scene, { name: 'Dev 2' });

    const confirm = await h.tasks.create(ctx, draftInput(assistant, { objective: 'Việc đơn giản' }));
    await h.tasks.transition(ctx, confirm.id, 'assign');
    await h.settleExcept(['run.start']);
    expect((await h.tasks.get(ctx, confirm.id)).status).not.toBe('blocked');
    expect((await h.tasks.get(ctx, confirm.id)).decompositionPlan?.mode).toBe('confirm');

    const split = await h.tasks.create(ctx, draftInput(assistant, { objective: 'Việc chia nhỏ [[fake:decompose=2]]' }));
    await h.tasks.transition(ctx, split.id, 'assign');
    await h.settleExcept(['run.start']);
    const blocked = await h.tasks.get(ctx, split.id);
    expect(blocked.status).toBe('blocked');
    expect(blocked.blockedReason).toBe('NO_SUITABLE_ASSIGNEE');
    expect(blocked.subtasks).toHaveLength(0);
  });
});
