import type {
  EmployeeProfile,
  ManagerRef,
  OrgChart,
  OrgChartNode,
} from '@claude-company/contracts';
import { expect } from 'vitest';
import type { TestSession } from './factories';

const flatten = (nodes: OrgChartNode[]): OrgChartNode[] =>
  nodes.flatMap((n) => [n, ...flatten(n.children)]);

/** Body `POST /employees` hợp lệ tối thiểu; ghi đè từng trường theo nhu cầu của test. */
export function employeeBody(
  homeOrgUnitId: string,
  manager: ManagerRef,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'Nhân viên thử',
    avatarKey: 'developer',
    position: 'AI Developer',
    homeOrgUnitId,
    kind: 'employee',
    roleTemplateKey: null,
    personality: 'cẩn thận',
    skills: ['typescript'],
    seniority: 'middle',
    modelId: 'claude-opus-5-5',
    runtimeKind: 'claude_agent_sdk',
    systemPrompt: 'Bạn là AI Developer.',
    toolGrants: ['workspace.read', 'artifact.publish'],
    workspaceId: null,
    manager,
    maxConcurrentTasks: 2,
    ...overrides,
  };
}

/** Body của AI Manager: runtime messages_api và công cụ phù hợp. */
export function managerBody(
  homeOrgUnitId: string,
  manager: ManagerRef,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return employeeBody(homeOrgUnitId, manager, {
    name: 'AI Manager thử',
    position: 'AI Manager',
    kind: 'manager',
    runtimeKind: 'messages_api',
    toolGrants: ['workspace.read', 'task.decompose.propose'],
    ...overrides,
  });
}

/** Tạo nhân viên qua API và kiểm tra thành công (201). */
export async function hireVia(
  session: TestSession,
  companyId: string,
  body: Record<string, unknown>,
): Promise<EmployeeProfile> {
  const res = await session.post(`/companies/${companyId}/employees`, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as EmployeeProfile;
}

/** Các department theo tên trong sơ đồ tổ chức của công ty. */
export async function departmentIds(
  session: TestSession,
  companyId: string,
): Promise<Record<string, string>> {
  const chart = (await session.get(`/companies/${companyId}/org-chart`)).body as OrgChart;
  return Object.fromEntries(flatten(chart.roots).map((n) => [n.name, n.id]));
}

/** Member id (human_member) của người dùng trong công ty. */
export async function memberIdOf(session: TestSession, companyId: string): Promise<string> {
  const me = await session.get('/auth/me');
  const found = (me.body.memberships as Array<{ companyId: string; memberId: string }>).find(
    (m) => m.companyId === companyId,
  );
  if (!found) throw new Error('Người dùng không phải thành viên của công ty');
  return found.memberId;
}
