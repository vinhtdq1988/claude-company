import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EmployeeProfile,
  ModelInfo,
  OrgChart,
  OrgChartNode,
  RoleTemplate,
  Workspace,
} from '@claude-company/contracts';
import { createTestApp, type TestApp } from '../support/app';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { registerUser, type TestSession } from '../support/factories';
import { FakeTaskEngine, makeTask } from '../support/fake-engines';

const flatten = (nodes: OrgChartNode[]): OrgChartNode[] =>
  nodes.flatMap((n) => [n, ...flatten(n.children)]);

describe('Integration: AI Employee (T062; US2-AS1, AS2, AS3, AS4)', () => {
  let infra: StartedInfra;
  let t: TestApp;
  const tasks = new FakeTaskEngine();
  const workspaceRoot = path.join(os.tmpdir(), 'cc-test-workspaces');

  beforeAll(async () => {
    infra = await startInfra({ postgres: true, redis: true });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    // Stub TaskEngine trả rỗng nên nhánh "còn task mở" dùng fake; EmployeeEngine là bản thật.
    t = await createTestApp({
      infra,
      overrides: { task: tasks },
      env: { WORKSPACE_HOST_PATH: workspaceRoot },
    });
  });

  afterAll(async () => {
    await t?.close();
    await infra?.stop();
  });

  const base = (companyId: string) => `/companies/${companyId}`;

  /** Đăng ký user, tạo công ty từ template phần mềm, trả các id cần dùng. */
  async function setup() {
    const session = await registerUser(t);
    const created = await session.post('/companies', {
      name: 'Công ty AI',
      templateKey: 'software_company',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const companyId = created.body.id as string;
    const me = await session.get('/auth/me');
    const ceoMemberId = (me.body.memberships as Array<{ memberId: string }>)[0]!.memberId;
    const chart = (await session.get(`${base(companyId)}/org-chart`)).body as OrgChart;
    const unit = (name: string) => flatten(chart.roots).find((n) => n.name === name)!.id;
    const templates = (await session.get('/role-templates')).body as RoleTemplate[];
    const template = (key: string) => templates.find((x) => x.key === key)!;

    /** Body tạo nhân viên điền sẵn từ mẫu vai trò, giống biểu mẫu tuyển dụng. */
    const fromTemplate = (key: string, overrides: Record<string, unknown> = {}) => {
      const d = template(key).defaults;
      return {
        name: template(key).name,
        avatarKey: d.avatarKey,
        position: d.position,
        homeOrgUnitId: unit('Development'),
        kind: d.kind,
        roleTemplateKey: key,
        personality: d.personality,
        skills: d.skills,
        seniority: d.seniority,
        modelId: d.modelId,
        runtimeKind: d.runtimeKind,
        systemPrompt: d.systemPrompt,
        toolGrants: d.toolGrants,
        workspaceId: null,
        manager: { kind: 'human', id: ceoMemberId },
        maxConcurrentTasks: 2,
        ...overrides,
      };
    };
    const hire = async (body: object) => {
      const res = await session.post(`${base(companyId)}/employees`, body);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body as EmployeeProfile;
    };
    return { session, companyId, ceoMemberId, unit, template, fromTemplate, hire };
  }

  describe('AS1: tạo từ mẫu vai trò hoặc tùy chỉnh', () => {
    it('GET /role-templates trả bốn mẫu với giá trị điền sẵn khớp runtime của vai trò', async () => {
      const { session } = await setup();
      const res = await session.get('/role-templates');
      expect(res.status).toBe(200);
      const byKey = new Map((res.body as RoleTemplate[]).map((x) => [x.key, x.defaults]));
      expect([...byKey.keys()].sort()).toEqual(['ai_ba', 'ai_developer', 'ai_manager', 'ai_qa']);
      expect(byKey.get('ai_developer')).toMatchObject({
        runtimeKind: 'claude_agent_sdk',
        modelId: 'claude-opus-5-5',
      });
      expect(byKey.get('ai_ba')?.runtimeKind).toBe('messages_api');
      expect(byKey.get('ai_manager')).toMatchObject({
        kind: 'manager',
        runtimeKind: 'messages_api',
      });
    });

    it('tạo từ mẫu: hồ sơ hiển thị đủ thuộc tính FR-009 và có manager trực tiếp', async () => {
      const { session, companyId, ceoMemberId, fromTemplate, hire } = await setup();
      const created = await hire(fromTemplate('ai_developer', { name: 'Dev Một' }));
      const detail = await session.get(`${base(companyId)}/employees/${created.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({
        name: 'Dev Một',
        position: 'AI Developer',
        kind: 'employee',
        roleTemplateKey: 'ai_developer',
        runtimeKind: 'claude_agent_sdk',
        seniority: 'middle',
        manager: { kind: 'human', id: ceoMemberId },
        maxConcurrentTasks: 2,
        status: 'active',
        teamIds: [],
        performance: { completedTasks: 0, onTimeRate: 0, reworkRate: 0 },
      });
      for (const field of [
        'avatarKey',
        'homeOrgUnitId',
        'personality',
        'skills',
        'modelId',
        'systemPrompt',
        'toolGrants',
        'workspaceId',
      ]) {
        expect(detail.body, field).toHaveProperty(field);
      }
    });

    it('tạo nhân viên tùy chỉnh không theo mẫu và AI Manager chạy messages_api', async () => {
      const { session, companyId, unit, fromTemplate, hire } = await setup();
      const custom = await hire(
        fromTemplate('ai_ba', {
          name: 'Chuyên gia dữ liệu',
          roleTemplateKey: null,
          position: 'Data Analyst',
          homeOrgUnitId: unit('BA'),
          skills: ['sql'],
          seniority: 'senior',
          toolGrants: ['workspace.read', 'artifact.publish'],
        }),
      );
      expect(custom).toMatchObject({ roleTemplateKey: null, position: 'Data Analyst' });
      const manager = await hire(fromTemplate('ai_manager', { name: 'Quản lý Dev' }));
      expect(manager).toMatchObject({ kind: 'manager', runtimeKind: 'messages_api' });

      const bad = await session.post(
        `${base(companyId)}/employees`,
        fromTemplate('ai_manager', { runtimeKind: 'claude_agent_sdk' }),
      );
      expect(bad.status).toBe(422);
    });

    it('từ chối công cụ ngoài danh mục hoặc không khớp runtime, và model không có trong danh mục', async () => {
      const { session, companyId, fromTemplate } = await setup();
      const post = (body: object) => session.post(`${base(companyId)}/employees`, body);
      const unknownTool = await post(fromTemplate('ai_ba', { toolGrants: ['network.fetch'] }));
      expect(unknownTool.status).toBe(422);
      expect(unknownTool.body.error.code).toBe('VALIDATION_FAILED');
      const wrongRuntime = await post(fromTemplate('ai_ba', { toolGrants: ['workspace.shell'] }));
      expect(wrongRuntime.status).toBe(422);
      const model = await post(fromTemplate('ai_ba', { modelId: 'model-khong-co' }));
      expect(model.status).toBe(422);
      expect(model.body.error.code).toBe('MODEL_NOT_ALLOWED');
    });
  });

  describe('AS2: bắt buộc manager và chuỗi quản lý hợp lệ', () => {
    it('lưu thiếu manager bị chặn với 422 MANAGER_REQUIRED, không tạo nhân viên', async () => {
      const { session, companyId, fromTemplate } = await setup();
      const body = { ...fromTemplate('ai_developer'), manager: undefined };
      const res = await session.post(`${base(companyId)}/employees`, body);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('MANAGER_REQUIRED');
      expect((await session.get(`${base(companyId)}/employees`)).body).toEqual([]);
    });

    it('manager là AI Manager hợp lệ; trỏ vào nhân viên thường bị 422 MANAGEMENT_CHAIN_INVALID', async () => {
      const { session, companyId, fromTemplate, hire } = await setup();
      const manager = await hire(fromTemplate('ai_manager', { name: 'AI Manager' }));
      const dev = await hire(
        fromTemplate('ai_developer', { manager: { kind: 'ai', id: manager.id } }),
      );
      expect(dev.manager).toEqual({ kind: 'ai', id: manager.id });

      const invalid = await session.post(
        `${base(companyId)}/employees`,
        fromTemplate('ai_developer', { name: 'Sai chuỗi', manager: { kind: 'ai', id: dev.id } }),
      );
      expect(invalid.status).toBe(422);
      expect(invalid.body.error.code).toBe('MANAGEMENT_CHAIN_INVALID');
    });
  });

  describe('AS3: đổi model chỉ ảnh hưởng một nhân viên', () => {
    it('PATCH modelId của một nhân viên không đổi nhân viên khác; GET /models liệt kê model đã cấu hình', async () => {
      const { session, companyId, fromTemplate, hire } = await setup();
      const a = await hire(fromTemplate('ai_developer', { name: 'A' }));
      const b = await hire(fromTemplate('ai_developer', { name: 'B' }));
      const patched = await session.patch(`${base(companyId)}/employees/${b.id}`, {
        modelId: 'claude-sonnet-5-5',
      });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      expect(patched.body.modelId).toBe('claude-sonnet-5-5');
      const reloadA = await session.get(`${base(companyId)}/employees/${a.id}`);
      expect(reloadA.body.modelId).toBe('claude-opus-5-5');

      const models = (await session.get('/models')).body as ModelInfo[];
      expect(models.map((m) => m.modelId)).toContain('claude-sonnet-5-5');
      expect(models.every((m) => m.inputPerMtok > 0)).toBe(true);

      const unknown = await session.patch(`${base(companyId)}/employees/${b.id}`, {
        modelId: 'khong-co',
      });
      expect(unknown.status).toBe(422);
      expect(unknown.body.error.code).toBe('MODEL_NOT_ALLOWED');
    });
  });

  describe('AS4: lưu trữ nhân viên còn task', () => {
    it('409 EMPLOYEE_HAS_OPEN_TASKS kèm danh sách task; hết task thì lưu trữ được', async () => {
      const { session, companyId, fromTemplate, hire } = await setup();
      const dev = await hire(fromTemplate('ai_developer', { name: 'Đang bận' }));
      tasks.tasks = [
        makeTask({
          id: '0197a000-0000-7000-8000-0000000000c9',
          title: 'Task dở dang',
          assigneeId: dev.id,
        }),
      ];
      try {
        const blocked = await session.delete(`${base(companyId)}/employees/${dev.id}`);
        expect(blocked.status).toBe(409);
        expect(blocked.body.error.code).toBe('EMPLOYEE_HAS_OPEN_TASKS');
        expect(blocked.body.error.details.tasks).toEqual([
          expect.objectContaining({ title: 'Task dở dang' }),
        ]);
      } finally {
        tasks.tasks = [];
      }
      expect((await session.delete(`${base(companyId)}/employees/${dev.id}`)).status).toBe(204);
      const list = await session.get(`${base(companyId)}/employees`);
      expect(list.body).toEqual([]);
      const archived = await session.get(`${base(companyId)}/employees?status=archived`);
      expect((archived.body as EmployeeProfile[]).map((e) => e.id)).toEqual([dev.id]);
    });
  });

  describe('vòng đời, team và bộ lọc', () => {
    it('suspend/resume đổi status; gán vào Team hiển thị teamIds và lọc theo teamId (FR-007)', async () => {
      const { session, companyId, unit, fromTemplate, hire } = await setup();
      const dev = await hire(fromTemplate('ai_developer', { name: 'Dev Mobile' }));
      const qa = await hire(
        fromTemplate('ai_qa', { name: 'QA Mobile', homeOrgUnitId: unit('QA') }),
      );
      await hire(fromTemplate('ai_ba', { name: 'BA', homeOrgUnitId: unit('BA') }));

      const team = await session.post(`${base(companyId)}/teams`, {
        orgUnitId: unit('Development'),
        name: 'Mobile',
      });
      expect(team.status).toBe(201);
      const assigned = await session.put(`${base(companyId)}/teams/${team.body.id}/members`, {
        members: [
          { kind: 'ai', id: dev.id },
          { kind: 'ai', id: qa.id },
        ],
      });
      expect(assigned.status, JSON.stringify(assigned.body)).toBe(204);

      const inTeam = await session.get(`${base(companyId)}/employees?teamId=${team.body.id}`);
      expect((inTeam.body as EmployeeProfile[]).map((e) => e.name).sort()).toEqual([
        'Dev Mobile',
        'QA Mobile',
      ]);
      expect((inTeam.body as EmployeeProfile[])[0]?.teamIds).toEqual([team.body.id]);

      expect((await session.post(`${base(companyId)}/employees/${dev.id}/suspend`)).status).toBe(
        204,
      );
      const suspended = await session.get(`${base(companyId)}/employees?status=suspended`);
      expect((suspended.body as EmployeeProfile[]).map((e) => e.id)).toEqual([dev.id]);
      expect((await session.post(`${base(companyId)}/employees/${dev.id}/resume`)).status).toBe(
        204,
      );
      expect((await session.get(`${base(companyId)}/employees/${dev.id}`)).body.status).toBe(
        'active',
      );

      const byUnit = await session.get(`${base(companyId)}/employees?orgUnitId=${unit('QA')}`);
      expect((byUnit.body as EmployeeProfile[]).map((e) => e.name)).toEqual(['QA Mobile']);
      const managers = await session.get(`${base(companyId)}/employees?kind=manager`);
      expect(managers.body).toEqual([]);

      // Archive nhân viên gỡ họ khỏi Team, nên Team chỉ còn người còn lại.
      expect((await session.delete(`${base(companyId)}/employees/${qa.id}`)).status).toBe(204);
      const afterArchive = await session.get(`${base(companyId)}/employees?teamId=${team.body.id}`);
      expect((afterArchive.body as EmployeeProfile[]).map((e) => e.id)).toEqual([dev.id]);
    });

    it('bộ lọc không hợp lệ bị từ chối 422', async () => {
      const { session, companyId } = await setup();
      const res = await session.get(`${base(companyId)}/employees?kind=khong-co`);
      expect(res.status).toBe(422);
    });
  });

  describe('thành viên người thật và workspace', () => {
    it('CEO thêm Manager rồi vô hiệu; không vô hiệu được người thật cuối của chuỗi quản lý', async () => {
      const { session, companyId, fromTemplate, hire } = await setup();
      const bob: TestSession = await registerUser(t, { displayName: 'Bob' });
      const added = await session.post(`${base(companyId)}/members`, {
        email: bob.email,
        role: 'manager',
      });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
      const bobId = added.body.id as string;

      const dev = await hire(
        fromTemplate('ai_developer', { name: 'Của Bob', manager: { kind: 'human', id: bobId } }),
      );
      const blocked = await session.delete(`${base(companyId)}/members/${bobId}`);
      expect(blocked.status).toBe(422);
      expect(blocked.body.error.code).toBe('MANAGEMENT_CHAIN_INVALID');
      expect(blocked.body.error.details.employees).toEqual([
        expect.objectContaining({ id: dev.id }),
      ]);

      const me = await session.get('/auth/me');
      const ceoId = (me.body.memberships as Array<{ memberId: string }>)[0]!.memberId;
      const moved = await session.patch(`${base(companyId)}/employees/${dev.id}`, {
        manager: { kind: 'human', id: ceoId },
      });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect((await session.delete(`${base(companyId)}/members/${bobId}`)).status).toBe(204);

      const members = await session.get(`${base(companyId)}/members`);
      expect((members.body as Array<{ id: string }>).map((m) => m.id)).not.toContain(bobId);
      // Người đã bị vô hiệu không còn truy cập được công ty.
      expect((await bob.get(`${base(companyId)}/employees`)).status).toBe(404);
    });

    it('CEO đăng ký workspace; đường dẫn ngoài thư mục cho phép bị từ chối; trùng đường dẫn → 409', async () => {
      const { session, companyId, fromTemplate, hire } = await setup();
      const ok = await session.post(`${base(companyId)}/workspaces`, {
        name: 'Repo chính',
        kind: 'git_repo',
        mountPath: 'repo-chinh',
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      const workspace = ok.body as Workspace;
      expect(workspace.mountPath).toBe(path.resolve(workspaceRoot, 'repo-chinh'));
      expect(workspace.defaultBranch).toBe('main');

      for (const mountPath of ['../ngoai', path.resolve(workspaceRoot, '..', 'ngoai'), '.']) {
        const outside = await session.post(`${base(companyId)}/workspaces`, {
          name: 'Ngoài',
          kind: 'docs_folder',
          mountPath,
        });
        expect(outside.status, mountPath).toBe(422);
      }
      const duplicate = await session.post(`${base(companyId)}/workspaces`, {
        name: 'Trùng',
        kind: 'git_repo',
        mountPath: 'repo-chinh',
      });
      expect(duplicate.status).toBe(409);

      const listed = await session.get(`${base(companyId)}/workspaces`);
      expect((listed.body as Workspace[]).map((w) => w.id)).toEqual([workspace.id]);

      const dev = await hire(fromTemplate('ai_developer', { workspaceId: workspace.id }));
      expect(dev.workspaceId).toBe(workspace.id);
      const missing = await session.post(
        `${base(companyId)}/employees`,
        fromTemplate('ai_developer', { workspaceId: '0197a000-0000-7000-8000-0000000000aa' }),
      );
      expect(missing.status).toBe(422);
    });
  });
});
