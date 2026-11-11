import { describe, expect, it } from 'vitest';
import { COMPANY_OPS_INPUT_SCHEMAS } from '@claude-company/contracts';
import { ACTION_CATALOG, ASSISTANT_ONLY_ACTIONS } from '@claude-company/policy';
import { actionTypeForTool, buildToolSpecs } from '../src/runtime/tool-specs';

const names = (specs: ReturnType<typeof buildToolSpecs>) => specs.map((s) => s.name).sort();

/** Tool điều hành: các dòng có Tool = "có" (chạy messages_api). */
const WITH_TOOL = ACTION_CATALOG.filter((a) => a.assistantOnly && a.runtimes.length > 0).map((a) => a.actionType);
const RESTRICTED_ROWS = ACTION_CATALOG.filter((a) => a.assistantOnly && a.runtimes.length === 0).map(
  (a) => a.actionType,
);
const ASSISTANT = { isCeoAssistant: true } as const;

describe('buildToolSpecs cho CEO AI Assistant (T206)', () => {
  it('chỉ sinh tool điều hành cho ActionType có cột Tool = "có", đã cấp trong toolGrants và runtime messages_api', () => {
    const specs = buildToolSpecs(WITH_TOOL, 'messages_api', ASSISTANT);
    expect(names(specs)).toEqual(WITH_TOOL.map((a) => a.replaceAll('.', '_')).sort());

    // Chưa cấp thì không sinh.
    expect(buildToolSpecs(['company.query'], 'messages_api', ASSISTANT).map((s) => s.name)).toEqual(['company_query']);
    expect(buildToolSpecs([], 'messages_api', ASSISTANT)).toEqual([]);
    // Sai runtime thì không sinh.
    expect(buildToolSpecs(WITH_TOOL, 'claude_agent_sdk', ASSISTANT)).toEqual([]);
  });

  it('không bao giờ sinh tool cho dòng restricted, workspace.* hay network.fetch', () => {
    const everything = [...ASSISTANT_ONLY_ACTIONS, 'network.fetch', 'workspace.read', 'workspace.shell', 'workspace.write'];
    const generated = names(buildToolSpecs(everything, 'messages_api', ASSISTANT));
    for (const restricted of RESTRICTED_ROWS) {
      expect(generated).not.toContain(restricted.replaceAll('.', '_'));
    }
    expect(generated.some((n) => n.startsWith('workspace_'))).toBe(false);
    expect(generated).not.toContain('network_fetch');
    // Cũng không sinh với mọi runtime.
    for (const runtime of ['claude_agent_sdk', 'messages_api'] as const) {
      expect(buildToolSpecs(RESTRICTED_ROWS, runtime, ASSISTANT)).toEqual([]);
    }
  });

  it('nhân viên thường không có tool điều hành dù toolGrants bị sửa trực tiếp', () => {
    expect(buildToolSpecs(WITH_TOOL, 'messages_api')).toEqual([]);
    expect(buildToolSpecs([...WITH_TOOL, 'artifact.publish'], 'messages_api').map((s) => s.name)).toEqual([
      'artifact_publish',
    ]);
  });

  it('tên hành động restricted vẫn ánh xạ về đúng ActionType để ledger ghi đúng tên bị từ chối', () => {
    for (const restricted of RESTRICTED_ROWS) {
      expect(actionTypeForTool(restricted.replaceAll('.', '_'))).toBe(restricted);
    }
    expect(actionTypeForTool('network_fetch')).toBeUndefined();
    expect(actionTypeForTool('xoa_het_du_lieu')).toBeUndefined();
  });

  const SAMPLES: Record<keyof typeof COMPANY_OPS_INPUT_SCHEMAS, Record<string, unknown>> = {
    'company.query': { view: 'overview' },
    'task.create': {
      title: 't',
      objective: 'o',
      assignee: { kind: 'team', id: '00000000-0000-4000-8000-000000000001' },
      deadline: '2030-01-01T00:00:00Z',
      priority: 'medium',
      expectedOutput: 'x',
      acceptanceCriteria: [{ text: 'a', source: 'ceo_quote' }],
    },
    'org.unit.upsert': { kind: 'department', name: 'n' },
    'org.team.upsert': { orgUnitId: '00000000-0000-4000-8000-000000000001', name: 'n' },
    'employee.create': {
      roleTemplateKey: 'ai_developer',
      name: 'n',
      homeOrgUnitId: '00000000-0000-4000-8000-000000000001',
    },
    'employee.update': { employeeId: '00000000-0000-4000-8000-000000000001', name: 'n' },
    'employee.suspend': { employeeId: '00000000-0000-4000-8000-000000000001' },
    'employee.resume': { employeeId: '00000000-0000-4000-8000-000000000001' },
    'employee.archive': { employeeId: '00000000-0000-4000-8000-000000000001' },
    'org.archive': { targetKind: 'team', targetId: '00000000-0000-4000-8000-000000000001' },
    'task.cancel': { taskId: '00000000-0000-4000-8000-000000000001', reason: 'r' },
  };

  it('mọi schema mẫu hợp lệ; mọi trường nâng quyền bị từ chối (strict)', () => {
    const forbidden = [
      'toolGrants',
      'modelId',
      'runtimeKind',
      'systemPrompt',
      'managerId',
      'manager',
      'workspaceId',
      'monthlyCostLimit',
      'tokenLimit',
      'maxConcurrentTasks',
      'level',
      'actorId',
      'memberId',
      'via',
    ];
    for (const [actionType, schema] of Object.entries(COMPANY_OPS_INPUT_SCHEMAS)) {
      const sample = SAMPLES[actionType as keyof typeof SAMPLES];
      expect(schema.safeParse(sample).success, `${actionType} mẫu hợp lệ`).toBe(true);
      for (const field of forbidden) {
        expect(schema.safeParse({ ...sample, [field]: 'x' }).success, `${actionType} nhận ${field}`).toBe(false);
      }
    }
  });

  it('employee.create từ chối roleTemplateKey = ceo_assistant; task.create bắt buộc source cho mỗi tiêu chí', () => {
    const create = COMPANY_OPS_INPUT_SCHEMAS['employee.create'];
    expect(create.safeParse({ ...SAMPLES['employee.create'], roleTemplateKey: 'ceo_assistant' }).success).toBe(false);
    const task = COMPANY_OPS_INPUT_SCHEMAS['task.create'];
    const withoutSource = { ...SAMPLES['task.create'], acceptanceCriteria: [{ text: 'a' }] };
    expect(task.safeParse(withoutSource).success).toBe(false);
    const badSource = { ...SAMPLES['task.create'], acceptanceCriteria: [{ text: 'a', source: 'khác' }] };
    expect(task.safeParse(badSource).success).toBe(false);
  });

  it('JSON Schema của tool điều hành là object và mọi tool có zodShape', () => {
    for (const spec of buildToolSpecs(WITH_TOOL, 'messages_api', ASSISTANT)) {
      expect(spec.inputSchema.type).toBe('object');
      expect(spec.zodShape).toBeDefined();
    }
  });
});
