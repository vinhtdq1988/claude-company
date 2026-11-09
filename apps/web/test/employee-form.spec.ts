import { describe, expect, it } from 'vitest';
import type { RoleTemplate } from '@claude-company/contracts';
import {
  applyTemplate,
  changeKind,
  changeRuntime,
  decodeManager,
  emptyForm,
  encodeManager,
  formFromProfile,
  parseSkills,
  toggleTool,
  toolOptions,
  toRequestBody,
} from '../src/features/employees/employee-form-model';

const developer: RoleTemplate = {
  key: 'ai_developer',
  name: 'AI Developer',
  defaults: {
    position: 'AI Developer',
    kind: 'employee',
    skills: ['typescript', 'unit test'],
    seniority: 'middle',
    runtimeKind: 'claude_agent_sdk',
    systemPrompt: 'Bạn là AI Developer.',
    toolGrants: ['workspace.read', 'workspace.shell', 'workspace.git.push'],
    modelId: 'claude-opus-5-5',
    personality: 'cẩn thận',
    avatarKey: 'developer',
  },
};

describe('employee-form-model', () => {
  it('toolOptions theo runtime: shell chỉ có ở claude_agent_sdk, decompose chỉ ở messages_api, không có network.fetch', () => {
    const sdk = toolOptions('claude_agent_sdk').map((a) => a.actionType);
    const api = toolOptions('messages_api').map((a) => a.actionType);
    expect(sdk).toContain('workspace.shell');
    expect(api).not.toContain('workspace.shell');
    expect(api).toContain('task.decompose.propose');
    expect(sdk).not.toContain('task.decompose.propose');
    expect([...sdk, ...api]).not.toContain('network.fetch');
  });

  it('applyTemplate điền sẵn các trường của mẫu và giữ tên, đơn vị, manager đã nhập', () => {
    const typed = {
      ...emptyForm({ homeOrgUnitId: 'unit-1' }),
      name: 'Dev Một',
      manager: 'human:ceo-1',
    };
    const filled = applyTemplate(typed, developer);
    expect(filled).toMatchObject({
      roleTemplateKey: 'ai_developer',
      name: 'Dev Một',
      homeOrgUnitId: 'unit-1',
      manager: 'human:ceo-1',
      position: 'AI Developer',
      runtimeKind: 'claude_agent_sdk',
      modelId: 'claude-opus-5-5',
      skills: 'typescript, unit test',
      avatarKey: 'developer',
    });
    expect(filled.toolGrants).toEqual(['workspace.read', 'workspace.shell', 'workspace.git.push']);
  });

  it('chọn lại "tùy chỉnh" chỉ bỏ liên kết mẫu, giữ nguyên các giá trị đã điền', () => {
    const filled = applyTemplate(emptyForm(), developer);
    const custom = applyTemplate(filled, undefined);
    expect(custom.roleTemplateKey).toBe('');
    expect(custom.position).toBe('AI Developer');
  });

  it('chọn AI Manager ép runtime messages_api và bỏ công cụ không tương thích', () => {
    const filled = applyTemplate(emptyForm(), developer);
    const manager = changeKind(filled, 'manager');
    expect(manager.runtimeKind).toBe('messages_api');
    expect(manager.toolGrants).toEqual(['workspace.read']);
    // Đang là manager thì không đổi được runtime.
    expect(changeRuntime(manager, 'claude_agent_sdk').runtimeKind).toBe('messages_api');
  });

  it('đổi runtime của nhân viên thường bỏ công cụ không còn tương thích', () => {
    const filled = applyTemplate(emptyForm(), developer);
    const switched = changeRuntime(filled, 'messages_api');
    expect(switched.runtimeKind).toBe('messages_api');
    expect(switched.toolGrants).toEqual(['workspace.read']);
  });

  it('toggleTool bật rồi tắt một công cụ', () => {
    const on = toggleTool(emptyForm(), 'workspace.read');
    expect(on.toolGrants).toEqual(['workspace.read']);
    expect(toggleTool(on, 'workspace.read').toolGrants).toEqual([]);
  });

  it('encode/decode manager; giá trị rỗng hoặc sai dạng là null', () => {
    expect(decodeManager(encodeManager({ kind: 'ai', id: 'abc' }))).toEqual({
      kind: 'ai',
      id: 'abc',
    });
    expect(decodeManager('')).toBeNull();
    expect(decodeManager('robot:1')).toBeNull();
    expect(decodeManager('human:')).toBeNull();
  });

  it('parseSkills tách dấu phẩy, cắt khoảng trắng và bỏ trùng', () => {
    expect(parseSkills(' a, b ,, a ,c')).toEqual(['a', 'b', 'c']);
  });

  it('toRequestBody gửi manager null khi chưa chọn để server trả MANAGER_REQUIRED', () => {
    const body = toRequestBody({ ...applyTemplate(emptyForm(), developer), name: ' Dev ' });
    expect(body.manager).toBeNull();
    expect(body.name).toBe('Dev');
    expect(body.workspaceId).toBeNull();
    expect(body.roleTemplateKey).toBe('ai_developer');
    const withManager = toRequestBody({
      ...applyTemplate(emptyForm(), developer),
      manager: 'human:m1',
      maxConcurrentTasks: '3',
    });
    expect(withManager.manager).toEqual({ kind: 'human', id: 'm1' });
    expect(withManager.maxConcurrentTasks).toBe(3);
  });

  it('formFromProfile rồi toRequestBody giữ nguyên hồ sơ', () => {
    const profile = {
      id: 'e1',
      name: 'Dev',
      avatarKey: 'developer',
      position: 'AI Developer',
      homeOrgUnitId: 'u1',
      teamIds: [],
      kind: 'employee' as const,
      roleTemplateKey: null,
      personality: 'p',
      skills: ['a', 'b'],
      seniority: 'senior' as const,
      modelId: 'claude-opus-5-5',
      runtimeKind: 'claude_agent_sdk' as const,
      systemPrompt: 'sp',
      toolGrants: ['workspace.read'],
      workspaceId: 'w1',
      manager: { kind: 'ai' as const, id: 'm1' },
      maxConcurrentTasks: 4,
      status: 'active' as const,
      performance: { completedTasks: 0, onTimeRate: 0, reworkRate: 0 },
    };
    const body = toRequestBody(formFromProfile(profile));
    expect(body).toMatchObject({
      name: 'Dev',
      roleTemplateKey: null,
      skills: ['a', 'b'],
      workspaceId: 'w1',
      manager: { kind: 'ai', id: 'm1' },
      maxConcurrentTasks: 4,
      seniority: 'senior',
    });
  });
});
