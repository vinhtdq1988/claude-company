import type {
  EmployeeProfile,
  RequestContext,
  Task,
  TaskDetail,
  ToolResult,
} from '@claude-company/contracts';
import { CeoAssistantController } from '../../apps/api/src/engines/orchestration/ceo-assistant.controller';
import { DASHBOARD_READER } from '../../apps/api/src/platform/engine-tokens';
import type { DashboardReader } from '../../apps/api/src/platform/usage-budget/dashboard.service';
import { ApprovalRequestGate } from '../../apps/worker/src/runtime/approval-gate';
import type { RunContext } from '../../apps/worker/src/runtime/run-context';
import { ToolBroker } from '../../apps/worker/src/runtime/tool-broker';
import {
  createCompanyOpsGuards,
  createCompanyOpsHandlers,
  type CompanyOpsDeps,
} from '../../apps/worker/src/tools/company-ops';
import { managerProfile, type FlowHarness, type Scene } from './flow-harness';

export type AssistantCompany = {
  scene: Scene;
  /** Ngữ cảnh của CEO (người dùng thật). */
  ceo: RequestContext;
  manager: EmployeeProfile;
  dev: EmployeeProfile;
  assistant: EmployeeProfile;
  teamId: string;
};

/**
 * Công ty mới có AI Manager, một AI Developer trong team "Dev Team" và CEO AI Assistant tạo từ mẫu `ceo_assistant`
 * (đúng như màn hình Assistant làm: `homeOrgUnitId` rỗng, manager do hệ thống ép là CEO).
 */
export async function assistantCompany(h: FlowHarness): Promise<AssistantCompany> {
  const scene = await h.newScene();
  const ceo = scene.humanCtx(scene.ceo.memberId);
  const manager = await h.hire(scene, managerProfile(scene));
  const dev = await h.hire(scene, { manager: { kind: 'ai', id: manager.id } });
  const team = await h.org.upsertTeam(scene.ctx(), {
    orgUnitId: scene.units.Development!,
    name: 'Dev Team',
  });
  await h.org.setTeamMembers(scene.ctx(), team.id, [
    { kind: 'ai', id: dev.id },
    { kind: 'ai', id: manager.id },
  ]);

  const template = (await h.employees.listRoleTemplates()).find((t) => t.key === 'ceo_assistant');
  if (!template) throw new Error('Thiếu mẫu ceo_assistant: chạy seedDatabase');
  const d = template.defaults;
  const assistant = await h.employees.create(ceo, {
    name: template.name,
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
  return { scene, ceo, manager, dev, assistant, teamId: team.id };
}

export const assistantController = (h: FlowHarness): CeoAssistantController =>
  h.app.get(CeoAssistantController, { strict: false });

/** `POST /ceo-assistant/requests` (gọi controller thật): tạo task nháp chờ đề xuất và xếp run `propose`. */
export const sendRequest = (
  h: FlowHarness,
  c: AssistantCompany,
  goal: string,
  extra: { priority?: string; deadline?: string } = {},
): Promise<Task> => assistantController(h).createRequest(c.ceo, { goal, ...extra });

/**
 * Gửi yêu cầu, để trợ lý soạn đề xuất, CEO giao việc rồi chạy hệ thống tới khi yên. `hold` giữ lại các job (ví dụ để
 * dừng trước khi trợ lý chạy).
 */
export async function runRequest(
  h: FlowHarness,
  c: AssistantCompany,
  goal: string,
  options: { hold?: Parameters<FlowHarness['settleExcept']>[0] } = {},
): Promise<TaskDetail> {
  const request = await sendRequest(h, c, goal);
  await h.settle();
  const ready = await h.tasks.get(c.ceo, request.id);
  if (ready.proposalStatus !== 'ready')
    throw new Error(`Đề xuất chưa sẵn sàng: ${ready.proposalStatus}`);
  await h.tasks.transition(c.ceo, request.id, 'assign');
  if (options.hold) await h.settleExcept(options.hold);
  else await h.settle();
  return h.tasks.get(c.ceo, request.id);
}

const DAY_MS = 86_400_000;

export const companyOpsDeps = (h: FlowHarness): CompanyOpsDeps => ({
  organization: h.org,
  employees: h.employees,
  tasks: h.tasks,
  budget: h.budget,
  dashboard: h.app.get<DashboardReader>(DASHBOARD_READER, { strict: false }),
  communication: h.communication,
});

/** ToolBroker thật với handler/guard điều hành và cổng phê duyệt thật (như `WorkerRuntime`). */
export function assistantBroker(h: FlowHarness, maxWriteOps?: number): ToolBroker {
  const deps = companyOpsDeps(h);
  return new ToolBroker({
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
}

/**
 * Task yêu cầu của CEO giao cho trợ lý cùng một run `propose` làm "phương tiện" để có `agent_run` thật cho ledger, dùng
 * khi test gọi thẳng tool qua `assistantBroker` mà không chạy worker.
 */
export async function assistantRun(
  h: FlowHarness,
  c: AssistantCompany,
  objective = 'Yêu cầu của CEO',
): Promise<{ task: Task; run: RunContext }> {
  const task = await h.tasks.create(c.ceo, {
    title: 'Yêu cầu của CEO',
    objective,
    assignee: { kind: 'ai_employee', id: c.assistant.id },
    deadline: new Date(Date.now() + 3 * DAY_MS).toISOString(),
    priority: 'medium',
    acceptanceCriteria: ['Nộp báo cáo'],
    expectedOutput: 'Báo cáo',
    proposalStatus: 'pending',
  });
  const { runId } = await h.orchestration.enqueueRun(c.ceo, task.id, 'propose');
  return {
    task,
    run: {
      ctx: c.scene.ctx({ kind: 'ai', employeeId: c.assistant.id, runId }),
      runId,
      taskId: task.id,
      employeeId: c.assistant.id,
      purpose: 'propose',
      reworkCount: 0,
      expectedTaskStatus: task.status,
      state: { locked: false, requiresReview: false },
    },
  };
}

export const callTool = (
  broker: ToolBroker,
  run: RunContext,
  name: string,
  input: unknown,
): Promise<ToolResult> => broker.invoke(run, { name, input, providerCallId: `c-${Math.random()}` });

/** Mọi task gốc của công ty, mới nhất trước. */
export async function rootTasks(h: FlowHarness, c: AssistantCompany): Promise<Task[]> {
  return (await h.tasks.list(c.ceo, { rootOnly: true, limit: 200 })).items;
}
