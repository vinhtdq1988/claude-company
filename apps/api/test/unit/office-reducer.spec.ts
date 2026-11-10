import { describe, expect, it } from 'vitest';
import type { DomainEvent, EmployeeState, OfficeEmployeeState } from '@claude-company/contracts';
import {
  applyEvent,
  COMPLETED_ELAPSED_EVENT,
  employeeOf,
  EMPLOYEE_SUSPENDED_REASON,
  initialEmployeeState,
  newlyCompletedTracks,
  reduceEmployee,
} from '../../src/engines/office-simulation/office-reducer';

/**
 * T144 (SC-006): reducer thuần cho từng dòng của bảng ánh xạ trong contracts/realtime-events.md và thứ tự ưu tiên
 * `error_blocked` > `waiting_approval` > `working`/`thinking`.
 */
const EMP = 'emp-1';
const T1 = 'task-1';
const T2 = 'task-2';
const R1 = 'run-1';

let seq = 0;
const ev = (type: string, payload: Record<string, unknown> = {}, at = ++seq): DomainEvent => ({
  id: `e${at}`,
  companyId: 'c1',
  seq: at,
  type,
  aggregateKind: 'x',
  aggregateId: 'x',
  payload,
  occurredAt: '2026-11-10T00:00:00.000Z',
});

/** Áp lần lượt các sự kiện cho một nhân viên; trả trạng thái cuối. */
function run(events: DomainEvent[], start = initialEmployeeState(EMP)): OfficeEmployeeState {
  return events.reduce((s, e) => reduceEmployee(e, s).next, start);
}
const state = (events: DomainEvent[]): EmployeeState => run(events).state;

const started = (purpose = 'execute', taskId = T1, runId = R1) =>
  ev('run.started', { runId, taskId, employeeId: EMP, purpose });

describe('office-reducer: bảng ánh xạ domain event → trạng thái', () => {
  it('nhân viên chưa có sự kiện là idle', () => {
    expect(initialEmployeeState(EMP).state).toBe('idle');
  });

  it('run.started (execute) → working', () => {
    expect(state([started('execute')])).toBe('working');
  });

  it('run.model_call_started → thinking', () => {
    expect(
      state([started(), ev('run.model_call_started', { runId: R1, taskId: T1, employeeId: EMP })]),
    ).toBe('thinking');
  });

  it('run.tool_call_started → working và ghi currentTool', () => {
    const s = run([
      started(),
      ev('run.model_call_started', { runId: R1, taskId: T1, employeeId: EMP }),
      ev('run.tool_call_started', { runId: R1, taskId: T1, employeeId: EMP, tool: 'file.read' }),
    ]);
    expect(s.state).toBe('working');
    expect(s.currentTool).toBe('file.read');
    expect(s.currentTaskId).toBe(T1);
  });

  it('currentTool chỉ có khi working; sang thinking thì bỏ', () => {
    const s = run([
      started(),
      ev('run.tool_call_started', { runId: R1, taskId: T1, employeeId: EMP, tool: 'shell.run' }),
      ev('run.model_call_started', { runId: R1, taskId: T1, employeeId: EMP }),
    ]);
    expect(s.state).toBe('thinking');
    expect(s.currentTool).toBeNull();
  });

  it.each(['decompose', 'review', 'synthesize'])('run.started (%s) → communicating', (purpose) => {
    expect(state([started(purpose)])).toBe('communicating');
  });

  it('AI gửi task_message trong run đang chạy → communicating', () => {
    const s = state([
      started(),
      ev('task.message_posted', { taskId: T1, authorKind: 'ai', authorId: EMP, runId: R1 }),
    ]);
    expect(s).toBe('communicating');
  });

  it('task_message không gắn run của nhân viên, hoặc của người thật, không đổi trạng thái', () => {
    expect(
      state([
        started(),
        ev('task.message_posted', { taskId: T1, authorKind: 'ai', authorId: EMP, runId: 'other' }),
      ]),
    ).toBe('working');
    expect(
      state([
        ev('task.message_posted', { taskId: T1, authorKind: 'ai', authorId: EMP, runId: null }),
      ]),
    ).toBe('idle');
    expect(
      employeeOf(ev('task.message_posted', { taskId: T1, authorKind: 'human', authorId: 'm1' })),
    ).toBeNull();
  });

  it('approval.requested → waiting_approval', () => {
    const s = state([
      started(),
      ev('approval.requested', {
        approvalRequestId: 'a1',
        taskId: T1,
        employeeId: EMP,
        actionType: 'email.send',
      }),
    ]);
    expect(s).toBe('waiting_approval');
  });

  it('approval.decided chưa đổi trạng thái; run.resumed → working', () => {
    const waiting = [
      started(),
      ev('approval.requested', {
        approvalRequestId: 'a1',
        taskId: T1,
        employeeId: EMP,
        actionType: 'email.send',
      }),
    ];
    const decided = ev('approval.decided', {
      approvalRequestId: 'a1',
      taskId: T1,
      employeeId: EMP,
      decision: 'approve',
    });
    expect(state([...waiting, decided])).toBe('waiting_approval');
    expect(
      state([...waiting, decided, ev('run.resumed', { runId: R1, taskId: T1, employeeId: EMP })]),
    ).toBe('working');
  });

  it('run.succeeded (execute) → completed, giữ cho tới office.completed_display_elapsed rồi idle', () => {
    const start = started();
    const done = ev('run.succeeded', {
      runId: R1,
      taskId: T1,
      employeeId: EMP,
      purpose: 'execute',
    });
    const s = run([start, done]);
    expect(s.state).toBe('completed');
    expect(s.sourceSeq).toBe(done.seq);
    const elapsed = ev(COMPLETED_ELAPSED_EVENT, {
      employeeId: EMP,
      taskId: T1,
      sinceSeq: done.seq,
    });
    expect(run([elapsed], s).state).toBe('idle');
  });

  it('office.completed_display_elapsed của lần completed cũ không xóa lần chạy lại sau đó', () => {
    const done = ev('run.succeeded', {
      runId: R1,
      taskId: T1,
      employeeId: EMP,
      purpose: 'execute',
    });
    const rework = started('execute', T1, 'run-2');
    const staleElapsed = ev(COMPLETED_ELAPSED_EVENT, {
      employeeId: EMP,
      taskId: T1,
      sinceSeq: done.seq,
    });
    expect(state([started(), done, rework, staleElapsed])).toBe('working');
  });

  it('run.succeeded của decompose/review/synthesize không để lại trạng thái completed', () => {
    for (const purpose of ['decompose', 'review', 'synthesize']) {
      const s = state([
        started(purpose),
        ev('run.succeeded', { runId: R1, taskId: T1, employeeId: EMP, purpose }),
      ]);
      expect(s).toBe('idle');
    }
  });

  it.each(['run.failed', 'run.timed_out'])('%s → error_blocked', (type) => {
    const s = run([
      started(),
      ev(type, { runId: R1, taskId: T1, employeeId: EMP, errorCode: 'X' }),
    ]);
    expect(s.state).toBe('error_blocked');
    expect(s.tracks[T1]?.reason).toBe('X');
  });

  it('task blocked của assignee → error_blocked; rời blocked thì bỏ lỗi', () => {
    const start = started();
    const blocked = ev('task.status_changed', {
      taskId: T1,
      from: 'in_progress',
      to: 'blocked',
      assigneeKind: 'ai_employee',
      assigneeId: EMP,
      blockedReason: 'HUMAN_REJECTED',
    });
    const s = run([start, blocked]);
    expect(s.state).toBe('error_blocked');
    const resumed = ev('task.status_changed', {
      taskId: T1,
      from: 'blocked',
      to: 'in_progress',
      assigneeKind: 'ai_employee',
      assigneeId: EMP,
    });
    expect(run([resumed], s).state).toBe('idle');
  });

  it('run.cancelled sau khi task blocked không xóa dấu hiệu lỗi', () => {
    const start = started();
    const blocked = ev('task.status_changed', {
      taskId: T1,
      from: 'in_progress',
      to: 'blocked',
      assigneeKind: 'ai_employee',
      assigneeId: EMP,
      blockedReason: 'NO_AI_MANAGER',
    });
    expect(
      state([start, blocked, ev('run.cancelled', { runId: R1, taskId: T1, employeeId: EMP })]),
    ).toBe('error_blocked');
    expect(
      state([started(), ev('run.cancelled', { runId: R1, taskId: T1, employeeId: EMP })]),
    ).toBe('idle');
  });

  it('task bị hủy hoặc hoàn tất xóa track của task đó', () => {
    for (const to of ['cancelled', 'completed']) {
      const start = started();
      const change = ev('task.status_changed', {
        taskId: T1,
        from: 'in_review',
        to,
        assigneeKind: 'ai_employee',
        assigneeId: EMP,
      });
      expect(state([start, change])).toBe('idle');
    }
  });

  it('employee.suspended → break; employee.resumed → idle', () => {
    const suspended = ev('employee.suspended', { employeeId: EMP });
    const s = run([suspended]);
    expect(s.state).toBe('break');
    expect(run([ev('employee.resumed', { employeeId: EMP })], s).state).toBe('idle');
  });

  it('tạm ngưng làm task blocked (EMPLOYEE_SUSPENDED): hiển thị break, resume thì về idle; lỗi khác vẫn giữ', () => {
    const blockedBy = (taskId: string, reason: string) =>
      ev('task.status_changed', {
        taskId,
        from: 'in_progress',
        to: 'blocked',
        assigneeKind: 'ai_employee',
        assigneeId: EMP,
        blockedReason: reason,
      });
    const suspended = run([
      started('execute', T1),
      ev('employee.suspended', { employeeId: EMP }),
      blockedBy(T1, EMPLOYEE_SUSPENDED_REASON),
    ]);
    expect(suspended.state).toBe('break');
    const resumed = ev('employee.resumed', { employeeId: EMP });
    expect(run([resumed], suspended).state).toBe('idle');

    const other = run([started('execute', T2, 'run-2'), blockedBy(T2, 'BUDGET_EXCEEDED'), ...[]]);
    expect(
      run(
        [
          ev('employee.suspended', { employeeId: EMP }),
          ev('employee.resumed', { employeeId: EMP }),
        ],
        other,
      ).state,
    ).toBe('error_blocked');
  });

  it('không bao giờ phát meeting trong v1.0 (Phase 4)', () => {
    const types = ['run.started', 'run.succeeded', 'approval.requested', 'employee.suspended'];
    for (const type of types) {
      const s = state([ev(type, { runId: R1, taskId: T1, employeeId: EMP, purpose: 'execute' })]);
      expect(s).not.toBe('meeting');
    }
  });
});

describe('office-reducer: nhiều task trên một nhân viên', () => {
  const startedOn = (taskId: string, runId: string) => started('execute', taskId, runId);

  it('error_blocked > waiting_approval > working/thinking, bất kể thứ tự đến', () => {
    // Mỗi lần sinh sự kiện mới để `seq` luôn tăng theo thứ tự đến.
    const make = {
      working: () => [startedOn(T1, 'r1')],
      waiting: () => [
        startedOn(T2, 'r2'),
        ev('approval.requested', {
          approvalRequestId: 'a',
          taskId: T2,
          employeeId: EMP,
          actionType: 'email.send',
        }),
      ],
      failed: () => [
        startedOn('task-3', 'r3'),
        ev('run.failed', { runId: 'r3', taskId: 'task-3', employeeId: EMP }),
      ],
    };
    const after = (...order: Array<keyof typeof make>) => state(order.flatMap((k) => make[k]()));

    expect(after('waiting', 'working')).toBe('waiting_approval'); // waiting thắng working dù working đến sau
    expect(after('working', 'waiting')).toBe('waiting_approval');
    expect(after('working', 'waiting', 'failed')).toBe('error_blocked');
    expect(after('failed', 'working', 'waiting')).toBe('error_blocked');
    expect(after('working')).toBe('working');
  });

  it('cùng hạng thì lấy sự kiện gần nhất; hiển thị đúng task đó', () => {
    const s = run([
      startedOn(T1, 'r1'),
      startedOn(T2, 'r2'),
      ev('run.model_call_started', { runId: 'r1', taskId: T1, employeeId: EMP }),
    ]);
    expect(s.state).toBe('thinking');
    expect(s.currentTaskId).toBe(T1);
  });

  it('completed thua mọi trạng thái đang hoạt động', () => {
    const done = () => [
      startedOn(T1, 'r1'),
      ev('run.succeeded', { runId: 'r1', taskId: T1, employeeId: EMP, purpose: 'execute' }),
    ];
    expect(state([...done(), startedOn(T2, 'r2')])).toBe('working');
    expect(state(done())).toBe('completed');
  });

  it('hết lỗi của một task thì trở về trạng thái của task còn lại', () => {
    const start = startedOn(T1, 'r1');
    const failed = ev('run.failed', { runId: 'r1', taskId: T1, employeeId: EMP });
    const s = run([start, failed, startedOn(T2, 'r2')]);
    expect(s.state).toBe('error_blocked');
    const retried = ev('run.started', {
      runId: 'r1b',
      taskId: T1,
      employeeId: EMP,
      purpose: 'execute',
    });
    // Retry thành công đổi track lỗi thành working; hai task cùng working.
    expect(reduceEmployee(retried, s).next.state).toBe('working');
  });
});

describe('office-reducer: tính thuần, idempotent và truy vết nguồn (SC-006)', () => {
  it('sự kiện giao lại (seq đã áp) không đổi gì', () => {
    const e = started();
    const first = reduceEmployee(e, initialEmployeeState(EMP));
    const again = reduceEmployee(e, first.next);
    expect(again.displayChanged).toBe(false);
    expect(again.persistedChanged).toBe(false);
    expect(again.next).toBe(first.next);
  });

  it('không sửa đầu vào và cùng đầu vào cho cùng kết quả', () => {
    const prev = run([started()]);
    const frozen = structuredClone(prev);
    const e = ev('run.model_call_started', { runId: R1, taskId: T1, employeeId: EMP });
    const a = reduceEmployee(e, prev);
    const b = reduceEmployee(e, prev);
    expect(prev).toEqual(frozen);
    expect(a).toEqual(b);
  });

  it('sourceSeq luôn là seq của sự kiện làm đổi hiển thị gần nhất', () => {
    const e1 = started();
    const e2 = ev('run.model_call_started', { runId: R1, taskId: T1, employeeId: EMP });
    const e3 = ev('usage.updated', { employeeId: EMP }); // không liên quan
    const s = run([e1, e2, e3]);
    expect(s.state).toBe('thinking');
    expect(s.sourceSeq).toBe(e2.seq);
  });

  it('không sự kiện nguồn thì không đổi trạng thái (sự kiện không liên quan bị bỏ qua)', () => {
    for (const type of [
      'task.created',
      'usage.updated',
      'org_unit.created',
      'run.queued',
      'sync.seq_advanced',
    ]) {
      expect(
        applyEvent(ev(type, { employeeId: EMP, taskId: T1 }), initialEmployeeState(EMP)),
      ).toBeNull();
    }
  });

  it('sự kiện của nhân viên khác không áp vào nhân viên này', () => {
    const other = ev('run.started', {
      runId: 'x',
      taskId: 'tx',
      employeeId: 'emp-2',
      purpose: 'execute',
    });
    expect(reduceEmployee(other, initialEmployeeState(EMP)).persistedChanged).toBe(false);
  });

  it('applyEvent trả previousState và sự kiện nguồn', () => {
    const e1 = started();
    const first = applyEvent(e1);
    expect(first).toMatchObject({ employeeId: EMP, state: 'working', previousState: 'idle' });
    expect(first?.sourceEvent).toBe(e1);
    const e2 = ev('run.model_call_started', { runId: R1, taskId: T1, employeeId: EMP });
    expect(applyEvent(e2, first?.next)).toMatchObject({
      state: 'thinking',
      previousState: 'working',
    });
  });

  it('chỉ báo thay đổi khi hiển thị đổi: progress cũng là thay đổi, lặp lại thì không', () => {
    const base = run([started()]);
    const p50 = ev('task.progress', { taskId: T1, employeeId: EMP, progress: 50 });
    const r = reduceEmployee(p50, base);
    expect(r.displayChanged).toBe(true);
    expect(r.next.progress).toBe(50);
    const same = reduceEmployee(
      ev('task.progress', { taskId: T1, employeeId: EMP, progress: 50 }),
      r.next,
    );
    expect(same.displayChanged).toBe(false);
  });

  it('task.progress không hồi sinh task đã completed hoặc không có track', () => {
    expect(state([ev('task.progress', { taskId: T1, employeeId: EMP, progress: 10 })])).toBe(
      'idle',
    );
  });

  it('newlyCompletedTracks chỉ trả track completed do chính sự kiện đó tạo', () => {
    const start = started();
    const done = ev('run.succeeded', {
      runId: R1,
      taskId: T1,
      employeeId: EMP,
      purpose: 'execute',
    });
    const s = run([start, done]);
    expect(newlyCompletedTracks(done, s).map((t) => t.taskId)).toEqual([T1]);
    expect(newlyCompletedTracks(ev('usage.updated'), s)).toEqual([]);
  });
});
