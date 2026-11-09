import { describe, expect, it } from 'vitest';
import {
  pickDecomposer,
  pickReviewer,
  type SelectionCandidate,
} from '../../src/engines/orchestration/manager-selection';

const human = { kind: 'human' as const, id: 'h1' };
const emp = (id: string, over: Partial<SelectionCandidate> = {}): SelectionCandidate => ({
  id,
  kind: 'employee',
  status: 'active',
  homeOrgUnitId: 'dev',
  teamIds: [],
  manager: human,
  ...over,
});
const mgr = (id: string, over: Partial<SelectionCandidate> = {}) =>
  emp(id, { kind: 'manager', ...over });

describe('pickDecomposer', () => {
  it('task giao Team: AI Manager thuộc team trước, rồi AI Manager của department chứa team', () => {
    const employees = [mgr('m-dept', { homeOrgUnitId: 'dev' }), mgr('m-team', { teamIds: ['t1'] })];
    expect(
      pickDecomposer({ assignee: { kind: 'team', id: 't1', orgUnitId: 'dev' }, employees })?.id,
    ).toBe('m-team');
    expect(
      pickDecomposer({ assignee: { kind: 'team', id: 't2', orgUnitId: 'dev' }, employees })?.id,
    ).toBe('m-dept');
  });

  it('task giao Department: AI Manager có home_org_unit_id là đơn vị đó', () => {
    const employees = [mgr('m-ba', { homeOrgUnitId: 'ba' }), mgr('m-dev', { homeOrgUnitId: 'dev' })];
    expect(pickDecomposer({ assignee: { kind: 'org_unit', id: 'ba' }, employees })?.id).toBe('m-ba');
  });

  it('không có AI Manager nào → undefined (NO_AI_MANAGER)', () => {
    expect(
      pickDecomposer({ assignee: { kind: 'org_unit', id: 'dev' }, employees: [emp('e1')] }),
    ).toBeUndefined();
  });

  it('nhiều AI Manager cùng bậc: chọn id nhỏ nhất', () => {
    const employees = [mgr('m-b'), mgr('m-a'), mgr('m-c')];
    expect(pickDecomposer({ assignee: { kind: 'org_unit', id: 'dev' }, employees })?.id).toBe('m-a');
  });

  it('bỏ qua AI Manager không còn active', () => {
    const employees = [mgr('m-a', { status: 'suspended' }), mgr('m-b', { status: 'archived' })];
    expect(pickDecomposer({ assignee: { kind: 'org_unit', id: 'dev' }, employees })).toBeUndefined();
  });

  it('giao trực tiếp: AI Manager được giao tự đảm nhiệm', () => {
    const employees = [mgr('m-a'), mgr('m-self', { homeOrgUnitId: 'ba' })];
    expect(pickDecomposer({ assignee: { kind: 'ai_employee', id: 'm-self' }, employees })?.id).toBe(
      'm-self',
    );
  });

  it('giao trực tiếp: manager AI trực tiếp → cùng đơn vị → bất kỳ', () => {
    const direct = mgr('m-direct', { homeOrgUnitId: 'qa' });
    const same = mgr('m-same', { homeOrgUnitId: 'dev' });
    const any = mgr('m-any', { homeOrgUnitId: 'ba' });
    const worker = emp('e1', { manager: { kind: 'ai', id: 'm-direct' } });
    expect(
      pickDecomposer({
        assignee: { kind: 'ai_employee', id: 'e1' },
        employees: [any, same, direct, worker],
      })?.id,
    ).toBe('m-direct');
    expect(
      pickDecomposer({ assignee: { kind: 'ai_employee', id: 'e1' }, employees: [any, same, emp('e1')] })
        ?.id,
    ).toBe('m-same');
    expect(
      pickDecomposer({ assignee: { kind: 'ai_employee', id: 'e1' }, employees: [any, emp('e1')] })?.id,
    ).toBe('m-any');
  });
});

describe('pickReviewer (D5)', () => {
  it('manager AI trực tiếp → cùng đơn vị → bất kỳ, luôn khác người thực thi', () => {
    const direct = mgr('m-direct', { homeOrgUnitId: 'qa' });
    const same = mgr('m-same');
    const any = mgr('m-any', { homeOrgUnitId: 'ba' });
    const worker = emp('e1', { manager: { kind: 'ai', id: 'm-direct' } });
    expect(pickReviewer({ executorId: 'e1', employees: [any, same, direct, worker] })?.id).toBe(
      'm-direct',
    );
    expect(pickReviewer({ executorId: 'e1', employees: [any, same, worker] })?.id).toBe('m-same');
    expect(pickReviewer({ executorId: 'e1', employees: [any, worker] })?.id).toBe('m-any');
  });

  it('manager trực tiếp là người thật: bỏ bậc 1 (kịch bản Q3)', () => {
    const same = mgr('m-same');
    expect(pickReviewer({ executorId: 'e1', employees: [same, emp('e1')] })?.id).toBe('m-same');
  });

  it('người thực thi là AI Manager không tự review chính mình', () => {
    const self = mgr('m-self');
    const other = mgr('m-other', { homeOrgUnitId: 'ba' });
    expect(pickReviewer({ executorId: 'm-self', employees: [self, other] })?.id).toBe('m-other');
    expect(pickReviewer({ executorId: 'm-self', employees: [self] })).toBeUndefined();
  });

  it('không có AI Manager → undefined (NO_INDEPENDENT_REVIEWER)', () => {
    expect(pickReviewer({ executorId: 'e1', employees: [emp('e1'), emp('e2')] })).toBeUndefined();
  });

  it('artifact tổng hợp: ưu tiên AI Manager không làm task con nào', () => {
    const synth = mgr('m-synth');
    const involved = mgr('m-involved', { homeOrgUnitId: 'dev' });
    const fresh = mgr('m-fresh', { homeOrgUnitId: 'ba' });
    const result = pickReviewer({
      executorId: 'm-synth',
      employees: [synth, involved, fresh],
      involvedIds: ['m-involved'],
    });
    expect(result?.id).toBe('m-fresh');
    // Chỉ còn AI Manager đã tham gia thì vẫn dùng được (khác người tổng hợp).
    expect(
      pickReviewer({
        executorId: 'm-synth',
        employees: [synth, involved],
        involvedIds: ['m-involved'],
      })?.id,
    ).toBe('m-involved');
  });

  it('nhiều AI Manager cùng bậc: id nhỏ nhất', () => {
    expect(pickReviewer({ executorId: 'e1', employees: [mgr('m-b'), mgr('m-a'), emp('e1')] })?.id).toBe(
      'm-a',
    );
  });
});
