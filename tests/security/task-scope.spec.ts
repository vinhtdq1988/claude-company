import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmployeeProfile, RequestContext } from '@claude-company/contracts';
import { newId, withTenant } from '@claude-company/db';
import { reviewRecord } from '@claude-company/db/schema/task';
import { eq } from 'drizzle-orm';
import { createTestApp, type TestApp } from '../support/app';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { departmentIds, employeeBody, hireVia, managerBody, memberIdOf } from '../support/employee-fixtures';
import { registerUser, type TestSession } from '../support/factories';
import { TASK_ENGINE } from '../../apps/api/src/platform/engine-tokens';
import type { TaskEngine } from '@claude-company/contracts';

/**
 * Phạm vi quản lý với task, artifact, tin nhắn và quyết định (T086; US3-AS6, FR-028, FR-029, Nguyên tắc II, VII).
 * Chạy với Redis giả (`inMemory`) nên chỉ cần PostgreSQL.
 */
describe('Phạm vi quản lý của Task Engine (T086)', () => {
  let infra: StartedInfra;
  let t: TestApp;
  let ceo: TestSession;
  let manager: TestSession;
  let outsider: TestSession;
  let companyId: string;
  let ceoMemberId: string;
  let devIn: EmployeeProfile;
  let qaOut: EmployeeProfile;
  let aiManager: EmployeeProfile;
  let tasks: TaskEngine;
  let system: RequestContext;

  const base = () => `/companies/${companyId}`;
  const body = (assigneeId: string, over: Record<string, unknown> = {}) => ({
    title: 'Việc thử phạm vi',
    objective: 'Mục tiêu',
    assignee: { kind: 'ai_employee', id: assigneeId },
    deadline: '2027-12-31T00:00:00Z',
    priority: 'medium',
    acceptanceCriteria: ['Có kết quả'],
    expectedOutput: 'Báo cáo',
    ...over,
  });

  beforeAll(async () => {
    infra = await startInfra({ redis: false });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    t = await createTestApp({ infra, inMemory: true });
    tasks = t.app.get<TaskEngine>(TASK_ENGINE);

    ceo = await registerUser(t, { displayName: 'CEO' });
    manager = await registerUser(t, { displayName: 'Manager Dev' });
    outsider = await registerUser(t, { displayName: 'Người ngoài' });

    const created = await ceo.post('/companies', { name: 'Công ty phạm vi task', templateKey: 'software_company' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    companyId = created.body.id as string;
    const units = await departmentIds(ceo, companyId);
    ceoMemberId = await memberIdOf(ceo, companyId);
    system = { companyId, actor: { kind: 'system' }, traceId: 't' };

    const added = await ceo.post(`${base()}/members`, { email: manager.email, role: 'manager' });
    expect(added.status).toBe(201);
    const assigned = await ceo.put(`${base()}/management-assignments`, {
      targetKind: 'org_unit',
      targetId: units.Development,
      managerMemberId: added.body.id,
    });
    expect(assigned.status).toBe(204);

    const ceoRef = { kind: 'human', id: ceoMemberId } as const;
    devIn = await hireVia(ceo, companyId, employeeBody(units.Development!, ceoRef, { name: 'Dev trong phạm vi' }));
    qaOut = await hireVia(ceo, companyId, employeeBody(units.QA!, ceoRef, { name: 'QA ngoài phạm vi' }));
    aiManager = await hireVia(ceo, companyId, managerBody(units.Development!, ceoRef));
  });

  afterAll(async () => {
    await t?.close();
    await infra?.stop();
  });

  it('US3-AS6: manager giao việc cho người ngoài phạm vi → 403 ASSIGNEE_OUT_OF_SCOPE; trong phạm vi → 201', async () => {
    const out = await manager.post(`${base()}/tasks`, body(qaOut.id));
    expect(out.status).toBe(403);
    expect(out.body.error.code).toBe('ASSIGNEE_OUT_OF_SCOPE');
    const ok = await manager.post(`${base()}/tasks`, body(devIn.id));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ status: 'draft', assigneeId: devIn.id });
  });

  it('thiếu trường bắt buộc → 422 TASK_FIELDS_REQUIRED', async () => {
    const res = await manager.post(`${base()}/tasks`, { title: 'chỉ có tiêu đề' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TASK_FIELDS_REQUIRED');
    const noCriteria = await manager.post(`${base()}/tasks`, body(devIn.id, { acceptanceCriteria: [] }));
    expect(noCriteria.status).toBe(422);
  });

  describe('đọc, trao đổi và quyết định', () => {
    let inScopeTask: string;
    let outScopeTask: string;
    let outArtifact: string;

    beforeAll(async () => {
      inScopeTask = (await ceo.post(`${base()}/tasks`, body(devIn.id, { title: 'Trong phạm vi' }))).body.id;
      outScopeTask = (await ceo.post(`${base()}/tasks`, body(qaOut.id, { title: 'Ngoài phạm vi' }))).body.id;
      // Đưa task ngoài phạm vi về in_progress để có artifact (nội bộ, không qua REST).
      await tasks.transition(system, outScopeTask, 'assign');
      await tasks.transition(system, outScopeTask, 'start');
      const artifact = await tasks.attachArtifact(
        { ...system, actor: { kind: 'ai', employeeId: qaOut.id, runId: newId() } },
        outScopeTask,
        {
          kind: 'document',
          title: 'Bí mật',
          mimeType: 'text/plain',
          storageKey: `${companyId}/secret`,
          sizeBytes: 5,
          checksumSha256: 'x'.repeat(64),
        },
      );
      outArtifact = artifact.id;
    });

    it('manager chỉ thấy task trong phạm vi; CEO thấy tất cả', async () => {
      const mine = await manager.get(`${base()}/tasks`);
      expect(mine.status).toBe(200);
      const ids = (mine.body.items as Array<{ id: string }>).map((x) => x.id);
      expect(ids).toContain(inScopeTask);
      expect(ids).not.toContain(outScopeTask);
      const all = (await ceo.get(`${base()}/tasks`)).body.items as Array<{ id: string }>;
      expect(all.map((x) => x.id)).toEqual(expect.arrayContaining([inScopeTask, outScopeTask]));
    });

    it('xem chi tiết, tin nhắn, artifact và quyết định task ngoài phạm vi → 403; trong phạm vi → được', async () => {
      expect((await manager.get(`${base()}/tasks/${outScopeTask}`)).status).toBe(403);
      expect((await manager.get(`${base()}/tasks/${inScopeTask}`)).status).toBe(200);

      expect((await manager.get(`${base()}/tasks/${outScopeTask}/messages`)).status).toBe(403);
      expect((await manager.post(`${base()}/tasks/${outScopeTask}/messages`, { body: 'xin chào' })).status).toBe(403);
      const sent = await manager.post(`${base()}/tasks/${inScopeTask}/messages`, { body: 'Chỉ dẫn thêm' });
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      expect(sent.body).toMatchObject({ taskId: inScopeTask, authorKind: 'human' });
      expect((await manager.get(`${base()}/tasks/${inScopeTask}/messages`)).body).toHaveLength(1);

      expect((await manager.get(`${base()}/artifacts/${outArtifact}/content`)).status).toBe(403);
      expect(
        (await manager.post(`${base()}/tasks/${outScopeTask}/decisions`, { decision: 'approve', reason: 'x' })).status,
      ).toBe(403);
      expect(
        (await manager.post(`${base()}/tasks/${outScopeTask}/transitions`, { action: 'cancel' })).status,
      ).toBe(403);
    });

    it('quyết định thiếu lý do → 422; người ngoài công ty → 404 mọi route', async () => {
      const res = await ceo.post(`${base()}/tasks/${inScopeTask}/decisions`, { decision: 'approve' });
      expect(res.status).toBe(422);
      for (const path of [`/tasks`, `/tasks/${inScopeTask}`, `/tasks/${inScopeTask}/messages`]) {
        expect((await outsider.get(`${base()}${path}`)).status).toBe(404);
      }
      expect((await outsider.post(`${base()}/tasks`, body(devIn.id))).status).toBe(404);
    });

    it('chuyển trạng thái không hợp lệ qua REST → 409 TASK_INVALID_TRANSITION', async () => {
      const res = await ceo.post(`${base()}/tasks/${inScopeTask}/transitions`, { action: 'resume' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TASK_INVALID_TRANSITION');
    });
  });

  it('REVIEWER_NOT_INDEPENDENT: AI Employee đã tạo artifact không được review chính nó', async () => {
    const created = await ceo.post(`${base()}/tasks`, body(aiManager.id, { title: 'Tự review' }));
    const id = created.body.id as string;
    await tasks.transition(system, id, 'assign');
    await tasks.transition(system, id, 'start');
    const author: RequestContext = { ...system, actor: { kind: 'ai', employeeId: aiManager.id, runId: newId() } };
    await tasks.attachArtifact(author, id, {
      kind: 'document',
      title: 'Kết quả',
      mimeType: 'text/plain',
      storageKey: `${companyId}/a`,
      sizeBytes: 1,
      checksumSha256: 'x'.repeat(64),
    });
    await tasks.transition(system, id, 'submit');
    await expect(
      tasks.recordEvidence(author, id, [{ criterionId: 'c1', verdict: 'met', explanation: 'tự đánh giá' }]),
    ).rejects.toMatchObject({ code: 'REVIEWER_NOT_INDEPENDENT' });
    await expect(
      tasks.recordDecision(author, id, { decision: 'pass', reason: 'tự duyệt' }),
    ).rejects.toMatchObject({ code: 'REVIEWER_NOT_INDEPENDENT' });
  });

  it('review_record bất biến: UPDATE và DELETE bị từ chối ở tầng cơ sở dữ liệu', async () => {
    const created = await ceo.post(`${base()}/tasks`, body(devIn.id, { title: 'Bất biến' }));
    const taskId = created.body.id as string;
    const reviewId = newId();
    await withTenant(
      companyId,
      (tx) =>
        tx.insert(reviewRecord).values({
          id: reviewId,
          companyId,
          taskId,
          stage: 'human_approval',
          reviewerKind: 'human',
          reviewerId: ceoMemberId,
          decision: 'approve',
          reason: 'Đạt',
        }),
      { database: t.database },
    );
    await expect(
      withTenant(companyId, (tx) => tx.update(reviewRecord).set({ reason: 'Sửa lén' }).where(eq(reviewRecord.id, reviewId)), {
        database: t.database,
      }),
    ).rejects.toThrow();
    await expect(
      withTenant(companyId, (tx) => tx.delete(reviewRecord).where(eq(reviewRecord.id, reviewId)), {
        database: t.database,
      }),
    ).rejects.toThrow();
    const [row] = await withTenant(
      companyId,
      (tx) => tx.select().from(reviewRecord).where(eq(reviewRecord.id, reviewId)),
      { database: t.database },
    );
    expect(row?.reason).toBe('Đạt');
  });
});
