import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  DomainError,
  type EmployeeProfile,
  type RequestContext,
  type Task,
  type ToolResult,
} from '@claude-company/contracts';
import { withTenant } from '@claude-company/db';
import { domainEvent } from '@claude-company/db/schema/events';
import { aiEmployee } from '@claude-company/db/schema/employee';
import { task as taskTable } from '@claude-company/db/schema/task';
import { DASHBOARD_READER } from '../../apps/api/src/platform/engine-tokens';
import type { DashboardReader } from '../../apps/api/src/platform/usage-budget/dashboard.service';
import { ApprovalRequestGate } from '../../apps/worker/src/runtime/approval-gate';
import type { RunContext } from '../../apps/worker/src/runtime/run-context';
import { ToolBroker } from '../../apps/worker/src/runtime/tool-broker';
import { InternalOpsAdapter } from '../../apps/worker/src/tools/adapters/internal-ops.adapter';
import {
  createCompanyOpsGuards,
  createCompanyOpsHandlers,
  delegatedContext,
  type CompanyOpsDeps,
} from '../../apps/worker/src/tools/company-ops';
import { prepareDatabase, seedDatabase, startInfra, type StartedInfra } from '../support/containers';
import { createFlowHarness, type FlowHarness, type Scene } from '../support/flow-harness';

const day = 86_400_000;

/**
 * Contract test cho `apps/worker/src/tools/company-ops.ts` và `InternalOpsAdapter` (dùng engine thật qua harness):
 * ngữ cảnh thay mặt CEO dựng từ run chứ không từ input (C1, C2), tự nhắm vào chính mình (C3), giới hạn thao tác (C6),
 * `actingVia` trong domain_event và chống lặp (R14 Decision 3, 8).
 */
describe('Contract: company-ops và InternalOpsAdapter (US9)', () => {
  let infra: StartedInfra;
  let h: FlowHarness;
  let deps: CompanyOpsDeps;

  beforeAll(async () => {
    infra = await startInfra({ redis: false });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    h = await createFlowHarness({ infra });
    deps = {
      organization: h.org,
      employees: h.employees,
      tasks: h.tasks,
      budget: h.budget,
      dashboard: h.app.get<DashboardReader>(DASHBOARD_READER, { strict: false }),
      communication: h.communication,
    };
  });

  afterAll(async () => {
    await h?.close();
    await infra?.stop();
  });

  type World = {
    scene: Scene;
    ceo: RequestContext;
    assistant: EmployeeProfile;
    task: Task;
    run: RunContext;
  };

  const brokerFor = (maxWriteOps?: number) =>
    new ToolBroker({
      orchestration: h.orchestration,
      permissions: h.permission,
      tasks: h.tasks,
      handlers: createCompanyOpsHandlers(deps),
      guards: createCompanyOpsGuards(deps),
      humanApproval: new ApprovalRequestGate({
        permissions: h.permission,
        orchestration: h.orchestration,
        tasks: h.tasks,
      }),
      toolTimeoutMs: 15_000,
      maxWriteOpsPerRun: maxWriteOps,
    });

  /** Trợ lý + task yêu cầu của CEO + một run `propose` làm "phương tiện" để có `agent_run` thật cho ledger. */
  async function world(): Promise<World> {
    const scene = await h.newScene();
    const ceo = scene.humanCtx(scene.ceo.memberId);
    const template = (await h.employees.listRoleTemplates()).find((t) => t.key === 'ceo_assistant')!;
    const d = template.defaults;
    const assistant = await h.employees.create(ceo, {
      name: 'CEO AI Assistant',
      avatarKey: d.avatarKey,
      position: d.position,
      homeOrgUnitId: null,
      kind: d.kind,
      roleTemplateKey: template.key,
      personality: d.personality,
      skills: d.skills,
      seniority: d.seniority,
      modelId: d.modelId,
      runtimeKind: d.runtimeKind,
      systemPrompt: d.systemPrompt,
      toolGrants: d.toolGrants,
      workspaceId: null,
      manager: { kind: 'human', id: scene.ceo.memberId },
      maxConcurrentTasks: 2,
    });
    const task = await h.tasks.create(ceo, {
      title: 'Yêu cầu của CEO',
      objective: 'Tạo phòng ban Vận hành và nêu rõ: Báo cáo đủ ba mục',
      assignee: { kind: 'ai_employee', id: assistant.id },
      deadline: new Date(Date.now() + 3 * day).toISOString(),
      priority: 'medium',
      acceptanceCriteria: ['Nộp báo cáo'],
      expectedOutput: 'Báo cáo',
      proposalStatus: 'pending',
    });
    return { scene, ceo, assistant, task, run: await runFor(scene, assistant, task) };
  }

  async function runFor(scene: Scene, employee: EmployeeProfile, task: Task): Promise<RunContext> {
    const { runId } = await h.orchestration.enqueueRun(
      scene.humanCtx(scene.ceo.memberId),
      task.id,
      employee.roleTemplateKey === 'ceo_assistant' ? 'propose' : 'execute',
    );
    return {
      ctx: scene.ctx({ kind: 'ai', employeeId: employee.id, runId }),
      runId,
      taskId: task.id,
      employeeId: employee.id,
      purpose: 'propose',
      reworkCount: 0,
      expectedTaskStatus: task.status,
      state: { locked: false, requiresReview: false },
    };
  }

  const call = (broker: ToolBroker, run: RunContext, name: string, input: unknown): Promise<ToolResult> =>
    broker.invoke(run, { name, input, providerCallId: `c-${Math.random()}` });

  const ledger = async (w: World) => (await h.orchestration.getRun(w.ceo, w.run.runId)).toolInvocations;

  it('delegatedContext dựng actor.via từ run chứ không từ input', async () => {
    const w = await world();
    const ctx = await delegatedContext(w.run, deps);
    expect(ctx.actor).toEqual({
      kind: 'human',
      memberId: w.scene.ceo.memberId,
      via: { employeeId: w.assistant.id, runId: w.run.runId, taskId: w.task.id },
    });
    // Input của model không có đường nào đặt `via`/`memberId`: schema strict chặn.
    const broker = brokerFor();
    const result = await call(broker, w.run, 'org_unit_upsert', {
      name: 'X',
      kind: 'department',
      memberId: 'giả mạo',
      via: { employeeId: 'x' },
    });
    expect(result.status).toBe('error');
  });

  it('điều kiện C1 sai → ASSISTANT_CONTEXT_INVALID và ledger denied', async () => {
    const w = await world();
    const broker = brokerFor();
    const input = { name: 'Phòng C1', kind: 'department' };

    // (a) nhân viên của run không phải ceo_assistant
    const dev = await h.hire(w.scene);
    const devTask = await h.tasks.create(w.ceo, {
      title: 'Việc của dev',
      objective: 'x',
      assignee: { kind: 'ai_employee', id: dev.id },
      deadline: new Date(Date.now() + day).toISOString(),
      priority: 'low',
      acceptanceCriteria: ['x'],
      expectedOutput: 'x',
    });
    // Engine không cho cấp công cụ điều hành cho nhân viên thường; ghi thẳng vào DB để kiểm tra lớp phòng thủ C1.
    await withTenant(w.scene.companyId, (tx) =>
      tx
        .update(aiEmployee)
        .set({ toolGrants: ['org.unit.upsert'], runtimeKind: 'messages_api' })
        .where(eq(aiEmployee.id, dev.id)),
    );
    const devRun = await runFor(w.scene, dev, devTask);
    await expect(delegatedContext(devRun, deps)).rejects.toMatchObject({ code: 'ASSISTANT_CONTEXT_INVALID' });
    const a = await call(broker, devRun, 'org_unit_upsert', input);
    expect(a).toMatchObject({ status: 'denied', code: 'ASSISTANT_CONTEXT_INVALID' });

    // (b) không phải assignee của task của run
    const otherTask = await h.tasks.create(w.ceo, {
      title: 'Việc của dev khác',
      objective: 'x',
      assignee: { kind: 'ai_employee', id: dev.id },
      deadline: new Date(Date.now() + day).toISOString(),
      priority: 'low',
      acceptanceCriteria: ['x'],
      expectedOutput: 'x',
    });
    const b = await call(broker, { ...w.run, taskId: otherTask.id, expectedTaskStatus: 'draft' }, 'org_unit_upsert', input);
    expect(b).toMatchObject({ status: 'denied', code: 'ASSISTANT_CONTEXT_INVALID' });

    // (c) task do người khác CEO tạo
    const manager = await h.addManager(w.scene);
    await withTenant(w.scene.companyId, (tx) =>
      tx.update(taskTable).set({ createdByMemberId: manager.memberId }).where(eq(taskTable.id, w.task.id)),
    );
    const c = await call(broker, w.run, 'org_unit_upsert', input);
    expect(c).toMatchObject({ status: 'denied', code: 'ASSISTANT_CONTEXT_INVALID' });
    await withTenant(w.scene.companyId, (tx) =>
      tx.update(taskTable).set({ createdByMemberId: w.scene.ceo.memberId }).where(eq(taskTable.id, w.task.id)),
    );

    // (d) trợ lý đang tạm ngưng
    await h.employees.suspend(w.ceo, w.assistant.id);
    // Bị từ chối (Permission Engine coi nhân viên tạm ngưng là restricted, hoặc guard C1), không thực hiện thay đổi nào.
    expect((await call(broker, w.run, 'org_unit_upsert', { ...input, name: 'Phòng C1 (d)' })).status).toBe('denied');

    const denied = (await ledger(w)).filter((i) => i.status === 'denied');
    expect(denied.length).toBeGreaterThanOrEqual(3);
    expect(denied.every((i) => i.actionType === 'org.unit.upsert')).toBe(true);
    // Không có đơn vị nào được tạo.
    const units = (await h.org.getOrgChart(w.scene.ctx())).roots;
    expect(JSON.stringify(units)).not.toContain('Phòng C1');
  });

  it('C3: ASSISTANT_SELF_TARGET cho employee.update|suspend|archive và task.cancel nhắm vào chính trợ lý', async () => {
    const w = await world();
    const broker = brokerFor();
    const cases: Array<[string, unknown, string]> = [
      ['employee_update', { employeeId: w.assistant.id, name: 'Tự sửa' }, 'employee.update'],
      ['employee_suspend', { employeeId: w.assistant.id }, 'employee.suspend'],
      ['employee_archive', { employeeId: w.assistant.id }, 'employee.archive'],
      ['task_cancel', { taskId: w.task.id, reason: 'tự hủy' }, 'task.cancel'],
    ];
    for (const [tool, input, action] of cases) {
      const result = await call(broker, w.run, tool, input);
      expect(result, tool).toMatchObject({ status: 'denied', code: 'ASSISTANT_SELF_TARGET' });
      expect((await ledger(w)).some((i) => i.actionType === action && i.status === 'denied'), action).toBe(true);
    }
    // Không có yêu cầu phê duyệt nào được tạo cho hành động nhắm vào chính trợ lý.
    expect((await h.permission.listApprovals(w.ceo, { taskId: w.task.id, limit: 20 })).items).toHaveLength(0);
    expect((await h.employees.get(w.ceo, w.assistant.id)).status).toBe('active');
  });

  it('C6: vượt ASSISTANT_MAX_OPS_PER_RUN → run_locked, run bị khóa và đánh dấu blocked', async () => {
    const w = await world();
    const broker = brokerFor(2);
    const make = (n: number) => call(broker, w.run, 'org_unit_upsert', { name: `Đơn vị ${n}`, kind: 'division' });
    expect((await make(1)).status).toBe('ok');
    expect((await make(2)).status).toBe('ok');
    const third = await make(3);
    expect(third.status).toBe('run_locked');
    expect(w.run.state.locked).toBe(true);
    expect(w.run.state.blockedReason).toBe('BUDGET_EXCEEDED');
    // Mọi tool sau đó đều bị khóa, kể cả tool chỉ đọc.
    expect((await call(broker, w.run, 'company_query', { view: 'overview' })).status).toBe('run_locked');
    const names = JSON.stringify((await h.org.getOrgChart(w.scene.ctx())).roots);
    expect(names).toContain('Đơn vị 2');
    expect(names).not.toContain('Đơn vị 3');
  });

  it('domain_event.payload.actingVia có ở mọi thay đổi do trợ lý và vắng ở thao tác của người dùng', async () => {
    const w = await world();
    const broker = brokerFor();
    const made = await call(broker, w.run, 'org_unit_upsert', { name: 'Phòng do trợ lý', kind: 'department' });
    expect(made.status).toBe('ok');
    const own = await h.org.upsertOrgUnit(w.ceo, { kind: 'department', name: 'Phòng do CEO' });

    const events = await withTenant(w.scene.companyId, (tx) =>
      tx.select().from(domainEvent).where(eq(domainEvent.companyId, w.scene.companyId)),
    );
    const byAssistant = events.filter(
      (e) => e.type === 'org_unit.created' && (e.payload as { name?: string }).name === 'Phòng do trợ lý',
    );
    expect(byAssistant.length).toBeGreaterThan(0);
    for (const e of byAssistant) {
      expect((e.payload as { actingVia?: unknown }).actingVia).toEqual({
        employeeId: w.assistant.id,
        runId: w.run.runId,
        taskId: w.task.id,
      });
    }
    const byCeo = events.filter((e) => e.aggregateId === own.id);
    expect(byCeo.length).toBeGreaterThan(0);
    expect(byCeo.every((e) => !('actingVia' in (e.payload as object)))).toBe(true);
  });

  it('lời gọi lặp (resume, retry) nhóm dedupe không tạo trùng đơn vị, nhân viên hay task', async () => {
    const w = await world();
    const broker = brokerFor();
    const deadline = new Date(Date.now() + day).toISOString(); // cố định để input (và hash dedupe) không đổi giữa các lần gọi
    const unit = (await call(broker, w.run, 'org_unit_upsert', { name: 'Vận hành', kind: 'department' })) as ToolResult;
    expect(unit.status).toBe('ok');
    const unitId = (unit.output as { orgUnitId: string }).orgUnitId;

    for (let i = 0; i < 3; i += 1) {
      expect((await call(broker, w.run, 'org_unit_upsert', { name: 'Vận hành', kind: 'department' })).status).toBe('ok');
      expect(
        (await call(broker, w.run, 'employee_create', { roleTemplateKey: 'ai_developer', name: 'Dev A', homeOrgUnitId: unitId })).status,
      ).toBe('ok');
      expect(
        (
          await call(broker, w.run, 'task_create', {
            title: 'Việc A',
            objective: 'Làm việc A',
            assignee: { kind: 'org_unit', id: unitId },
            deadline,
            priority: 'medium',
            expectedOutput: 'Kết quả',
            acceptanceCriteria: [{ text: 'Báo cáo đủ ba mục', source: 'ceo_quote' }],
          })
        ).status,
      ).toBe('ok');
    }
    const chart = JSON.stringify((await h.org.getOrgChart(w.scene.ctx())).roots);
    expect(chart.match(/Vận hành/g)).toHaveLength(1);
    const devs = (await h.employees.list(w.ceo, {})).filter((e) => e.name === 'Dev A');
    expect(devs).toHaveLength(1);
    expect(devs[0]?.runtimeKind).toBe('claude_agent_sdk'); // lấy từ mẫu, không từ model
    const tasks = (await h.tasks.list(w.ceo, { rootOnly: true })).items.filter((t) => t.title === 'Việc A');
    expect(tasks).toHaveLength(1);
    // Tiêu chí trích đúng lời CEO (có trong objective của task trợ lý) → giao ngay, người giao là CEO.
    expect(tasks[0]).toMatchObject({
      status: 'assigned',
      createdByMemberId: w.scene.ceo.memberId,
      assignedByAiEmployeeId: w.assistant.id,
    });
  });

  it('InternalOpsAdapter: chỉ thực thi payload đã khớp, lookup coi đối tượng đã lưu trữ hoặc hủy là succeeded', async () => {
    const w = await world();
    const adapter = new InternalOpsAdapter(() => ({ organization: h.org, employees: h.employees, tasks: h.tasks }));
    const dev = await h.hire(w.scene);
    const unit = await h.org.upsertOrgUnit(w.ceo, { kind: 'department', name: 'Sẽ lưu trữ' });
    const doomed = await h.tasks.create(w.ceo, {
      title: 'Sẽ hủy',
      objective: 'x',
      assignee: { kind: 'ai_employee', id: dev.id },
      deadline: new Date(Date.now() + day).toISOString(),
      priority: 'low',
      acceptanceCriteria: ['x'],
      expectedOutput: 'x',
    });
    const context = (actionType: string) => ({
      companyId: w.scene.companyId,
      traceId: 't',
      actionType,
      approverMemberId: w.scene.ceo.memberId,
      employeeId: w.assistant.id,
      runId: w.run.runId,
      taskId: w.task.id,
    });

    // Chưa làm gì: lookup → not_found; thiếu ngữ cảnh người duyệt → không thực thi.
    const archiveUnit = { targetKind: 'org_unit', targetId: unit.id };
    expect(await adapter.lookup('k1', { ...context('org.archive'), input: archiveUnit })).toBe('not_found');
    expect((await adapter.execute(archiveUnit, 'k1')).status).toBe('error');

    expect(adapter.mode).toBe('internal');
    expect((await adapter.execute(archiveUnit, 'k1', context('org.archive'))).status).toBe('ok');
    expect(await adapter.lookup('k1', { ...context('org.archive'), input: archiveUnit })).toBe('succeeded');
    // Chạy lại cùng payload (job giao lại) vẫn ok, không lỗi.
    expect((await adapter.execute(archiveUnit, 'k1', context('org.archive'))).status).toBe('ok');

    const archiveEmployee = { employeeId: dev.id };
    await h.tasks.transition(w.ceo, doomed.id, 'cancel'); // dev hết việc mở
    expect(await adapter.lookup('k2', { ...context('employee.archive'), input: archiveEmployee })).toBe('not_found');
    expect((await adapter.execute(archiveEmployee, 'k2', context('employee.archive'))).status).toBe('ok');
    expect(await adapter.lookup('k2', { ...context('employee.archive'), input: archiveEmployee })).toBe('succeeded');

    const cancelTask = { taskId: doomed.id, reason: 'Theo CEO' };
    expect(await adapter.lookup('k3', { ...context('task.cancel'), input: cancelTask })).toBe('succeeded'); // đã cancelled

    // Lưu trữ vẫn bị chặn nếu còn nhân viên/task (ORG_UNIT_NOT_EMPTY) và lỗi được trả về, không nuốt.
    const busyUnit = await h.org.upsertOrgUnit(w.ceo, { kind: 'department', name: 'Còn người' });
    await h.hire(w.scene, { homeOrgUnitId: busyUnit.id, name: 'Người ở lại' });
    const blocked = await adapter.execute({ targetKind: 'org_unit', targetId: busyUnit.id }, 'k4', context('org.archive'));
    expect(blocked.status).toBe('error');
    expect(blocked.message).toContain('ORG_UNIT_NOT_EMPTY');
    expect(await adapter.lookup('k4', { ...context('org.archive'), input: { targetKind: 'org_unit', targetId: busyUnit.id } })).toBe('not_found');
    expect(new DomainError('FORBIDDEN').code).toBe('FORBIDDEN');
  });
});
