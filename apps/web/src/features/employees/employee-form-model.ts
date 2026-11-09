import type {
  CreateEmployeeInput,
  EmployeeKind,
  EmployeeProfile,
  ManagerRef,
  RoleTemplate,
  RuntimeKind,
  Seniority,
} from '@claude-company/contracts';
import { ACTION_CATALOG, type ActionDefinition } from '@claude-company/policy/catalog';

/** Trạng thái biểu mẫu tuyển dụng; số và danh sách giữ dạng chuỗi để nhập liệu tự nhiên. */
export type EmployeeFormState = {
  /** Rỗng nghĩa là tùy chỉnh, không theo mẫu. */
  roleTemplateKey: string;
  name: string;
  position: string;
  homeOrgUnitId: string;
  kind: EmployeeKind;
  seniority: Seniority;
  personality: string;
  /** Các kỹ năng cách nhau bằng dấu phẩy. */
  skills: string;
  modelId: string;
  runtimeKind: RuntimeKind;
  systemPrompt: string;
  toolGrants: string[];
  workspaceId: string;
  /** `human:<id>` hoặc `ai:<id>`; rỗng là chưa chọn (server trả MANAGER_REQUIRED). */
  manager: string;
  maxConcurrentTasks: string;
  avatarKey: string;
};

export const AVATAR_KEYS = ['developer', 'analyst', 'tester', 'manager', 'generic'] as const;
export const SENIORITIES: readonly Seniority[] = ['junior', 'middle', 'senior', 'expert'];
export const RUNTIMES: readonly RuntimeKind[] = ['claude_agent_sdk', 'messages_api'];

/** Action có thể cấp cho runtime này; `network.fetch` không runtime nào dùng được nên tự loại. */
export function toolOptions(runtimeKind: RuntimeKind): ActionDefinition[] {
  return ACTION_CATALOG.filter((a) => a.runtimes.includes(runtimeKind));
}

const compatible = (toolGrants: string[], runtimeKind: RuntimeKind): string[] => {
  const allowed = new Set(toolOptions(runtimeKind).map((a) => a.actionType));
  return toolGrants.filter((g) => allowed.has(g));
};

export function emptyForm(
  defaults: { modelId?: string; homeOrgUnitId?: string } = {},
): EmployeeFormState {
  return {
    roleTemplateKey: '',
    name: '',
    position: '',
    homeOrgUnitId: defaults.homeOrgUnitId ?? '',
    kind: 'employee',
    seniority: 'middle',
    personality: '',
    skills: '',
    modelId: defaults.modelId ?? '',
    runtimeKind: 'messages_api',
    systemPrompt: '',
    toolGrants: [],
    workspaceId: '',
    manager: '',
    maxConcurrentTasks: '2',
    avatarKey: 'generic',
  };
}

/** Điền sẵn biểu mẫu từ mẫu vai trò, giữ nguyên tên, đơn vị, workspace và manager người dùng đã chọn. */
export function applyTemplate(
  state: EmployeeFormState,
  template: RoleTemplate | undefined,
): EmployeeFormState {
  if (!template) return { ...state, roleTemplateKey: '' };
  const d = template.defaults;
  return {
    ...state,
    roleTemplateKey: template.key,
    position: d.position,
    kind: d.kind,
    seniority: d.seniority,
    personality: d.personality,
    skills: d.skills.join(', '),
    modelId: d.modelId,
    runtimeKind: d.runtimeKind,
    systemPrompt: d.systemPrompt,
    toolGrants: compatible(d.toolGrants, d.runtimeKind),
    avatarKey: d.avatarKey,
  };
}

export function formFromProfile(p: EmployeeProfile): EmployeeFormState {
  return {
    roleTemplateKey: p.roleTemplateKey ?? '',
    name: p.name,
    position: p.position,
    homeOrgUnitId: p.homeOrgUnitId,
    kind: p.kind,
    seniority: p.seniority,
    personality: p.personality,
    skills: p.skills.join(', '),
    modelId: p.modelId,
    runtimeKind: p.runtimeKind,
    systemPrompt: p.systemPrompt,
    toolGrants: p.toolGrants,
    workspaceId: p.workspaceId ?? '',
    manager: encodeManager(p.manager),
    maxConcurrentTasks: String(p.maxConcurrentTasks),
    avatarKey: p.avatarKey,
  };
}

export const encodeManager = (m: ManagerRef): string => `${m.kind}:${m.id}`;

export function decodeManager(value: string): ManagerRef | null {
  const [kind, ...rest] = value.split(':');
  const id = rest.join(':');
  return (kind === 'human' || kind === 'ai') && id ? { kind, id } : null;
}

/** AI Manager chỉ chạy `messages_api`; đổi loại hoặc runtime thì bỏ công cụ không còn tương thích. */
export function changeKind(state: EmployeeFormState, kind: EmployeeKind): EmployeeFormState {
  const runtimeKind = kind === 'manager' ? 'messages_api' : state.runtimeKind;
  return { ...state, kind, runtimeKind, toolGrants: compatible(state.toolGrants, runtimeKind) };
}

export function changeRuntime(
  state: EmployeeFormState,
  runtimeKind: RuntimeKind,
): EmployeeFormState {
  if (state.kind === 'manager') return state;
  return { ...state, runtimeKind, toolGrants: compatible(state.toolGrants, runtimeKind) };
}

export function toggleTool(state: EmployeeFormState, actionType: string): EmployeeFormState {
  const has = state.toolGrants.includes(actionType);
  return {
    ...state,
    toolGrants: has
      ? state.toolGrants.filter((g) => g !== actionType)
      : [...state.toolGrants, actionType],
  };
}

export const parseSkills = (value: string): string[] => [
  ...new Set(
    value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];

/**
 * Body gửi API. `manager` rỗng được gửi là `null` để server trả `MANAGER_REQUIRED`
 * thay vì chặn ở client: quy tắc bắt buộc manager cưỡng chế phía server (US2-AS2).
 */
export function toRequestBody(state: EmployeeFormState): CreateEmployeeInput {
  const max = Number.parseInt(state.maxConcurrentTasks, 10);
  return {
    name: state.name.trim(),
    avatarKey: state.avatarKey,
    position: state.position.trim(),
    homeOrgUnitId: state.homeOrgUnitId,
    kind: state.kind,
    roleTemplateKey: state.roleTemplateKey || null,
    personality: state.personality.trim(),
    skills: parseSkills(state.skills),
    seniority: state.seniority,
    modelId: state.modelId,
    runtimeKind: state.runtimeKind,
    systemPrompt: state.systemPrompt.trim(),
    toolGrants: state.toolGrants,
    workspaceId: state.workspaceId || null,
    manager: decodeManager(state.manager),
    maxConcurrentTasks: Number.isFinite(max) ? max : 2,
  };
}
