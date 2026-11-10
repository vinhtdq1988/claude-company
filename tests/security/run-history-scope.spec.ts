import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AgentRunSummary,
  AgentRunView,
  EmployeeProfile,
  OrchestrationEngine,
  Page,
  PermissionEngine,
  RequestContext,
  TaskEngine,
} from '@claude-company/contracts';
import {
  ORCHESTRATION_ENGINE,
  PERMISSION_ENGINE,
  TASK_ENGINE,
} from '../../apps/api/src/platform/engine-tokens';
import type { RunContext } from '../../apps/worker/src/runtime/run-context';
import { ToolBroker } from '../../apps/worker/src/runtime/tool-broker';
import { createTestApp, type TestApp } from '../support/app';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { departmentIds, employeeBody, hireVia, memberIdOf } from '../support/employee-fixtures';
import { registerUser, type TestSession } from '../support/factories';

const SECRET_KEY = 'sk-ant-api03-BI-MAT-KHONG-DUOC-LO-1234567890';
const SECRET_BEARER = 'Bearer eyJhbGciOiJIUzI1NiJ9.bi-mat.chu-ky-123456';

/**
 * Phạm vi của lịch sử thực thi (T178; US7-AS4, FR-028, FR-034, SC-012): người xem chỉ thấy run của nhân viên trong
 * phạm vi quản lý của mình, và `run_step.payload` cùng ledger tool không chứa secret. Chạy với Redis giả (`inMemory`)
 * nên chỉ cần PostgreSQL.
 */
describe('Phạm vi của lịch sử thực thi (T178)', () => {
  let infra: StartedInfra;
  let t: TestApp;
  let ceo: TestSession;
  let manager: TestSession;
  let outsider: TestSession;
  let companyId: string;
  let dev: EmployeeProfile;
  let qa: EmployeeProfile;
  let devRunId: string;
  let qaRunId: string;
  let devTaskId: string;
  let qaTaskId: string;
  let orchestration: OrchestrationEngine;
  let permissions: PermissionEngine;
  let tasks: TaskEngine;
  let system: RequestContext;

  const base = () => `/companies/${companyId}`;
  const taskBody = (assigneeId: string) => ({
    title: 'Việc thử lịch sử',
    objective: 'Mục tiêu',
    assignee: { kind: 'ai_employee', id: assigneeId },
    deadline: '2027-12-31T00:00:00Z',
    priority: 'medium',
    acceptanceCriteria: ['Có kết quả'],
    expectedOutput: 'Báo cáo',
  });

  async function newRun(session: TestSession, assigneeId: string) {
    const created = await session.post(`${base()}/tasks`, taskBody(assigneeId));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const taskId = created.body.id as string;
    const { runId } = await orchestration.enqueueRun(system, taskId, 'execute');
    return { taskId, runId };
  }

  beforeAll(async () => {
    infra = await startInfra({ redis: false });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    t = await createTestApp({ infra, inMemory: true });
    orchestration = t.app.get<OrchestrationEngine>(ORCHESTRATION_ENGINE, { strict: false });
    permissions = t.app.get<PermissionEngine>(PERMISSION_ENGINE, { strict: false });
    tasks = t.app.get<TaskEngine>(TASK_ENGINE, { strict: false });

    ceo = await registerUser(t, { displayName: 'CEO' });
    manager = await registerUser(t, { displayName: 'Manager Dev' });
    outsider = await registerUser(t, { displayName: 'Người ngoài' });

    const created = await ceo.post('/companies', {
      name: 'Công ty phạm vi lịch sử',
      templateKey: 'software_company',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    companyId = created.body.id as string;
    system = { companyId, actor: { kind: 'system' }, traceId: 't' };
    const units = await departmentIds(ceo, companyId);

    const added = await ceo.post(`${base()}/members`, { email: manager.email, role: 'manager' });
    expect(added.status).toBe(201);
    expect(
      (
        await ceo.put(`${base()}/management-assignments`, {
          targetKind: 'org_unit',
          targetId: units.Development,
          managerMemberId: added.body.id,
        })
      ).status,
    ).toBe(204);

    const ceoRef = { kind: 'human', id: await memberIdOf(ceo, companyId) } as const;
    dev = await hireVia(
      ceo,
      companyId,
      employeeBody(units.Development!, ceoRef, {
        name: 'Dev trong phạm vi',
        toolGrants: ['workspace.read', 'artifact.publish', 'task.message.post'],
      }),
    );
    qa = await hireVia(
      ceo,
      companyId,
      employeeBody(units.QA!, ceoRef, { name: 'QA ngoài phạm vi' }),
    );

    ({ taskId: devTaskId, runId: devRunId } = await newRun(ceo, dev.id));
    ({ taskId: qaTaskId, runId: qaRunId } = await newRun(ceo, qa.id));
  });

  afterAll(async () => {
    await t?.close();
    await infra?.stop();
  });

  describe('danh sách GET /runs', () => {
    it('CEO thấy run của mọi nhân viên', async () => {
      const res = await ceo.get(`${base()}/runs`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const ids = (res.body as Page<AgentRunSummary>).items.map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([devRunId, qaRunId]));
    });

    it('Manager chỉ thấy run của nhân viên trong phạm vi, kể cả khi lọc theo task của người ngoài', async () => {
      const res = await manager.get(`${base()}/runs`);
      expect(res.status).toBe(200);
      const items = (res.body as Page<AgentRunSummary>).items;
      expect(items.map((r) => r.id)).toContain(devRunId);
      expect(items.map((r) => r.id)).not.toContain(qaRunId);
      for (const run of items) expect(run.employeeId).not.toBe(qa.id);

      const byTask = await manager.get(`${base()}/runs?taskId=${qaTaskId}`);
      expect(byTask.status).toBe(200);
      expect((byTask.body as Page<AgentRunSummary>).items).toEqual([]);
      const own = await manager.get(`${base()}/runs?taskId=${devTaskId}`);
      expect((own.body as Page<AgentRunSummary>).items.map((r) => r.id)).toEqual([devRunId]);
    });

    it('lọc theo nhân viên ngoài phạm vi → 403; tham số sai định dạng → 422', async () => {
      expect((await manager.get(`${base()}/runs?employeeId=${qa.id}`)).status).toBe(403);
      expect((await manager.get(`${base()}/runs?employeeId=${dev.id}`)).status).toBe(200);
      expect((await manager.get(`${base()}/runs?taskId=khong-phai-uuid`)).status).toBe(422);
    });

    it('người không thuộc công ty nhận 404', async () => {
      expect((await outsider.get(`${base()}/runs`)).status).toBe(404);
    });

    it('chưa đăng nhập nhận 401', async () => {
      expect((await t.http.get(t.url(`${base()}/runs`))).status).toBe(401);
    });
  });

  describe('chi tiết GET /runs/:id', () => {
    it('Manager đọc được run trong phạm vi: có steps, tool invocation và usage', async () => {
      const res = await manager.get(`${base()}/runs/${devRunId}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body as AgentRunView).toMatchObject({
        id: devRunId,
        employeeId: dev.id,
        steps: [],
        toolInvocations: [],
        usage: { tokens: 0, costUsd: 0 },
      });
    });

    it('run của nhân viên ngoài phạm vi → 403, không lộ nội dung', async () => {
      const res = await manager.get(`${base()}/runs/${qaRunId}`);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain(qaTaskId);
    });

    it('run không tồn tại hoặc id sai định dạng → 404 / 422; người ngoài công ty → 404', async () => {
      expect((await ceo.get(`${base()}/runs/00000000-0000-4000-8000-000000000000`)).status).toBe(
        404,
      );
      expect((await ceo.get(`${base()}/runs/khong-phai-uuid`)).status).toBe(422);
      expect((await outsider.get(`${base()}/runs/${devRunId}`)).status).toBe(404);
    });
  });

  describe('run_step.payload và ledger tool không chứa secret', () => {
    it('input, kết quả tool và payload bước chạy đều được che trước khi lưu', async () => {
      const task = await tasks.get(system, devTaskId);
      const run: RunContext = {
        ctx: {
          companyId,
          actor: { kind: 'ai', employeeId: dev.id, runId: devRunId },
          traceId: 't',
        },
        runId: devRunId,
        taskId: devTaskId,
        employeeId: dev.id,
        purpose: 'execute',
        reworkCount: task.reworkCount,
        expectedTaskStatus: task.status,
        state: { locked: false, requiresReview: false },
      };
      const broker = new ToolBroker({
        orchestration,
        permissions,
        tasks,
        // Handler trả về kết quả chứa secret: ledger vẫn không được lưu nguyên văn.
        handlers: new Map([
          [
            'task.message.post',
            async () => ({ posted: true, header: SECRET_BEARER, apiKey: SECRET_KEY }),
          ],
        ]),
        toolTimeoutMs: 5_000,
      });

      const result = await broker.invoke(run, {
        name: 'task_message_post',
        input: { body: `Dùng khóa ${SECRET_KEY} và ${SECRET_BEARER} để gọi API` },
        providerCallId: 'secret-1',
      });
      expect(result.status).toBe('ok');

      for (const session of [ceo, manager]) {
        const res = await session.get(`${base()}/runs/${devRunId}`);
        expect(res.status).toBe(200);
        const detail = res.body as AgentRunView;
        expect(detail.steps.length).toBeGreaterThan(0);
        expect(detail.toolInvocations).toHaveLength(1);
        const dump = JSON.stringify(detail);
        expect(dump).not.toContain(SECRET_KEY);
        expect(dump).not.toContain('bi-mat.chu-ky');
        expect(dump).toContain('[REDACTED]');
      }
    });
  });
});
