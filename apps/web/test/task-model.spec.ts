import { describe, expect, it } from 'vitest';
import type { Task, TaskDetail } from '@claude-company/contracts';
import {
  allowedActions,
  buildTrace,
  canDecide,
  canResume,
  checkCriteria,
  emptyTaskForm,
  groupByStatus,
  isKnownBlockedReason,
  parseCriteria,
  progressOf,
  toCreateBody,
  validateTaskForm,
  type TaskFormState,
} from '../src/features/tasks/task-model';

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  parentTaskId: null,
  title: 'Việc',
  objective: 'Mục tiêu',
  createdByMemberId: 'm1',
  assignedByAiEmployeeId: null,
  assigneeKind: 'ai_employee',
  assigneeId: 'e1',
  deadline: '2027-12-31T00:00:00.000Z',
  priority: 'medium',
  acceptanceCriteria: [
    { id: 'c1', text: 'Một' },
    { id: 'c2', text: 'Hai' },
  ],
  expectedOutput: 'Báo cáo',
  status: 'draft',
  blockedFrom: null,
  blockedReason: null,
  isOverdue: false,
  reworkCount: 0,
  reworkBaseline: 0,
  tokenCap: null,
  costCap: null,
  completedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

const detail = (over: Partial<TaskDetail> = {}): TaskDetail => ({
  ...task(),
  subtasks: [],
  dependsOn: [],
  decompositionPlan: null,
  decomposedByEmployeeId: null,
  artifacts: [],
  evidence: [],
  reviews: [],
  ...over,
});

describe('progressOf', () => {
  it('suy ra từ trạng thái; hoàn thành là 100, nháp là 0', () => {
    expect(progressOf(task({ status: 'draft' }))).toBe(0);
    expect(progressOf(task({ status: 'in_review' }))).toBe(80);
    expect(progressOf(task({ status: 'completed' }))).toBe(100);
  });

  it('in_progress ưu tiên tiến độ realtime và được chặn trong 0–100', () => {
    expect(progressOf(task({ status: 'in_progress' }), 65.4)).toBe(65);
    expect(progressOf(task({ status: 'in_progress' }), 400)).toBe(100);
    expect(progressOf(task({ status: 'in_progress' }), -5)).toBe(0);
    // Tiến độ realtime không áp cho trạng thái khác.
    expect(progressOf(task({ status: 'in_review' }), 10)).toBe(80);
  });

  it('task bị chặn giữ tiến độ của trạng thái trước khi chặn', () => {
    expect(progressOf(task({ status: 'blocked', blockedFrom: 'in_progress' }))).toBe(40);
    expect(progressOf(task({ status: 'blocked', blockedFrom: null }))).toBe(0);
  });
});

describe('groupByStatus', () => {
  const tasks = [
    task({ id: 'a', status: 'assigned' }),
    task({ id: 'b', status: 'assigned' }),
    task({ id: 'c', status: 'cancelled' }),
    task({ id: 'd', status: 'completed' }),
  ];

  it('mỗi cột đủ task theo thứ tự đầu vào; ẩn cột hủy mặc định', () => {
    const columns = groupByStatus(tasks);
    expect(columns.map(([s]) => s)).not.toContain('cancelled');
    expect(columns.find(([s]) => s === 'assigned')![1].map((x) => x.id)).toEqual(['a', 'b']);
    expect(columns.find(([s]) => s === 'completed')![1].map((x) => x.id)).toEqual(['d']);
  });

  it('hiện cột hủy khi được yêu cầu', () => {
    const columns = groupByStatus(tasks, true);
    expect(columns.at(-1)).toEqual(['cancelled', [tasks[2]]]);
  });
});

describe('hành động được phép', () => {
  it('draft: assign + cancel; blocked: resume + cancel; trạng thái cuối: không có', () => {
    expect(allowedActions({ status: 'draft' })).toEqual(['assign', 'cancel']);
    expect(allowedActions({ status: 'blocked' })).toEqual(['resume', 'cancel']);
    expect(allowedActions({ status: 'in_progress' })).toEqual(['cancel']);
    expect(allowedActions({ status: 'completed' })).toEqual([]);
    expect(allowedActions({ status: 'cancelled' })).toEqual([]);
  });

  it('chỉ quyết định được khi chờ Human Approval', () => {
    expect(canDecide({ status: 'awaiting_human_approval' })).toBe(true);
    expect(canDecide({ status: 'in_review' })).toBe(false);
  });

  it('SUBTASK_CANCELLED không resume được, chỉ còn hủy', () => {
    expect(canResume({ status: 'blocked', blockedReason: 'SUBTASK_CANCELLED' })).toBe(false);
    expect(canResume({ status: 'blocked', blockedReason: 'HUMAN_REJECTED' })).toBe(true);
    expect(canResume({ status: 'in_progress', blockedReason: null })).toBe(false);
  });
});

describe('checkCriteria (đối chiếu từng criterion, FR-019)', () => {
  it('criterion chưa có bằng chứng là none; có bằng chứng lấy cái mới nhất', () => {
    const result = checkCriteria(
      detail({
        evidence: [
          {
            id: 'e1',
            taskId: 't1',
            criterionId: 'c1',
            artifactId: null,
            reviewerKind: 'ai',
            reviewerId: 'r',
            verdict: 'not_met',
            explanation: 'Thiếu',
            createdAt: '2026-11-01T01:00:00Z',
          },
          {
            id: 'e2',
            taskId: 't1',
            criterionId: 'c1',
            artifactId: null,
            reviewerKind: 'ai',
            reviewerId: 'r',
            verdict: 'met',
            explanation: 'Đủ',
            createdAt: '2026-11-01T02:00:00Z',
          },
        ],
      }),
    );
    expect(result).toEqual([
      { criterionId: 'c1', text: 'Một', verdict: 'met', explanation: 'Đủ' },
      { criterionId: 'c2', text: 'Hai', verdict: 'none', explanation: '' },
    ]);
  });
});

describe('buildTrace (SC-014)', () => {
  it('sắp theo thời gian: tạo → artifact → bằng chứng → quyết định', () => {
    const trace = buildTrace(
      detail({
        decompositionPlan: { mode: 'confirm', subtasks: [] },
        decomposedByEmployeeId: 'mgr',
        artifacts: [
          {
            id: 'a1',
            taskId: 't1',
            agentRunId: null,
            createdByEmployeeId: 'e1',
            kind: 'document',
            title: 'Báo cáo',
            mimeType: 'text/markdown',
            sizeBytes: 1,
            checksumSha256: 'x',
            createdAt: '2026-11-01T01:00:00Z',
          },
        ],
        evidence: [
          {
            id: 'e1',
            taskId: 't1',
            criterionId: 'c1',
            artifactId: 'a1',
            reviewerKind: 'ai',
            reviewerId: 'mgr',
            verdict: 'met',
            explanation: 'Đủ',
            createdAt: '2026-11-01T02:00:00Z',
          },
        ],
        reviews: [
          {
            id: 'r1',
            taskId: 't1',
            stage: 'human_approval',
            reviewerKind: 'human',
            reviewerId: 'm1',
            decision: 'approve',
            reason: 'Đạt',
            decidedAt: '2026-11-01T03:00:00Z',
          },
        ],
      }),
    );
    expect(trace.map((s) => s.kind)).toEqual([
      'created',
      'decomposed',
      'artifact',
      'evidence',
      'review',
    ]);
    expect(trace.at(-1)?.label).toBe('human_approval/approve: Đạt');
  });
});

describe('biểu mẫu tạo task (FR-014)', () => {
  const valid = (): TaskFormState => ({
    ...emptyTaskForm(),
    title: ' Phân tích ',
    objective: 'Phân tích tài liệu',
    assigneeId: 'e1',
    deadline: '2027-12-31T09:00',
    priority: 'high',
    acceptanceCriteria: 'Nêu đủ yêu cầu\n\n  Nêu rủi ro  \n',
    expectedOutput: 'Báo cáo',
  });

  it('biểu mẫu trống thiếu mọi trường bắt buộc', () => {
    expect(validateTaskForm(emptyTaskForm())).toEqual([
      'title',
      'objective',
      'assigneeId',
      'deadline',
      'acceptanceCriteria',
      'expectedOutput',
    ]);
  });

  it('biểu mẫu đủ trường hợp lệ', () => {
    expect(validateTaskForm(valid())).toEqual([]);
  });

  it('tiêu chí chỉ gồm dòng trắng không hợp lệ; parseCriteria bỏ dòng trống và cắt khoảng trắng', () => {
    expect(validateTaskForm({ ...valid(), acceptanceCriteria: ' \n \n' })).toEqual([
      'acceptanceCriteria',
    ]);
    expect(parseCriteria('a\n\n  b  \n')).toEqual(['a', 'b']);
  });

  it('tokenCap phải là số nguyên dương, costCap là số dương; để trống là không đặt trần', () => {
    expect(validateTaskForm({ ...valid(), tokenCap: '1000', costCap: '0.5' })).toEqual([]);
    expect(validateTaskForm({ ...valid(), tokenCap: '10.5' })).toEqual(['tokenCap']);
    expect(validateTaskForm({ ...valid(), tokenCap: '-1' })).toEqual(['tokenCap']);
    expect(validateTaskForm({ ...valid(), costCap: '0' })).toEqual(['costCap']);
    expect(validateTaskForm({ ...valid(), costCap: 'abc' })).toEqual(['costCap']);
  });

  it('deadline sai định dạng không hợp lệ', () => {
    expect(validateTaskForm({ ...valid(), deadline: 'mai' })).toEqual(['deadline']);
  });

  it('toCreateBody cắt khoảng trắng, đổi deadline sang ISO UTC, chỉ gửi trần khi có nhập', () => {
    const body = toCreateBody(valid());
    expect(body).toEqual({
      title: 'Phân tích',
      objective: 'Phân tích tài liệu',
      assignee: { kind: 'ai_employee', id: 'e1' },
      deadline: new Date('2027-12-31T09:00').toISOString(),
      priority: 'high',
      acceptanceCriteria: ['Nêu đủ yêu cầu', 'Nêu rủi ro'],
      expectedOutput: 'Báo cáo',
    });
    expect(toCreateBody({ ...valid(), tokenCap: '5000', costCap: '1.5' })).toMatchObject({
      tokenCap: 5000,
      costCap: 1.5,
    });
  });
});

describe('blocked_reason', () => {
  it('nhận biết mã đã biết để có thông điệp tiếng Việt', () => {
    expect(isKnownBlockedReason('HUMAN_REJECTED')).toBe(true);
    expect(isKnownBlockedReason('NO_INDEPENDENT_REVIEWER')).toBe(true);
    expect(isKnownBlockedReason('LẠ')).toBe(false);
  });
});
