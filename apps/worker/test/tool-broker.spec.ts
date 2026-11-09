import { describe, expect, it, vi } from 'vitest';
import type {
  RequestContext,
  ToolInvocationInput,
  ToolInvocationRef,
  ToolInvocationPatch,
} from '@claude-company/contracts';
import { evaluatePermission } from '@claude-company/policy';
import type { RunContext } from '../src/runtime/run-context';
import { ToolBroker } from '../src/runtime/tool-broker';

const ctx: RequestContext = {
  companyId: 'c1',
  actor: { kind: 'ai', employeeId: 'e1', runId: 'r1' },
  traceId: 't',
};

function makeRun(overrides: Partial<RunContext> = {}): RunContext {
  return {
    ctx,
    runId: 'r1',
    taskId: 'task-1',
    employeeId: 'e1',
    purpose: 'execute',
    reworkCount: 0,
    expectedTaskStatus: 'in_progress',
    state: { locked: false, requiresReview: false },
    ...overrides,
  };
}

/** Ledger trong bộ nhớ, đủ để kiểm tra hành vi dedupe và ghi nhận. */
function setup(options: { grants?: string[]; taskStatus?: string } = {}) {
  const ledger = new Map<string, ToolInvocationRef & { level: string }>();
  const byId = new Map<string, string>();
  const steps: Array<{ kind: string; summary: string }> = [];
  const evaluate = vi.fn(async (_c: RequestContext, req: { actionType: string; input: unknown; employeeId: string }) =>
    evaluatePermission({
      actionType: req.actionType,
      toolGrants: options.grants ?? [],
      policies: [],
      input: req.input,
    }),
  );
  const orchestration = {
    appendRunStep: vi.fn(async (_c: RequestContext, _r: string, s: { kind: string; summary: string }) => {
      steps.push(s);
      return { id: `step-${steps.length}`, seq: steps.length };
    }),
    recordToolInvocation: vi.fn(async (_c: RequestContext, inv: ToolInvocationInput) => {
      const ref = {
        id: `inv-${ledger.size + 1}`,
        actionType: inv.actionType,
        payloadHash: inv.inputHash,
        idempotencyKey: inv.idempotencyKey,
        status: inv.status,
        level: inv.permissionLevel,
      };
      ledger.set(inv.idempotencyKey, ref);
      byId.set(ref.id, inv.idempotencyKey);
      return ref;
    }),
    updateToolInvocation: vi.fn(async (_c: RequestContext, id: string, patch: ToolInvocationPatch) => {
      const key = byId.get(id)!;
      const current = ledger.get(key)!;
      ledger.set(key, { ...current, ...(patch.status ? { status: patch.status } : {}), result: patch.result });
    }),
    findToolInvocationByKey: vi.fn(async (_c: RequestContext, key: string) => ledger.get(key) ?? null),
  };
  const handler = vi.fn(async () => ({ saved: true }));
  const tasks = { get: vi.fn(async () => ({ status: options.taskStatus ?? 'in_progress' })) };
  const broker = new ToolBroker({
    orchestration,
    permissions: { evaluate },
    tasks: tasks as never,
    handlers: new Map([
      ['artifact.publish', handler],
      ['workspace.shell', handler],
      ['workspace.read', handler],
    ]),
    toolTimeoutMs: 1_000,
  });
  return { broker, ledger, evaluate, handler, orchestration, steps, tasks };
}

const publish = { name: 'artifact_publish', providerCallId: 'p1', input: { title: 'Báo cáo', content: 'x' } };

describe('ToolBroker', () => {
  it('tool không ánh xạ được → restricted, bị từ chối nhưng vẫn ghi ledger', async () => {
    const { broker, ledger, handler } = setup({ grants: ['artifact.publish'] });
    const result = await broker.invoke(makeRun(), { name: 'rm_rf', providerCallId: 'p', input: {} });
    expect(result.status).toBe('denied');
    expect(handler).not.toHaveBeenCalled();
    const [row] = [...ledger.values()];
    expect(row).toMatchObject({ actionType: 'unmapped.rm_rf', status: 'denied', level: 'restricted' });
  });

  it('tool ngoài tool_grants → restricted dù danh mục cho auto_execute (FR-027)', async () => {
    const { broker, handler } = setup({ grants: [] });
    expect((await broker.invoke(makeRun(), publish)).status).toBe('denied');
    expect(handler).not.toHaveBeenCalled();
  });

  it('auto_execute được thực thi và ghi succeeded', async () => {
    const { broker, ledger, handler } = setup({ grants: ['artifact.publish'] });
    const result = await broker.invoke(makeRun(), publish);
    expect(result).toEqual({ status: 'ok', output: { saved: true } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect([...ledger.values()][0]).toMatchObject({ status: 'succeeded', level: 'auto_execute' });
  });

  it('gọi lại hành động dedupe nhận kết quả từ ledger, không thực thi lại', async () => {
    const { broker, handler } = setup({ grants: ['artifact.publish'] });
    await broker.invoke(makeRun(), publish);
    const again = await broker.invoke(makeRun(), publish);
    expect(again.status).toBe('ok');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('sau rework (rework_count khác) cùng input được xem là hành động mới', async () => {
    const { broker, handler } = setup({ grants: ['artifact.publish'] });
    await broker.invoke(makeRun({ reworkCount: 0 }), publish);
    await broker.invoke(makeRun({ reworkCount: 1 }), publish);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('bản ghi failed không chặn lần thử mới (key thêm hậu tố)', async () => {
    const { broker, handler, ledger } = setup({ grants: ['artifact.publish'] });
    handler.mockRejectedValueOnce(new Error('S3 lỗi'));
    expect((await broker.invoke(makeRun(), publish)).status).toBe('error');
    expect((await broker.invoke(makeRun(), publish)).status).toBe('ok');
    expect(handler).toHaveBeenCalledTimes(2);
    expect(ledger.size).toBe(2);
  });

  it('hành động rerun (workspace.read) luôn chạy lại, key theo run + bước', async () => {
    const { broker, handler } = setup({ grants: ['workspace.read'] });
    const call = { name: 'workspace_read', providerCallId: 'p', input: { path: 'a.md' } };
    await broker.invoke(makeRun(), call);
    await broker.invoke(makeRun(), call);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('D6: human_approval bị từ chối (fail-closed), ledger ghi denied', async () => {
    const { broker, ledger, handler } = setup({ grants: ['email.send'] });
    const result = await broker.invoke(makeRun(), {
      name: 'email_send',
      providerCallId: 'p',
      input: { to: ['a@b.vn'], subject: 's', body: 'b' },
    });
    expect(result.status).toBe('denied');
    expect(handler).not.toHaveBeenCalled();
    expect([...ledger.values()][0]).toMatchObject({ actionType: 'email.send', status: 'denied' });
  });

  it('lệnh shell ngoài allowlist → shell.unclassified, restricted', async () => {
    const { broker, evaluate, handler } = setup({ grants: ['workspace.shell'] });
    const result = await broker.invoke(makeRun(), {
      name: 'workspace_shell',
      providerCallId: 'p',
      input: { command: 'rm -rf /' },
    });
    expect(result.status).toBe('denied');
    expect(evaluate.mock.calls[0]?.[1].actionType).toBe('shell.unclassified');
    expect(handler).not.toHaveBeenCalled();
  });

  it('git push qua shell được chuẩn hóa về workspace.git.push (human_approval)', async () => {
    const { broker, evaluate } = setup({ grants: ['workspace.shell', 'workspace.git.push'] });
    const result = await broker.invoke(makeRun(), {
      name: 'workspace_shell',
      providerCallId: 'p',
      input: { command: 'git push origin main' },
    });
    expect(evaluate.mock.calls[0]?.[1]).toMatchObject({
      actionType: 'workspace.git.push',
      input: { remote: 'origin', branch: 'main' },
    });
    expect(result.status).toBe('denied');
  });

  it('lệnh shell trong allowlist chạy ở mức review_required và đánh dấu run phải review', async () => {
    const { broker, handler } = setup({ grants: ['workspace.shell'] });
    const run = makeRun();
    const result = await broker.invoke(run, {
      name: 'workspace_shell',
      providerCallId: 'p',
      input: { command: 'git status' },
    });
    expect(result.status).toBe('ok');
    expect(handler).toHaveBeenCalled();
    expect(run.state.requiresReview).toBe(true);
  });

  it('run bị khóa: trả run_locked, không đánh giá quyền, không thực thi', async () => {
    const { broker, evaluate, handler } = setup({ grants: ['artifact.publish'] });
    const run = makeRun({ state: { locked: true, lockReason: 'Hết ngân sách', requiresReview: false } });
    expect(await broker.invoke(run, publish)).toEqual({ status: 'run_locked', message: 'Hết ngân sách' });
    expect(evaluate).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('task đã rời trạng thái của run (nhân viên bị tạm ngưng → blocked) thì tool bị khóa', async () => {
    const { broker, handler } = setup({ grants: ['artifact.publish'], taskStatus: 'blocked' });
    const result = await broker.invoke(makeRun(), publish);
    expect(result.status).toBe('run_locked');
    expect(handler).not.toHaveBeenCalled();
  });

  it('input sai schema trả lỗi, không đánh giá quyền', async () => {
    const { broker, evaluate } = setup({ grants: ['artifact.publish'] });
    const result = await broker.invoke(makeRun(), { name: 'artifact_publish', providerCallId: 'p', input: {} });
    expect(result.status).toBe('error');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('evaluate chỉ nhận employeeId, actionType, input — không có văn bản prompt/task', async () => {
    const { broker, evaluate } = setup({ grants: ['artifact.publish'] });
    await broker.invoke(makeRun(), publish);
    const req = evaluate.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(req).sort()).toEqual(['actionType', 'employeeId', 'input']);
  });
});
