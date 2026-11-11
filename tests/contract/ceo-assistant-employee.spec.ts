import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError, type EmployeeProfileInput } from '@claude-company/contracts';
import { withTenant } from '@claude-company/db';
import { aiEmployee } from '@claude-company/db/schema/employee';
import { prepareDatabase, seedDatabase, startInfra, type StartedInfra } from '../support/containers';
import { createFlowHarness, type FlowHarness, type Scene } from '../support/flow-harness';

/**
 * Contract test `EmployeeEngine` cho CEO AI Assistant (FR-046, R14 Decision 1/4): hồ sơ do hệ thống quyết định, mỗi công ty
 * tối đa một trợ lý chưa lưu trữ, bốn trường cố định, không có công cụ workspace hay hành động `restricted`.
 */
describe('Contract: EmployeeEngine với CEO AI Assistant (US9)', () => {
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

  /** Hồ sơ xin tạo trợ lý: cố tình gửi sai kind, runtime, đơn vị nhà và manager để kiểm tra hệ thống ghi đè. */
  const assistantInput = (scene: Scene, overrides: Partial<EmployeeProfileInput> = {}): EmployeeProfileInput => ({
    name: 'CEO AI Assistant',
    avatarKey: 'manager',
    position: 'CEO AI Assistant',
    homeOrgUnitId: scene.units.Development!,
    kind: 'manager',
    roleTemplateKey: 'ceo_assistant',
    personality: '',
    skills: [],
    seniority: 'senior',
    modelId: 'claude-opus-5-5',
    runtimeKind: 'claude_agent_sdk',
    systemPrompt: 'Bạn là trợ lý của CEO.',
    toolGrants: ['company.query', 'artifact.publish', 'task.message.post'],
    workspaceId: null,
    manager: { kind: 'ai', id: '00000000-0000-4000-8000-000000000000' },
    maxConcurrentTasks: 2,
    ...overrides,
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

  it('create ép kind=employee, runtimeKind=messages_api, homeOrgUnitId=null, manager là CEO', async () => {
    const scene = await h.newScene();
    const created = await h.employees.create(scene.humanCtx(scene.ceo.memberId), assistantInput(scene));
    expect(created.kind).toBe('employee');
    expect(created.runtimeKind).toBe('messages_api');
    expect(created.homeOrgUnitId).toBeNull();
    expect(created.manager).toEqual({ kind: 'human', id: scene.ceo.memberId });
    expect(created.roleTemplateKey).toBe('ceo_assistant');
  });

  it('tạo lần hai khi còn trợ lý chưa lưu trữ (kể cả suspended) → CEO_ASSISTANT_EXISTS; sau archive tạo lại được', async () => {
    const scene = await h.newScene();
    const ctx = scene.humanCtx(scene.ceo.memberId);
    const first = await h.employees.create(ctx, assistantInput(scene));
    await rejectsWith(h.employees.create(ctx, assistantInput(scene)), 'CEO_ASSISTANT_EXISTS', 409);

    await h.employees.suspend(ctx, first.id);
    await rejectsWith(h.employees.create(ctx, assistantInput(scene)), 'CEO_ASSISTANT_EXISTS', 409);
    expect((await h.employees.getCeoAssistant(ctx))?.status).toBe('suspended');

    await h.employees.archive(ctx, first.id);
    expect(await h.employees.getCeoAssistant(ctx)).toBeNull();
    const second = await h.employees.create(ctx, assistantInput(scene));
    expect(second.id).not.toBe(first.id);
    expect((await h.employees.getCeoAssistant(ctx))?.id).toBe(second.id);
  });

  it('update đổi kind, runtimeKind, manager hoặc homeOrgUnitId → 422 VALIDATION_FAILED', async () => {
    const scene = await h.newScene();
    const ctx = scene.humanCtx(scene.ceo.memberId);
    const assistant = await h.employees.create(ctx, assistantInput(scene));
    const other = await h.addManager(scene);
    for (const patch of [
      { kind: 'manager' as const },
      { runtimeKind: 'claude_agent_sdk' as const },
      { manager: { kind: 'human' as const, id: other.memberId } },
      { homeOrgUnitId: scene.units.Development! },
      { roleTemplateKey: null },
    ]) {
      await rejectsWith(h.employees.update(ctx, assistant.id, patch), 'VALIDATION_FAILED', 422);
    }
    // Sửa hồ sơ thông thường vẫn được.
    const renamed = await h.employees.update(ctx, assistant.id, { name: 'Trợ lý mới', skills: ['báo cáo'] });
    expect(renamed.name).toBe('Trợ lý mới');
    // Nhân viên khác không biến thành trợ lý được.
    const dev = await h.hire(scene);
    await rejectsWith(
      h.employees.update(ctx, dev.id, { roleTemplateKey: 'ceo_assistant' }),
      'VALIDATION_FAILED',
      422,
    );
  });

  it('toolGrants có workspace.* hoặc ActionType restricted → 422', async () => {
    const scene = await h.newScene();
    const ctx = scene.humanCtx(scene.ceo.memberId);
    for (const bad of [['workspace.read'], ['workspace.write'], ['task.decide'], ['budget.update'], ['network.fetch']]) {
      await rejectsWith(
        h.employees.create(ctx, assistantInput(scene, { toolGrants: bad })),
        'VALIDATION_FAILED',
        422,
      );
    }
    const assistant = await h.employees.create(ctx, assistantInput(scene));
    await rejectsWith(
      h.employees.update(ctx, assistant.id, { toolGrants: ['company.query', 'approval.decide'] }),
      'VALIDATION_FAILED',
      422,
    );
    // Công cụ điều hành hợp lệ cho trợ lý.
    const ok = await h.employees.update(ctx, assistant.id, {
      toolGrants: ['company.query', 'task.create', 'org.archive', 'email.send'],
    });
    expect(ok.toolGrants).toContain('task.create');
  });

  it('nhân viên khác không được cấp hành động điều hành', async () => {
    const scene = await h.newScene();
    await rejectsWith(
      h.hire(scene, { runtimeKind: 'messages_api', toolGrants: ['company.query'] }),
      'VALIDATION_FAILED',
      422,
    );
  });

  it('homeOrgUnitId rỗng với nhân viên không phải trợ lý bị chặn (service và CHECK của DB)', async () => {
    const scene = await h.newScene();
    await rejectsWith(
      h.hire(scene, { homeOrgUnitId: null, roleTemplateKey: null }),
      'VALIDATION_FAILED',
      422,
    );
    await rejectsWith(
      h.hire(scene, { homeOrgUnitId: null, roleTemplateKey: 'ai_developer' }),
      'VALIDATION_FAILED',
      422,
    );
    // Chặn ở tầng DB kể cả khi bỏ qua engine.
    await expect(
      withTenant(scene.companyId, (tx) =>
        tx.insert(aiEmployee).values({
          companyId: scene.companyId,
          name: 'Không đơn vị',
          avatarKey: 'generic',
          position: 'x',
          homeOrgUnitId: null,
          kind: 'employee',
          roleTemplateKey: 'ai_developer',
          seniority: 'middle',
          modelId: 'claude-opus-5-5',
          runtimeKind: 'messages_api',
          systemPrompt: 'x',
          managerKind: 'human',
          managerId: scene.ceo.memberId,
        }),
      ),
    ).rejects.toThrow();
  });

  it('getCeoAssistant trả trợ lý hoặc null; chỉ CEO được gọi', async () => {
    const scene = await h.newScene();
    const ctx = scene.humanCtx(scene.ceo.memberId);
    expect(await h.employees.getCeoAssistant(ctx)).toBeNull();
    const created = await h.employees.create(ctx, assistantInput(scene));
    expect((await h.employees.getCeoAssistant(ctx))?.id).toBe(created.id);

    const manager = await h.addManager(scene);
    await rejectsWith(h.employees.getCeoAssistant(scene.humanCtx(manager.memberId)), 'FORBIDDEN', 403);
    // Manager thường cũng không tạo được trợ lý.
    await rejectsWith(
      h.employees.create(scene.humanCtx(manager.memberId), assistantInput(scene)),
      'FORBIDDEN',
      403,
    );
  });

  it('Manager thường không có trợ lý trong phạm vi quản lý; CEO thì có', async () => {
    const scene = await h.newScene();
    const ctx = scene.humanCtx(scene.ceo.memberId);
    const assistant = await h.employees.create(ctx, assistantInput(scene));
    const manager = await h.addManager(scene);
    await h.org.assignManager(ctx, { kind: 'org_unit', id: scene.units.Development! }, manager.memberId);

    const managerScope = await h.org.resolveManagedScope(ctx, manager.memberId);
    expect(managerScope.employeeIds).not.toContain(assistant.id);
    expect(await h.org.isInScope(ctx, manager.memberId, { kind: 'ai_employee', id: assistant.id })).toBe(false);
    expect(await h.org.isInScope(ctx, scene.ceo.memberId, { kind: 'ai_employee', id: assistant.id })).toBe(true);
  });

  it('deactivateHumanMember của CEO vẫn bị chặn bởi quy tắc chuỗi quản lý', async () => {
    const scene = await h.newScene();
    const ctx = scene.humanCtx(scene.ceo.memberId);
    await h.employees.create(ctx, assistantInput(scene));
    await rejectsWith(
      h.employees.deactivateHumanMember(scene.ctx(), scene.ceo.memberId),
      'MANAGEMENT_CHAIN_INVALID',
    );
  });
});
