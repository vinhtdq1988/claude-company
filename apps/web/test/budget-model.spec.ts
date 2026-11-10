import { describe, expect, it } from 'vitest';
import type { BudgetPolicy, OrgChart } from '@claude-company/contracts';
import {
  budgetBlockedTasks,
  buildScopeOptions,
  formatRate,
  formatUsd,
  parseFormState,
  toFormState,
  usageLevel,
  usageRatio,
  type PolicyFormState,
} from '../src/features/budget/budget-model';
import { messages } from '../src/i18n/vi';

const policy = (over: Partial<BudgetPolicy> = {}): BudgetPolicy => ({
  scopeKind: 'org_unit',
  scopeId: 'u1',
  monthlyTokenLimit: 500_000,
  monthlyCostLimit: 5.5,
  maxConcurrentTasks: 3,
  allowedModels: ['claude-haiku-5-5'],
  warnThreshold: 0.8,
  isDefault: false,
  ...over,
});

const form = (over: Partial<PolicyFormState> = {}): PolicyFormState => ({
  ...toFormState(policy()),
  ...over,
});

describe('budget-model: định dạng và mức dùng', () => {
  it('On-time Completion Rate null là chưa có dữ liệu, không phải 0%', () => {
    expect(formatRate(null)).toBeNull();
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(0.756)).toBe('76%');
    expect(messages['dashboard.noData']).toBeTruthy();
  });

  it('chi phí USD có 2 đến 6 chữ số thập phân', () => {
    expect(formatUsd(1)).toBe('$1.00');
    expect(formatUsd(0.000022)).toBe('$0.000022');
  });

  it('mức dùng so với giới hạn: không giới hạn thì không có tỷ lệ; cảnh báo từ ngưỡng, chạm giới hạn là over', () => {
    expect(usageRatio(10, null)).toBeNull();
    expect(usageRatio(10, 0)).toBeNull();
    expect(usageRatio(50, 100)).toBe(0.5);
    expect(usageLevel(null, 0.8)).toBe('ok');
    expect(usageLevel(0.79, 0.8)).toBe('ok');
    expect(usageLevel(0.8, 0.8)).toBe('warn');
    expect(usageLevel(1, 0.8)).toBe('over');
    expect(usageLevel(1.3, 0.8)).toBe('over');
  });
});

describe('budget-model: biểu mẫu chính sách', () => {
  it('chuyển chính sách thành biểu mẫu và ngược lại giữ nguyên giá trị', () => {
    const state = toFormState(policy());
    expect(state).toEqual({
      monthlyTokenLimit: '500000',
      monthlyCostLimit: '5.5',
      maxConcurrentTasks: '3',
      allowedModels: ['claude-haiku-5-5'],
      warnPercent: '80',
    });
    expect(parseFormState(state, 'org_unit')).toEqual({
      ok: true,
      body: {
        monthlyTokenLimit: 500_000,
        monthlyCostLimit: 5.5,
        maxConcurrentTasks: 3,
        allowedModels: ['claude-haiku-5-5'],
        warnThreshold: 0.8,
      },
    });
  });

  it('ô trống là không đặt giới hạn; danh sách model rỗng là không hạn chế', () => {
    const result = parseFormState(
      form({
        monthlyTokenLimit: '',
        monthlyCostLimit: ' ',
        maxConcurrentTasks: '',
        allowedModels: [],
      }),
      'team',
    );
    expect(result).toEqual({
      ok: true,
      body: {
        monthlyTokenLimit: null,
        monthlyCostLimit: null,
        maxConcurrentTasks: null,
        allowedModels: null,
        warnThreshold: 0.8,
      },
    });
  });

  it('công ty bắt buộc có giới hạn token và chi phí', () => {
    const result = parseFormState(form({ monthlyTokenLimit: '', monthlyCostLimit: '' }), 'company');
    expect(result).toEqual({
      ok: false,
      errors: { monthlyTokenLimit: 'required', monthlyCostLimit: 'required' },
    });
  });

  it('phạm vi nhân viên không bao giờ gửi maxConcurrentTasks', () => {
    const result = parseFormState(form({ maxConcurrentTasks: '5' }), 'ai_employee');
    expect(result.ok).toBe(true);
    if (result.ok) expect('maxConcurrentTasks' in result.body).toBe(false);
  });

  it('từ chối giá trị không hợp lệ và chấp nhận dấu phẩy thập phân', () => {
    const bad = parseFormState(
      form({
        monthlyTokenLimit: '1.5',
        monthlyCostLimit: 'abc',
        maxConcurrentTasks: '0',
        warnPercent: '120',
      }),
      'org_unit',
    );
    expect(bad).toEqual({
      ok: false,
      errors: {
        monthlyTokenLimit: 'invalid',
        monthlyCostLimit: 'invalid',
        maxConcurrentTasks: 'invalid',
        warnPercent: 'invalid',
      },
    });
    const comma = parseFormState(form({ monthlyCostLimit: '2,5', warnPercent: '' }), 'org_unit');
    expect(comma).toEqual({ ok: false, errors: { warnPercent: 'required' } });
    const ok = parseFormState(form({ monthlyCostLimit: '2,5', warnPercent: '50' }), 'org_unit');
    expect(ok.ok && ok.body.monthlyCostLimit).toBe(2.5);
    expect(ok.ok && ok.body.warnThreshold).toBe(0.5);
  });
});

describe('budget-model: phạm vi và task bị chặn', () => {
  const chart = {
    roots: [
      {
        id: 'div',
        name: 'Khối công nghệ',
        teams: [],
        children: [
          { id: 'dev', name: 'Development', teams: [{ id: 'tm', name: 'Team Web' }], children: [] },
        ],
      },
    ],
  } as unknown as OrgChart;

  it('CEO thấy công ty, đơn vị, team và nhân viên; Manager không thấy công ty', () => {
    const base = {
      companyId: 'c1',
      companyName: 'Công ty',
      chart,
      employees: [
        { id: 'e1', name: 'Dev 1', status: 'active' },
        { id: 'e2', name: 'Đã nghỉ', status: 'archived' },
      ],
    };
    const ceo = buildScopeOptions({ ...base, isCeo: true });
    expect(ceo.map((o) => `${o.kind}:${o.id}`)).toEqual([
      'company:c1',
      'org_unit:div',
      'org_unit:dev',
      'team:tm',
      'ai_employee:e1',
    ]);
    const manager = buildScopeOptions({ ...base, isCeo: false });
    expect(manager.some((o) => o.kind === 'company')).toBe(false);
  });

  it('chỉ task blocked vì BUDGET_EXCEEDED mới được liệt kê để tiếp tục', () => {
    const tasks = [
      { status: 'blocked', blockedReason: 'BUDGET_EXCEEDED' },
      { status: 'blocked', blockedReason: 'MODEL_NOT_ALLOWED' },
      { status: 'in_progress', blockedReason: null },
    ] as const;
    expect(budgetBlockedTasks(tasks)).toEqual([tasks[0]]);
  });
});
