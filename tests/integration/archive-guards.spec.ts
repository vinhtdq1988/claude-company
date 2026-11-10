import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError, type Task } from '@claude-company/contracts';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { createFlowHarness, type FlowHarness, type Scene } from '../support/flow-harness';

/**
 * Chặn archive khi còn việc dở, với engine thật (T089b): US1-AS4 (đơn vị, team) và US2-AS4 (nhân viên).
 * Lỗi `409` kèm danh sách cản trở để người dùng biết cần xử lý gì trước khi lưu trữ.
 */
describe('Integration: archive bị chặn khi còn nhân viên hoặc task mở (US1-AS4, US2-AS4)', () => {
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

  /** Bắt lỗi miền từ một thao tác để kiểm tra mã, trạng thái HTTP và chi tiết. */
  async function domainError(action: () => Promise<unknown>): Promise<DomainError> {
    try {
      await action();
    } catch (error) {
      if (error instanceof DomainError) return error;
      throw error;
    }
    throw new Error('Thao tác lẽ ra phải bị từ chối');
  }

  async function newUnit(scene: Scene, name: string) {
    // Department phải nằm dưới một division.
    const division = await h.org.upsertOrgUnit(scene.ctx(), {
      kind: 'division',
      parentId: null,
      name: `Khối ${name}`,
    });
    return h.org.upsertOrgUnit(scene.ctx(), { kind: 'department', parentId: division.id, name });
  }

  async function openTask(scene: Scene, assigneeId: string, title = 'Việc đang mở'): Promise<Task> {
    return h.tasks.create(scene.humanCtx(scene.ceo.memberId), {
      title,
      objective: 'Mục tiêu',
      assignee: { kind: 'ai_employee', id: assigneeId },
      deadline: '2027-12-31T00:00:00Z',
      priority: 'medium',
      acceptanceCriteria: ['Có kết quả'],
      expectedOutput: 'Báo cáo',
    });
  }

  describe('US2-AS4: archive AI Employee', () => {
    it('còn task mở → 409 EMPLOYEE_HAS_OPEN_TASKS kèm danh sách task; hủy task rồi archive được', async () => {
      const scene = await h.newScene();
      const dev = await h.hire(scene);
      const task = await openTask(scene, dev.id);

      const error = await domainError(() => h.employees.archive(scene.ctx(), dev.id));
      expect(error.code).toBe('EMPLOYEE_HAS_OPEN_TASKS');
      expect(error.httpStatus).toBe(409);
      expect(error.details.tasks).toEqual([{ id: task.id, title: task.title }]);
      expect((await h.employees.get(scene.ctx(), dev.id)).status).not.toBe('archived');

      await h.tasks.transition(scene.humanCtx(scene.ceo.memberId), task.id, 'cancel');
      await h.settle();
      await h.employees.archive(scene.ctx(), dev.id);
      expect((await h.employees.get(scene.ctx(), dev.id)).status).toBe('archived');
    });

    it('task đã hoàn tất/hủy không cản trở; nhân viên không có task archive được ngay', async () => {
      const scene = await h.newScene();
      const dev = await h.hire(scene);
      await h.employees.archive(scene.ctx(), dev.id);
      expect((await h.employees.get(scene.ctx(), dev.id)).status).toBe('archived');
    });
  });

  describe('US1-AS4: archive đơn vị tổ chức', () => {
    it('còn nhân viên và task mở → 409 ORG_UNIT_NOT_EMPTY liệt kê nhân viên và task', async () => {
      const scene = await h.newScene();
      const unit = await newUnit(scene, 'Phòng thử');
      const dev = await h.hire(scene, { homeOrgUnitId: unit.id });
      const task = await openTask(scene, dev.id);

      const error = await domainError(() => h.org.archiveOrgUnit(scene.ctx(), unit.id));
      expect(error.code).toBe('ORG_UNIT_NOT_EMPTY');
      expect(error.httpStatus).toBe(409);
      expect(error.details.employees).toEqual([{ id: dev.id, name: dev.name }]);
      expect(error.details.tasks).toEqual([{ id: task.id, title: task.title }]);
      expect(error.details.childUnits).toEqual([]);
      expect(error.details.teams).toEqual([]);
    });

    it('chỉ còn nhân viên (không task) vẫn bị chặn; xử lý xong thì archive được', async () => {
      const scene = await h.newScene();
      const unit = await newUnit(scene, 'Phòng thử 2');
      const dev = await h.hire(scene, { homeOrgUnitId: unit.id });

      const blocked = await domainError(() => h.org.archiveOrgUnit(scene.ctx(), unit.id));
      expect(blocked.code).toBe('ORG_UNIT_NOT_EMPTY');
      expect(blocked.details.employees).toHaveLength(1);
      expect(blocked.details.tasks).toEqual([]);

      await h.employees.archive(scene.ctx(), dev.id);
      await h.org.archiveOrgUnit(scene.ctx(), unit.id);
      expect(await h.org.getOrgUnit(scene.ctx(), unit.id)).toBeNull();
    });

    it('task giao trực tiếp cho đơn vị (assignee_kind = org_unit) cũng chặn archive', async () => {
      const scene = await h.newScene();
      const unit = await newUnit(scene, 'Phòng thử 3');
      const task = await h.tasks.create(scene.humanCtx(scene.ceo.memberId), {
        title: 'Việc giao cho phòng',
        objective: 'Mục tiêu',
        assignee: { kind: 'org_unit', id: unit.id },
        deadline: '2027-12-31T00:00:00Z',
        priority: 'low',
        acceptanceCriteria: ['Có kết quả'],
        expectedOutput: 'Báo cáo',
      });
      const error = await domainError(() => h.org.archiveOrgUnit(scene.ctx(), unit.id));
      expect(error.code).toBe('ORG_UNIT_NOT_EMPTY');
      expect((error.details.tasks as Array<{ id: string }>).map((t) => t.id)).toContain(task.id);
    });
  });

  describe('US1-AS4: archive Team', () => {
    it('còn thành viên hoặc task giao cho Team → 409 TEAM_NOT_EMPTY', async () => {
      const scene = await h.newScene();
      const dev = await h.hire(scene);
      const team = await h.org.upsertTeam(scene.ctx(), {
        orgUnitId: scene.units.Development!,
        name: 'Mobile',
      });
      await h.org.setTeamMembers(scene.ctx(), team.id, [{ kind: 'ai', id: dev.id }]);

      const withMember = await domainError(() => h.org.archiveTeam(scene.ctx(), team.id));
      expect(withMember.code).toBe('TEAM_NOT_EMPTY');
      expect(withMember.httpStatus).toBe(409);
      expect(withMember.details.members).toEqual([{ kind: 'ai', id: dev.id }]);

      await h.org.setTeamMembers(scene.ctx(), team.id, []);
      const task = await h.tasks.create(scene.humanCtx(scene.ceo.memberId), {
        title: 'Việc giao cho Team',
        objective: 'Mục tiêu',
        assignee: { kind: 'team', id: team.id },
        deadline: '2027-12-31T00:00:00Z',
        priority: 'low',
        acceptanceCriteria: ['Có kết quả'],
        expectedOutput: 'Báo cáo',
      });
      const withTask = await domainError(() => h.org.archiveTeam(scene.ctx(), team.id));
      expect(withTask.code).toBe('TEAM_NOT_EMPTY');
      expect(withTask.details.tasks).toEqual([{ id: task.id, title: task.title }]);

      await h.tasks.transition(scene.humanCtx(scene.ceo.memberId), task.id, 'cancel');
      await h.org.archiveTeam(scene.ctx(), team.id);
    });
  });
});
