import { describe, expect, it, vi } from 'vitest';
import { DomainError, type ToolAdapter } from '@claude-company/contracts';
import { payloadHashOf } from '@claude-company/policy';
import { executeApprovedAction, type ApprovalJobPayload } from '../src/jobs/approval-jobs';
import { remindPendingApprovalsOnce } from '../src/jobs/approval-reminder';
import { ApprovalRequestGate } from '../src/runtime/approval-gate';
import type { RunContext } from '../src/runtime/run-context';

const PAYLOAD = { to: ['khach@example.com'], subject: 'Tóm tắt', body: 'Nội dung' };
const JOB: ApprovalJobPayload = {
  companyId: 'c1',
  taskId: 'task-1',
  runId: 'run-1',
  employeeId: 'emp-1',
  approvalRequestId: 'apr-1',
  traceId: 't',
};

function setup(
  over: {
    approval?: Record<string, unknown>;
    invocation?: Record<string, unknown>;
    claim?: boolean;
    adapter?: Partial<ToolAdapter> | null;
  } = {},
) {
  const approval = {
    id: 'apr-1',
    runId: 'run-1',
    taskId: 'task-1',
    toolInvocationId: 'inv-1',
    actionType: 'email.send',
    status: 'approved',
    payload: PAYLOAD,
    payloadHash: payloadHashOf(PAYLOAD),
    ...over.approval,
  };
  const invocation = {
    id: 'inv-1',
    input: PAYLOAD,
    idempotencyKey: 'key-1',
    status: 'pending_approval',
    ...over.invocation,
  };
  const execute = vi.fn(async () => ({
    status: 'ok' as const,
    output: { dryRun: true, label: 'dry-run' },
  }));
  const adapter: ToolAdapter | undefined =
    over.adapter === null
      ? undefined
      : ({
          actionTypes: ['email.send'],
          mode: 'dry_run',
          execute,
          lookup: vi.fn(async () => 'not_found' as const),
          ...over.adapter,
        } as ToolAdapter);
  const orchestration = {
    getRun: vi.fn(async () => ({ id: 'run-1', purpose: 'execute', toolInvocations: [invocation] })),
    claimToolInvocation: vi.fn(async () => over.claim ?? true),
    updateToolInvocation: vi.fn(async () => undefined),
    appendRunStep: vi.fn(async () => ({ id: 's', seq: 1 })),
  };
  const tasks = { transition: vi.fn(async () => undefined) };
  const enqueue = vi.fn(async () => 'job');
  const deps = {
    permissions: { getApproval: vi.fn(async () => approval) },
    orchestration,
    tasks,
    adapters: { find: () => adapter },
    enqueue,
  } as never;
  return { deps, execute, adapter, orchestration, tasks, enqueue };
}

describe('executeApprovedAction (action.execute-approved)', () => {
  it('duyệt hợp lệ: chiếm bản ghi, thực thi đúng payload qua adapter đúng một lần, ghi ledger rồi đánh thức run', async () => {
    const t = setup();
    expect(await executeApprovedAction(JOB, t.deps)).toBe('executed');
    expect(t.orchestration.claimToolInvocation).toHaveBeenCalledWith(expect.anything(), 'inv-1');
    expect(t.execute).toHaveBeenCalledTimes(1);
    expect(t.execute).toHaveBeenCalledWith(PAYLOAD, 'key-1');
    expect(t.orchestration.updateToolInvocation).toHaveBeenCalledWith(
      expect.anything(),
      'inv-1',
      expect.objectContaining({ status: 'succeeded', adapterMode: 'dry_run' }),
    );
    expect(t.enqueue).toHaveBeenCalledWith(
      'run.resume',
      expect.objectContaining({ runId: 'run-1', approvalRequestId: 'apr-1', purpose: 'execute' }),
      { jobId: 'resume-apr-1' },
    );
  });

  it.each(['pending', 'rejected', 'cancelled'])(
    'yêu cầu %s: không thực thi, không chiếm bản ghi, không đánh thức run',
    async (status) => {
      const t = setup({ approval: { status } });
      expect(await executeApprovedAction(JOB, t.deps)).toBe('skipped');
      expect(t.execute).not.toHaveBeenCalled();
      expect(t.orchestration.claimToolInvocation).not.toHaveBeenCalled();
      expect(t.enqueue).not.toHaveBeenCalled();
    },
  );

  it('payload lưu trữ không còn khớp hash đã duyệt: không thực thi, ledger failed, run vẫn được đánh thức để nhận lỗi', async () => {
    const t = setup({ approval: { payload: { ...PAYLOAD, to: ['ke-tan-cong@example.com'] } } });
    expect(await executeApprovedAction(JOB, t.deps)).toBe('failed');
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.orchestration.claimToolInvocation).not.toHaveBeenCalled();
    expect(t.orchestration.updateToolInvocation).toHaveBeenCalledWith(
      expect.anything(),
      'inv-1',
      expect.objectContaining({ status: 'failed' }),
    );
    expect(t.enqueue).toHaveBeenCalledTimes(1);
  });

  it('payload khác bản ghi ledger (dù hash tự nhất quán): không thực thi', async () => {
    const other = { ...PAYLOAD, subject: 'Khác' };
    const t = setup({ approval: { payload: other, payloadHash: payloadHashOf(other) } });
    expect(await executeApprovedAction(JOB, t.deps)).toBe('failed');
    expect(t.execute).not.toHaveBeenCalled();
  });

  it('giao job lần hai khi đã có người chiếm và đã xong: không thực thi lại, chỉ bảo đảm run được đánh thức', async () => {
    const t = setup({ claim: false, invocation: { status: 'succeeded' } });
    expect(await executeApprovedAction(JOB, t.deps)).toBe('already_executed');
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.enqueue).toHaveBeenCalledWith('run.resume', expect.anything(), {
      jobId: 'resume-apr-1',
    });
  });

  it('lần chạy trước sập giữa chừng (đang executing): hỏi adapter; không xác định được → task blocked TOOL_OUTCOME_UNKNOWN', async () => {
    const t = setup({
      claim: false,
      invocation: { status: 'executing' },
      adapter: { lookup: vi.fn(async () => 'unknown' as const) },
    });
    expect(await executeApprovedAction(JOB, t.deps)).toBe('blocked');
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.tasks.transition).toHaveBeenCalledWith(
      expect.anything(),
      'task-1',
      'block',
      expect.objectContaining({ blockedReason: 'TOOL_OUTCOME_UNKNOWN' }),
    );
  });

  it('lần chạy trước sập giữa chừng nhưng adapter chưa thực thi: thực thi (idempotent theo key)', async () => {
    const t = setup({ claim: false, invocation: { status: 'executing' } });
    expect(await executeApprovedAction(JOB, t.deps)).toBe('executed');
    expect(t.execute).toHaveBeenCalledTimes(1);
  });

  it('adapter live chưa cấu hình: không coi là đã thực thi, task blocked ADAPTER_LIVE_NOT_CONFIGURED, không đánh thức run', async () => {
    const t = setup({
      adapter: {
        mode: 'live',
        execute: vi.fn(async () => {
          throw new DomainError('ADAPTER_LIVE_NOT_CONFIGURED');
        }),
      },
    });
    expect(await executeApprovedAction(JOB, t.deps)).toBe('blocked');
    expect(t.orchestration.updateToolInvocation).toHaveBeenCalledWith(
      expect.anything(),
      'inv-1',
      expect.objectContaining({ status: 'failed' }),
    );
    expect(t.tasks.transition).toHaveBeenCalledWith(
      expect.anything(),
      'task-1',
      'block',
      expect.objectContaining({ blockedReason: 'ADAPTER_LIVE_NOT_CONFIGURED' }),
    );
    expect(t.enqueue).not.toHaveBeenCalled();
  });

  it('adapter lỗi tạm thời: ledger failed nhưng run vẫn được đánh thức để agent biết hành động chưa xảy ra', async () => {
    const t = setup({
      adapter: {
        execute: vi.fn(async () => {
          throw new Error('đĩa đầy');
        }),
      },
    });
    expect(await executeApprovedAction(JOB, t.deps)).toBe('failed');
    expect(t.enqueue).toHaveBeenCalledTimes(1);
  });

  it('không có adapter cho action: failed, không thực thi', async () => {
    const t = setup({ adapter: null });
    expect(await executeApprovedAction(JOB, t.deps)).toBe('failed');
    expect(t.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('ApprovalRequestGate', () => {
  function gateSetup() {
    const createApprovalRequest = vi.fn(async () => ({ id: 'apr-9' }));
    const updateToolInvocation = vi.fn(async () => undefined);
    const gate = new ApprovalRequestGate({
      permissions: { createApprovalRequest } as never,
      orchestration: { updateToolInvocation } as never,
      tasks: { get: vi.fn(async () => ({ title: 'Báo cáo' })) } as never,
    });
    const run = {
      ctx: { companyId: 'c1', actor: { kind: 'ai', employeeId: 'e', runId: 'r' }, traceId: 't' },
      runId: 'r',
      taskId: 'task-1',
      state: { locked: false, requiresReview: false },
    } as unknown as RunContext;
    const invocation = { id: 'inv-9', actionType: 'email.send', input: PAYLOAD } as never;
    return { gate, run, invocation, createApprovalRequest, updateToolInvocation };
  }

  it('tạo yêu cầu với tóm tắt do hệ thống sinh từ payload, khóa run và lưu id vào ledger', async () => {
    const t = gateSetup();
    const result = await t.gate.handle(t.run, t.invocation, {
      actionType: 'email.send',
      input: PAYLOAD,
      summary: 'x',
      rationale: 'Khách yêu cầu',
    });
    expect(result).toMatchObject({
      status: 'pending_approval',
      output: { approvalRequestId: 'apr-9' },
    });
    const [, , summary, rationale] = t.createApprovalRequest.mock.calls[0] as unknown as string[];
    expect(summary).toContain('khach@example.com');
    expect(rationale).toBe('Khách yêu cầu');
    expect(t.updateToolInvocation).toHaveBeenCalledWith(t.run.ctx, 'inv-9', {
      result: { approvalRequestId: 'apr-9' },
    });
    expect(t.run.state).toMatchObject({ locked: true, pendingApprovalId: 'apr-9' });
  });

  it('agent không nêu lý do: dùng lý do mặc định nêu task, không bịa lý do thay agent', async () => {
    const t = gateSetup();
    await t.gate.handle(t.run, t.invocation, {
      actionType: 'email.send',
      input: PAYLOAD,
      summary: 'x',
    });
    const rationale = (t.createApprovalRequest.mock.calls[0] as unknown as string[])[3];
    expect(rationale).toContain('Báo cáo');
    expect(rationale).toContain('không nêu lý do');
  });
});

describe('remindPendingApprovalsOnce', () => {
  it('duyệt từng công ty có yêu cầu đang chờ và cộng số đã nhắc; chỉ nhắc, không quyết định gì', async () => {
    const remindPendingApprovals = vi.fn(async (_ctx: unknown, _now: Date) => 2);
    const permissions = {
      listCompaniesWithPendingApprovals: vi.fn(async () => ['a', 'b']),
      remindPendingApprovals,
    };
    const now = new Date('2026-11-10T00:00:00Z');
    const report = await remindPendingApprovalsOnce({ permissions, now: () => now });
    expect(report).toEqual({ companies: 2, reminded: 4 });
    expect(
      remindPendingApprovals.mock.calls.map((c) => (c[0] as { companyId: string }).companyId),
    ).toEqual(['a', 'b']);
    expect(remindPendingApprovals.mock.calls.every((c) => c[1] === now)).toBe(true);
    expect(Object.keys(permissions)).not.toContain('decideApproval');
  });
});
