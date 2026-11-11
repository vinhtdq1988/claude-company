import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, withTenant } from '@claude-company/db';
import { agentRun } from '@claude-company/db/schema/orchestration';
import { usageLedger } from '@claude-company/db/schema/usage';
import type { Task, TaskOperation } from '@claude-company/contracts';
import { DASHBOARD_READER } from '../../apps/api/src/platform/engine-tokens';
import { UsageBudgetService } from '../../apps/api/src/platform/usage-budget/budget.service';
import type { DashboardReader } from '../../apps/api/src/platform/usage-budget/dashboard.service';
import {
  assistantBroker,
  assistantCompany,
  assistantRun,
  callTool,
  runRequest,
  sendRequest,
  type AssistantCompany,
} from '../support/assistant-fixtures';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { createFlowHarness, type FlowHarness } from '../support/flow-harness';

const STALE_MS = 10 * 60_000;
const day = 86_400_000;

/**
 * Thao tác điều hành của CEO AI Assistant với engine thật và `MODEL_PROVIDER=fake` (US9-AS5, AS7, các edge case, SC-017;
 * R14 Decision 3, 8): hành động `human_approval` chỉ có hiệu lực sau khi CEO duyệt và chạy qua `InternalOpsAdapter`,
 * thao tác không lặp khi worker restart, số liệu `company.query` khớp `/dashboard` và `/usage`, ngân sách áp dụng cho
 * trợ lý như mọi nhân viên.
 */
describe('Integration: thao tác điều hành của CEO AI Assistant (US9)', () => {
  let infra: StartedInfra;
  let h: FlowHarness;
  let dashboard: DashboardReader;
  let policies: UsageBudgetService;

  beforeAll(async () => {
    infra = await startInfra({ redis: false });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    h = await createFlowHarness({ infra, env: { APPROVAL_REPLAY_AFTER_MS: '0' } });
    dashboard = h.app.get<DashboardReader>(DASHBOARD_READER, { strict: false });
    policies = h.app.get(UsageBudgetService, { strict: false });
  });

  afterAll(async () => {
    await h?.close();
    await infra?.stop();
  });

  // Log dry-run dùng chung trong một harness: tách từng ca để khẳng định "chưa có email nào" không bị ca khác làm nhiễu.
  beforeEach(async () => {
    await h.dryRun.clear();
  });

  const chartText = async (c: AssistantCompany) =>
    JSON.stringify((await h.org.getOrgChart(c.scene.ctx())).roots);
  const operations = (c: AssistantCompany, task: Pick<Task, 'id'>): Promise<TaskOperation[]> =>
    h.orchestration.listOperations(c.ceo, task.id);
  const pending = async (c: AssistantCompany, taskId: string) =>
    (await h.permission.listApprovals(c.scene.ctx(), { status: 'pending', taskId })).items;
  const approve = async (
    c: AssistantCompany,
    approval: { id: string; payloadHash: string },
    reason = 'Đồng ý',
  ) =>
    h.permission.decideApproval(c.ceo, approval.id, {
      decision: 'approve',
      reason,
      payloadHash: approval.payloadHash,
    });
  const executeRun = async (c: AssistantCompany, taskId: string) => {
    const runs = (await h.orchestration.listRuns(c.scene.ctx(), { taskId })).items.filter(
      (r) => r.purpose === 'execute',
    );
    return h.orchestration.getRun(c.scene.ctx(), runs.at(-1)!.id);
  };
  const newTask = (c: AssistantCompany, title: string) =>
    h.tasks.create(c.ceo, {
      title,
      objective: 'x',
      assignee: { kind: 'ai_employee', id: c.dev.id },
      deadline: new Date(Date.now() + day).toISOString(),
      priority: 'low',
      acceptanceCriteria: ['x'],
      expectedOutput: 'x',
    });

  describe('AS5: org.archive, employee.archive, task.cancel cần Human Approval và chạy qua InternalOpsAdapter', () => {
    const cases = [
      {
        action: 'org.archive',
        prepare: async (c: AssistantCompany) => {
          const unit = await h.org.upsertOrgUnit(c.ceo, {
            kind: 'department',
            name: 'Phòng cần lưu trữ',
          });
          return {
            directive: `archive_unit=${unit.id}`,
            applied: async () => !(await chartText(c)).includes('Phòng cần lưu trữ'),
          };
        },
      },
      {
        action: 'employee.archive',
        prepare: async (c: AssistantCompany) => {
          const target = await h.hire(c.scene, {
            name: 'Dev cần lưu trữ',
            manager: { kind: 'human', id: c.scene.ceo.memberId },
          });
          return {
            directive: `archive_employee=${target.id}`,
            applied: async () => (await h.employees.get(c.ceo, target.id)).status === 'archived',
          };
        },
      },
      {
        action: 'task.cancel',
        prepare: async (c: AssistantCompany) => {
          const target = await newTask(c, 'Việc sẽ bị hủy');
          return {
            directive: `cancel_task=${target.id}`,
            applied: async () => (await h.tasks.get(c.ceo, target.id)).status === 'cancelled',
          };
        },
      },
    ];

    it.each(cases)(
      '$action: chưa có thay đổi nào cho đến khi CEO duyệt; duyệt xong mới thực thi thật (internal)',
      async ({ action, prepare }) => {
        const c = await assistantCompany(h);
        const { directive, applied } = await prepare(c);
        const task = await runRequest(h, c, `Thực hiện theo yêu cầu của CEO [[fake:${directive}]]`);

        // Run dừng chờ duyệt, chưa đổi gì.
        const [approval] = await pending(c, task.id);
        expect(approval).toMatchObject({ actionType: action, status: 'pending' });
        expect((await executeRun(c, task.id)).status).toBe('waiting_approval');
        expect(await applied()).toBe(false);
        expect(await operations(c, task)).toEqual([
          expect.objectContaining({
            actionType: action,
            permissionLevel: 'human_approval',
            status: 'pending_approval',
            approvalRequestId: approval!.id,
          }),
        ]);

        await approve(c, approval!);
        await h.settle();

        expect(await applied()).toBe(true);
        const [op] = await operations(c, task);
        expect(op).toMatchObject({
          actionType: action,
          status: 'succeeded',
          adapterMode: 'internal',
        });
        // Không hiện nhãn "dry-run": hành động thực thi thật và không đi qua adapter dry-run.
        expect(op!.adapterMode).not.toBe('dry_run');
        expect(await h.dryRun.read()).toEqual([]);
        const invocation = (await executeRun(c, task.id)).toolInvocations.find(
          (i) => i.actionType === action,
        );
        expect(invocation).toMatchObject({ status: 'succeeded', adapterMode: 'internal' });
      },
    );

    it('org.archive đơn vị còn nhân viên vẫn bị chặn sau khi duyệt (ORG_UNIT_NOT_EMPTY), đơn vị giữ nguyên', async () => {
      const c = await assistantCompany(h);
      const task = await runRequest(
        h,
        c,
        `Lưu trữ phòng Development [[fake:archive_unit=${c.scene.units.Development}]]`,
      );
      const [approval] = await pending(c, task.id);
      await approve(c, approval!);
      await h.settle();

      expect(await chartText(c)).toContain('Development');
      const [op] = await operations(c, task);
      expect(op).toMatchObject({ actionType: 'org.archive', status: 'failed' });
      expect(
        op!.summary + JSON.stringify((await executeRun(c, task.id)).toolInvocations),
      ).toContain('ORG_UNIT_NOT_EMPTY');
    });

    it('email.send đi qua adapter dry-run, không qua InternalOpsAdapter', async () => {
      const c = await assistantCompany(h);
      const task = await runRequest(h, c, 'Gửi email tóm tắt cho khách [[fake:prompt_injection]]');
      const [approval] = await pending(c, task.id);
      expect(approval).toMatchObject({ actionType: 'email.send' });
      expect(await h.dryRun.read()).toEqual([]);

      await approve(c, approval!);
      await h.settle();
      expect(await h.dryRun.read()).toEqual([
        expect.objectContaining({ actionType: 'email.send', mode: 'dry_run' }),
      ]);
      const email = (await executeRun(c, task.id)).toolInvocations.find(
        (i) => i.actionType === 'email.send',
      );
      expect(email).toMatchObject({ status: 'succeeded', adapterMode: 'dry_run' });
    });
  });

  describe('trợ lý bị tạm ngưng giữa chừng', () => {
    it('task blocked EMPLOYEE_SUSPENDED, yêu cầu duyệt cũ bị hủy, thay đổi đã làm giữ nguyên', async () => {
      const c = await assistantCompany(h);
      const empty = await h.org.upsertOrgUnit(c.ceo, {
        kind: 'department',
        name: 'Phòng chờ lưu trữ',
      });
      const task = await runRequest(
        h,
        c,
        `Tạo phòng rồi lưu trữ phòng cũ [[fake:org_unit=Phòng đã tạo;archive_unit=${empty.id}]]`,
      );
      const [approval] = await pending(c, task.id);
      expect(await chartText(c)).toContain('Phòng đã tạo');

      await h.employees.suspend(c.ceo, c.assistant.id);
      await h.settle();

      expect(await h.tasks.get(c.ceo, task.id)).toMatchObject({
        status: 'blocked',
        blockedReason: 'EMPLOYEE_SUSPENDED',
      });
      expect((await h.permission.getApproval(c.scene.ctx(), approval!.id)).status).toBe(
        'cancelled',
      );
      const chart = await chartText(c);
      expect(chart).toContain('Phòng đã tạo'); // thay đổi đã làm không bị hoàn tác
      expect(chart).toContain('Phòng chờ lưu trữ'); // thao tác đang chờ duyệt không được thực hiện
      expect(await operations(c, task)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actionType: 'org.unit.upsert', status: 'succeeded' }),
        ]),
      );
    });
  });

  describe('worker restart giữa chuỗi thao tác', () => {
    it('thao tác succeeded không lặp; operations cho thấy trạng thái từng thao tác để resume hoặc cancel', async () => {
      const c = await assistantCompany(h);
      const empty = await h.org.upsertOrgUnit(c.ceo, {
        kind: 'department',
        name: 'Phòng chờ duyệt',
      });
      const goal = `Tạo phòng rồi lưu trữ phòng cũ [[fake:org_unit=Phòng khôi phục;archive_unit=${empty.id}]]`;
      const task = await runRequest(h, c, goal, { hold: ['run.start'] });

      // Run đang chạy, thao tác đầu đã xong thì worker chết: job biến mất, heartbeat quá hạn.
      const [run] = (
        await h.orchestration.listRuns(c.scene.ctx(), { taskId: task.id })
      ).items.filter((r) => r.purpose === 'execute');
      await h.orchestration.updateRunStatus(c.scene.ctx(), run!.id, { status: 'running' });
      const current = await h.tasks.get(c.scene.ctx(), task.id);
      const broker = assistantBroker(h);
      const first = await callTool(
        broker,
        {
          ctx: c.scene.ctx({ kind: 'ai', employeeId: c.assistant.id, runId: run!.id }),
          runId: run!.id,
          taskId: task.id,
          employeeId: c.assistant.id,
          purpose: 'execute',
          reworkCount: current.reworkCount,
          expectedTaskStatus: current.status,
          state: { locked: false, requiresReview: false },
        },
        'org_unit_upsert',
        { name: 'Phòng khôi phục', kind: 'department' },
      );
      expect(first.status).toBe('ok');
      h.queue.jobs.splice(0);
      await withTenant(c.scene.companyId, (tx) =>
        tx
          .update(agentRun)
          .set({ heartbeatAt: new Date(Date.now() - STALE_MS) })
          .where(eq(agentRun.id, run!.id)),
      );
      await h.orchestration.recoverStaleRuns();
      await h.settle();

      expect(await h.tasks.get(c.ceo, task.id)).toMatchObject({
        status: 'blocked',
        blockedReason: 'RUN_INTERRUPTED',
      });
      const afterCrash = await operations(c, task);
      expect(afterCrash).toEqual([
        expect.objectContaining({ actionType: 'org.unit.upsert', status: 'succeeded' }),
      ]);
      expect((await chartText(c)).match(/Phòng khôi phục/g)).toHaveLength(1);

      // CEO chọn resume: run mới làm lại chuỗi nhưng thao tác đã succeeded không tạo trùng; thao tác còn lại chờ duyệt.
      await h.tasks.transition(c.ceo, task.id, 'resume');
      await h.settle();
      expect((await chartText(c)).match(/Phòng khôi phục/g)).toHaveLength(1);
      const resumed = await operations(c, task);
      expect(
        resumed
          .filter((o) => o.actionType === 'org.unit.upsert')
          .every((o) => o.status === 'succeeded'),
      ).toBe(true);
      const [approval] = await pending(c, task.id);
      expect(approval).toMatchObject({ actionType: 'org.archive' });
      expect(await chartText(c)).toContain('Phòng chờ duyệt');

      // Duyệt xong thì thao tác còn lại thực thi đúng một lần.
      await approve(c, approval!);
      await h.settle();
      expect(await chartText(c)).not.toContain('Phòng chờ duyệt');
      expect((await chartText(c)).match(/Phòng khôi phục/g)).toHaveLength(1);
    });

    it('CEO chọn cancel: task bị hủy, thao tác đã xong giữ nguyên, thao tác chờ duyệt không còn thực hiện được', async () => {
      const c = await assistantCompany(h);
      const empty = await h.org.upsertOrgUnit(c.ceo, {
        kind: 'department',
        name: 'Phòng không lưu trữ nữa',
      });
      const task = await runRequest(
        h,
        c,
        `Tạo phòng rồi lưu trữ phòng cũ [[fake:org_unit=Phòng đã tạo xong;archive_unit=${empty.id}]]`,
      );
      const [approval] = await pending(c, task.id);

      await h.tasks.transition(c.ceo, task.id, 'cancel');
      await h.settle();
      expect((await h.permission.getApproval(c.scene.ctx(), approval!.id)).status).toBe(
        'cancelled',
      );
      await expect(approve(c, approval!)).rejects.toMatchObject({ code: 'APPROVAL_NOT_PENDING' });
      const chart = await chartText(c);
      expect(chart).toContain('Phòng đã tạo xong');
      expect(chart).toContain('Phòng không lưu trữ nữa');
    });
  });

  describe('SC-017: company.query khớp /dashboard và /usage', () => {
    it('báo cáo của trợ lý lấy đúng số liệu Dashboard; kết quả công cụ trùng với service REST', async () => {
      const c = await assistantCompany(h);
      // Có chi tiêu thật trước khi hỏi: một task của nhân viên chạy xong.
      const worked = await newTask(c, 'Việc tạo chi tiêu');
      await h.tasks.transition(c.ceo, worked.id, 'assign');
      await h.settle();

      const done = await runRequest(
        h,
        c,
        'Tổng hợp tình hình công ty tuần này [[fake:query=overview]]',
      );
      const detail = await h.tasks.get(c.ceo, done.id);
      const { content } = await h.tasks.readArtifact(c.ceo, detail.artifacts.at(-1)!.id, 200_000);
      const json = /```json\n([\s\S]*?)\n```/.exec(content.toString('utf8'))?.[1];
      expect(json, 'báo cáo phải chứa dữ liệu company.query').toBeDefined();
      const reported = JSON.parse(json!) as { view: string; dashboard: { totalEmployees: number } };
      expect(reported.view).toBe('overview');
      expect(reported.dashboard.totalEmployees).toBe(
        (await dashboard.get(c.ceo, {})).totalEmployees,
      );

      // Gọi tool ngay lúc này: kết quả bằng đúng giá trị REST (cùng service, cùng thời điểm).
      const { run } = await assistantRun(h, c);
      const broker = assistantBroker(h);
      const overview = await callTool(broker, run, 'company_query', { view: 'overview' });
      expect(overview.status).toBe('ok');
      const rest = JSON.parse(JSON.stringify(await dashboard.get(c.ceo, {}))) as unknown;
      expect((overview.output as { dashboard: unknown }).dashboard).toEqual(rest);

      const usage = await callTool(broker, run, 'company_query', { view: 'usage' });
      const restUsage = JSON.parse(
        JSON.stringify(
          await h.budget.getUsage(c.ceo, {
            orgUnitId: undefined,
            period: undefined,
            groupBy: 'employee',
          }),
        ),
      ) as unknown;
      expect((usage.output as { usage: unknown }).usage).toEqual(restUsage);
      expect((usage.output as { usage: { tokens: number } }).usage.tokens).toBeGreaterThan(0);
    });
  });

  describe('US9-AS7: ngân sách áp dụng cho trợ lý như mọi nhân viên', () => {
    it('chặn khi hết ngân sách token của trợ lý: task blocked BUDGET_EXCEEDED, không chi tiêu nào xảy ra ở lần chạy chặn', async () => {
      const c = await assistantCompany(h);
      const request = await sendRequest(h, c, 'Tổng hợp tình hình công ty [[fake:query=overview]]');
      await h.settle(); // run propose chạy trước khi đặt giới hạn
      await policies.upsertPolicy(c.scene.ctx(), 'ai_employee', c.assistant.id, {
        monthlyCostLimit: 1_000,
        monthlyTokenLimit: 10,
      });
      const before = (await h.budget.getUsage(c.ceo, { employeeId: c.assistant.id })).tokens;

      await h.tasks.transition(c.ceo, request.id, 'assign');
      await h.settle();

      expect(await h.tasks.get(c.ceo, request.id)).toMatchObject({
        status: 'blocked',
        blockedReason: 'BUDGET_EXCEEDED',
      });
      expect((await h.budget.getUsage(c.ceo, { employeeId: c.assistant.id })).tokens).toBe(before);
      const inbox = await h.communication.listNotifications(c.ceo, c.scene.ceo.memberId, {});
      expect(inbox.items.map((n) => n.type)).toContain('budget_blocked');
    });

    it('cảnh báo ngưỡng 80% được ghi một lần cho chi tiêu của trợ lý', async () => {
      const c = await assistantCompany(h);
      await policies.upsertPolicy(c.scene.ctx(), 'ai_employee', c.assistant.id, {
        monthlyCostLimit: 1,
        monthlyTokenLimit: 10_000_000,
        warnThreshold: 0.8,
      });
      const { task } = await assistantRun(h, c);
      const reserved = await h.budget.reserve(c.scene.ctx(), {
        runId: newId(),
        taskId: task.id,
        employeeId: c.assistant.id,
        modelId: c.assistant.modelId,
        estTokens: 1_000,
        estCostUsd: 0.95,
      });
      if (!reserved.ok) throw new Error('phải reserve được');
      const usage = (id: string, cost: number) => ({
        providerMessageId: id,
        modelId: c.assistant.modelId,
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: cost,
      });
      const warned = [
        ...(await h.budget.commit(c.scene.ctx(), reserved.reservationId, usage('a1', 0.85)))
          .warnings,
        ...(await h.budget.commit(c.scene.ctx(), reserved.reservationId, usage('a2', 0.05)))
          .warnings,
      ];
      expect(warned).toHaveLength(1);
    });

    it('usage_ledger.org_unit_id của trợ lý là null; lọc theo đơn vị bỏ qua dòng này nhưng tổng toàn công ty có tính', async () => {
      const c = await assistantCompany(h);
      const work = await newTask(c, 'Việc của Dev');
      await h.tasks.transition(c.ceo, work.id, 'assign');
      await runRequest(h, c, 'Tổng hợp tình hình công ty [[fake:query=overview]]');
      await h.settle();

      const rows = await withTenant(c.scene.companyId, (tx) =>
        tx.select().from(usageLedger).where(eq(usageLedger.companyId, c.scene.companyId)),
      );
      const mine = rows.filter((r) => r.aiEmployeeId === c.assistant.id);
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((r) => r.orgUnitId === null)).toBe(true);
      expect(
        rows.some((r) => r.aiEmployeeId === c.dev.id && r.orgUnitId === c.scene.units.Development),
      ).toBe(true);

      const sum = (list: typeof rows) =>
        list.reduce(
          (s, r) => s + r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens,
          0,
        );
      const all = await dashboard.get(c.ceo, { period: 'all' });
      const dev = await dashboard.get(c.ceo, {
        period: 'all',
        orgUnitId: c.scene.units.Development,
      });
      expect(all.tokens).toBe(sum(rows));
      expect(dev.tokens).toBe(sum(rows.filter((r) => r.orgUnitId === c.scene.units.Development)));
      expect(all.tokens - dev.tokens).toBeGreaterThanOrEqual(sum(mine));
    });
  });

  describe('đối tượng ngoài phạm vi', () => {
    it('đối tượng của công ty khác → từ chối kèm lý do, đối tượng đó không đổi', async () => {
      const c = await assistantCompany(h);
      const other = await assistantCompany(h); // công ty khác
      const { run } = await assistantRun(h, c);
      const broker = assistantBroker(h);

      const suspend = await callTool(broker, run, 'employee_suspend', { employeeId: other.dev.id });
      expect(suspend.status).toBe('error');
      expect(suspend).toMatchObject({ code: 'NOT_FOUND' });
      expect((await h.employees.get(other.ceo, other.dev.id)).status).toBe('active');

      const foreignUnit = await callTool(broker, run, 'org_unit_upsert', {
        id: other.scene.units.Development,
        name: 'Bị đổi tên',
        kind: 'department',
      });
      expect(foreignUnit.status).toBe('error');
      expect(await chartText(other)).not.toContain('Bị đổi tên');
    });

    it('chức năng ngoài v1.0 (Project, thông báo ngoài ứng dụng, Daily Report) → denied kèm lý do và ledger', async () => {
      const c = await assistantCompany(h);
      const { run } = await assistantRun(h, c);
      const broker = assistantBroker(h);
      for (const name of [
        'project_create',
        'notification_send_external',
        'daily_report_generate',
      ]) {
        const result = await callTool(broker, run, name, { title: 'x' });
        expect(result.status, name).toBe('denied');
        expect(JSON.stringify(result), name).toMatch(/\S/);
      }
      const ledger = (await h.orchestration.getRun(c.ceo, run.runId)).toolInvocations;
      expect(ledger.map((i) => i.actionType).sort()).toEqual([
        'unmapped.daily_report_generate',
        'unmapped.notification_send_external',
        'unmapped.project_create',
      ]);
      expect(ledger.every((i) => i.permissionLevel === 'restricted' && i.status === 'denied')).toBe(
        true,
      );
    });
  });
});
