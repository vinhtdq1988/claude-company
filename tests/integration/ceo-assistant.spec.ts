import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@claude-company/contracts';
import { assistantCompany, rootTasks, runRequest, sendRequest } from '../support/assistant-fixtures';
import { prepareDatabase, seedDatabase, startInfra, type StartedInfra } from '../support/containers';
import { createFlowHarness, type FlowHarness } from '../support/flow-harness';

/**
 * Luồng CEO AI Assistant từ đầu đến cuối với engine thật và `MODEL_PROVIDER=fake` (US9-AS1, AS2, AS3, AS4, AS8; FR-046–
 * FR-048, R14 Decision 5, 6): tạo trợ lý → yêu cầu → đề xuất → CEO xác nhận → AI Manager xác nhận → trợ lý chạy → review
 * độc lập → CEO phê duyệt. Trợ lý không bao giờ là reviewer và không tự chọn người nhận việc.
 */
describe('Integration: CEO AI Assistant (US9)', () => {
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

  const rejectsWith = async (promise: Promise<unknown>, code: string) => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  };

  it('AS1: tạo trợ lý từ mẫu (hồ sơ điền sẵn, manager là CEO); tạo lần hai bị chặn', async () => {
    const c = await assistantCompany(h);
    expect(c.assistant).toMatchObject({
      roleTemplateKey: 'ceo_assistant',
      kind: 'employee',
      runtimeKind: 'messages_api',
      homeOrgUnitId: null,
      manager: { kind: 'human', id: c.scene.ceo.memberId },
      status: 'active',
    });
    expect(c.assistant.toolGrants).toContain('company.query');
    expect(c.assistant.toolGrants.some((g) => g.startsWith('workspace.'))).toBe(false);

    const state = await h.employees.getCeoAssistant(c.ceo);
    expect(state?.id).toBe(c.assistant.id);
    await rejectsWith(
      h.employees.create(c.ceo, { ...c.assistant, manager: c.assistant.manager } as never),
      'CEO_ASSISTANT_EXISTS',
    );
  });

  it('AS2: yêu cầu → task draft pending → ready sau run propose; assign khi pending bị chặn; CEO sửa rồi giao', async () => {
    const c = await assistantCompany(h);
    const request = await sendRequest(h, c, 'Tổng hợp tình hình công ty tuần này');
    expect(request).toMatchObject({
      status: 'draft',
      proposalStatus: 'pending',
      assigneeKind: 'ai_employee',
      assigneeId: c.assistant.id,
      createdByMemberId: c.scene.ceo.memberId,
      objective: 'Tổng hợp tình hình công ty tuần này',
    });
    // Trong lúc `pending`, giao nhầm giá trị tạm bị chặn (409 PROPOSAL_PENDING).
    await rejectsWith(h.tasks.transition(c.ceo, request.id, 'assign'), 'PROPOSAL_PENDING');

    await h.settle(); // run propose
    const ready = await h.tasks.get(c.ceo, request.id);
    expect(ready.proposalStatus).toBe('ready');
    expect(ready.status).toBe('draft');
    expect(ready.acceptanceCriteria.length).toBeGreaterThanOrEqual(1);
    expect(new Date(ready.deadline).getTime()).toBeGreaterThan(Date.now());
    expect(ready.assignedByEmployee ?? null).toBeNull(); // trợ lý chưa tạo task nào thay CEO ở đây

    // CEO chỉnh qua updateDraft (PATCH) rồi giao: từ đây task đi đúng đường chung.
    await h.tasks.updateDraft(c.ceo, request.id, { title: 'Báo cáo tình hình tuần' });
    await h.tasks.transition(c.ceo, request.id, 'assign');
    await h.settle();

    const done = await h.tasks.get(c.ceo, request.id);
    expect(done.title).toBe('Báo cáo tình hình tuần');
    expect(done.status).toBe('awaiting_human_approval');
    expect(done.decomposedByEmployeeId).toBe(c.manager.id); // AI Manager xác nhận
    expect(done.artifacts.length).toBeGreaterThanOrEqual(1); // trợ lý nộp artifact
    // Review do AI Manager độc lập thực hiện; trợ lý không bao giờ là reviewer.
    const aiReviews = done.reviews.filter((r) => r.stage === 'ai_review');
    expect(aiReviews.length).toBeGreaterThanOrEqual(1);
    expect(aiReviews.every((r) => r.reviewerId === c.manager.id && r.reviewerId !== c.assistant.id)).toBe(true);
    expect(done.evidence.every((e) => e.reviewerId !== c.assistant.id)).toBe(true);

    // CEO phê duyệt cuối cùng: trợ lý không tự duyệt kết quả của mình.
    const approved = await h.tasks.recordDecision(c.ceo, request.id, { decision: 'approve', reason: 'Đạt' });
    expect(approved.status).toBe('completed');
  });

  it('AS3: giao việc cho Team với tiêu chí trích nguyên văn lời CEO → task assigned ngay, AI Manager phân rã', async () => {
    const c = await assistantCompany(h);
    const goal =
      `Giao cho Dev Team: làm báo cáo. Tiêu chí: Báo cáo đủ ba mục. ` +
      `[[fake:task_create=${c.teamId};assignee_kind=team;criterion=Báo cáo đủ ba mục;child_decompose=1;task_title=Việc cho Dev Team]]`;
    await runRequest(h, c, goal);

    const created = (await rootTasks(h, c)).find((t) => t.title === 'Việc cho Dev Team');
    expect(created).toBeDefined();
    expect(created).toMatchObject({
      createdByMemberId: c.scene.ceo.memberId, // người giao vẫn là CEO
      assignedByAiEmployeeId: c.assistant.id, // trợ lý ghi nhận riêng (SC-014)
      assigneeKind: 'team',
      assigneeId: c.teamId,
    });
    expect(created!.status).not.toBe('draft'); // đã giao ngay
    const detail = await h.tasks.get(c.ceo, created!.id);
    expect(detail.assignedByEmployee).toEqual({ id: c.assistant.id, name: c.assistant.name });
    // AI Manager phân rã theo FR-016; trợ lý không tự chọn assignee của task con.
    expect(detail.decompositionPlan?.mode).toBe('decompose');
    expect(detail.decomposedByEmployeeId).toBe(c.manager.id);
    expect(detail.subtasks.length).toBeGreaterThanOrEqual(1);
    expect(detail.subtasks.every((s) => s.assigneeId !== c.assistant.id)).toBe(true);
    expect(detail.subtasks.every((s) => s.createdByMemberId === c.scene.ceo.memberId)).toBe(true);

    // Task gốc do trợ lý tạo được đếm như task gốc thường ở Dashboard/thống kê.
    const stats = await h.tasks.getStats(c.ceo, {});
    expect(stats.activeTasks).toBeGreaterThanOrEqual(1);
    expect((await rootTasks(h, c)).some((t) => t.id === created!.id)).toBe(true);
  });

  it('AS4: tiêu chí do trợ lý đề xuất hoặc diễn đạt lại → task ở draft chờ CEO; không tự giao', async () => {
    const c = await assistantCompany(h);
    await runRequest(
      h,
      c,
      `Tạo việc cho Dev Team. [[fake:task_create=${c.teamId};assignee_kind=team;criterion=Có kiểm thử đầy đủ;source=proposed;task_title=Việc đề xuất]]`,
    );
    await runRequest(
      h,
      c,
      `Tạo việc khác cho Dev Team. [[fake:task_create=${c.teamId};assignee_kind=team;criterion=Có tài liệu;lie=1;task_title=Việc diễn đạt lại]]`,
    );
    const tasks = await rootTasks(h, c);
    for (const title of ['Việc đề xuất', 'Việc diễn đạt lại']) {
      const task = tasks.find((t) => t.title === title);
      expect(task, title).toBeDefined();
      expect(task).toMatchObject({ status: 'draft', assignedByAiEmployeeId: c.assistant.id });
    }
  });

  it('AS8: yêu cầu chưa rõ → trợ lý hỏi lại bằng task_message và không thay đổi dữ liệu', async () => {
    const c = await assistantCompany(h);
    const before = (await h.employees.list(c.ceo, {})).length;
    const unitsBefore = JSON.stringify((await h.org.getOrgChart(c.scene.ctx())).roots);
    const task = await runRequest(h, c, 'Làm cho công ty tốt hơn [[fake:ask=Bạn muốn cải thiện mảng nào và theo tiêu chí nào?]]');

    const messages = await h.communication.listTaskMessages(c.ceo, task.id);
    expect(messages.some((m) => m.authorKind === 'ai' && m.body.includes('Bạn muốn cải thiện mảng nào'))).toBe(true);
    expect((await h.employees.list(c.ceo, {})).length).toBe(before);
    expect(JSON.stringify((await h.org.getOrgChart(c.scene.ctx())).roots)).toBe(unitsBefore);
    const ops = await h.orchestration.listOperations(c.ceo, task.id);
    expect(ops.filter((o) => o.actionType !== 'company.query' && o.status === 'succeeded')).toHaveLength(0);
  });

  it('hủy task yêu cầu không hủy task trợ lý đã tạo', async () => {
    const c = await assistantCompany(h);
    const request = await runRequest(
      h,
      c,
      `Tạo việc cho Dev Team. [[fake:task_create=${c.teamId};assignee_kind=team;criterion=Báo cáo đủ ba mục;child_decompose=1;task_title=Việc con độc lập]]`,
    );
    const child = (await rootTasks(h, c)).find((t) => t.title === 'Việc con độc lập')!;
    expect(child).toBeDefined();

    const cancelled = await h.tasks.transition(c.ceo, request.id, 'cancel');
    expect(cancelled.status).toBe('cancelled');
    await h.settle();
    const after = await h.tasks.get(c.ceo, child.id);
    expect(after.status).not.toBe('cancelled');
  });

  it('yêu cầu khi chưa có trợ lý đang hoạt động → CEO_ASSISTANT_REQUIRED; goal rỗng → TASK_FIELDS_REQUIRED', async () => {
    const c = await assistantCompany(h);
    await rejectsWith(sendRequest(h, c, '   '), 'TASK_FIELDS_REQUIRED');

    await h.employees.suspend(c.ceo, c.assistant.id);
    await rejectsWith(sendRequest(h, c, 'Làm gì đó'), 'CEO_ASSISTANT_REQUIRED');
    await h.employees.resume(c.ceo, c.assistant.id);
    expect((await sendRequest(h, c, 'Làm gì đó')).proposalStatus).toBe('pending');

    const scene2 = await h.newScene(); // công ty chưa có trợ lý
    const none = { ...c, scene: scene2, ceo: scene2.humanCtx(scene2.ceo.memberId) };
    await rejectsWith(sendRequest(h, none, 'Làm gì đó'), 'CEO_ASSISTANT_REQUIRED');
  });
});
