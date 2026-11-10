import type { DomainEvent, EmployeeProfile, Task } from '@claude-company/contracts';
import { withTenant } from '@claude-company/db';
import { domainEvent } from '@claude-company/db/schema/events';
import { employeeStatus, employeeStatusChange } from '@claude-company/db/schema/office';
import { asc, eq } from 'drizzle-orm';
import { toDomainEvent } from '../../apps/api/src/platform/events/event-publisher';
import { managerProfile, type FlowHarness, type Scene } from './flow-harness';

export type OfficeTeam = {
  scene: Scene;
  manager: EmployeeProfile;
  dev: EmployeeProfile;
  ba: EmployeeProfile;
};

/** Công ty mới với một AI Manager và hai nhân viên (Dev, BA) cùng do manager đó quản lý. */
export async function officeTeam(h: FlowHarness): Promise<OfficeTeam> {
  const scene = await h.newScene();
  const manager = await h.hire(scene, managerProfile(scene));
  const direct = { kind: 'ai' as const, id: manager.id };
  const dev = await h.hire(scene, { manager: direct });
  const ba = await h.hire(scene, {
    name: 'AI BA',
    position: 'AI Business Analyst',
    homeOrgUnitId: scene.units.BA!,
    runtimeKind: 'messages_api',
    manager: direct,
  });
  return { scene, manager, dev, ba };
}

export async function assignTo(
  h: FlowHarness,
  team: OfficeTeam,
  assigneeId: string,
): Promise<Task> {
  const ctx = team.scene.humanCtx(team.scene.ceo.memberId);
  const task = await h.tasks.create(ctx, {
    title: 'Phân tích tài liệu yêu cầu',
    objective: 'Phân tích tài liệu yêu cầu và viết báo cáo',
    assignee: { kind: 'ai_employee', id: assigneeId },
    deadline: '2027-12-31T00:00:00Z',
    priority: 'high',
    acceptanceCriteria: ['Nêu đủ yêu cầu chức năng'],
    expectedOutput: 'Báo cáo phân tích',
  });
  await h.tasks.transition(ctx, task.id, 'assign');
  return task;
}

export const domainEvents = async (companyId: string): Promise<DomainEvent[]> =>
  (
    await withTenant(companyId, (tx) => tx.select().from(domainEvent).orderBy(asc(domainEvent.seq)))
  ).map(toDomainEvent);

/** Nhật ký mọi lần đổi hiển thị của công ty, theo `seq` của sự kiện nguồn. */
export const statusChanges = (companyId: string, employeeId?: string) =>
  withTenant(companyId, async (tx) => {
    const rows = await tx
      .select()
      .from(employeeStatusChange)
      .orderBy(asc(employeeStatusChange.seq));
    return employeeId ? rows.filter((r) => r.aiEmployeeId === employeeId) : rows;
  });

export const statusRow = (companyId: string, employeeId: string) =>
  withTenant(companyId, async (tx) => {
    const [row] = await tx
      .select()
      .from(employeeStatus)
      .where(eq(employeeStatus.aiEmployeeId, employeeId));
    return row;
  });
