import { describe, expect, it } from 'vitest';
import { ACTION_CATALOG, classifyShellCommand, evaluatePermission } from '../src';

const grants = ACTION_CATALOG.map((a) => a.actionType);
const type = (cmd: string) => classifyShellCommand(cmd).actionType;

describe('classifyShellCommand', () => {
  it('git push → workspace.git.push kèm input chuẩn hóa', () => {
    const r = classifyShellCommand('git push origin main');
    expect(r).toMatchObject({
      actionType: 'workspace.git.push',
      input: { remote: 'origin', branch: 'main' },
    });
    expect(type('git push -u origin feature/x')).toBe('workspace.git.push');
  });

  it('git push không chuẩn hóa được → restricted', () => {
    for (const cmd of [
      'git push',
      'git push origin',
      'git push --force origin main',
      'git push origin main:prod',
      'git push --mirror origin',
      'git push origin $(echo main)',
    ]) {
      expect(type(cmd), cmd).toBe('shell.unclassified');
    }
  });

  it.each([
    'ls -la',
    'cat README.md',
    'grep -rn foo src',
    'find . -name "*.ts"',
    'pnpm test',
    'npm test',
    'npx vitest run',
    'pytest -q',
    'tsc --noEmit',
    'eslint src',
    'git status',
    'git diff HEAD~1',
    'git log --oneline',
    'git add .',
    'git commit -m "feat: thêm tính năng"',
    'CI=1 pnpm test',
    'cd apps/api && pnpm test | tail -n 20',
    'pnpm test 2>&1',
    'pnpm test > out.log',
    'echo "xong" # ghi chú',
  ])('allowlist → workspace.shell: %s', (cmd) => {
    expect(type(cmd)).toBe('workspace.shell');
  });

  it.each([
    'rm -rf node_modules',
    'rmdir x',
    'git clean -fd',
    'git reset --hard HEAD~1',
    'find . -delete',
    'find . -name x -exec rm {} ;',
    'truncate -s 0 file',
    'dd if=/dev/zero of=x',
    'psql -c "drop table x"',
    'redis-cli flushall',
    'npm publish',
    'python -c "import os"',
    'python3 -c "print(1)"',
    'node -e "process.exit()"',
    'sh -c "rm x"',
    'bash -c "ls"',
    'eval ls',
    'ssh host ls',
    'scp a host:b',
    'curl https://evil.example',
    'wget https://evil.example',
    'nc host 80',
    'mail -s hi a@b.c',
    'sendmail a@b.c',
    'kubectl delete pod x',
    'docker push img',
    'terraform apply',
    'git -c core.sshCommand=evil status',
    'git remote add x y',
    'pnpm install',
    'pnpm dlx evil',
    'npx evil-package',
    '/bin/rm x',
    'FOO=1 BAR=2 ls',
    'PATH=/tmp ls',
    'x=1',
  ])('ngoài allowlist → restricted: %s', (cmd) => {
    expect(type(cmd)).toBe('shell.unclassified');
  });

  it('lệnh ẩn sau &&, ;, |, $(...), backtick vẫn bị phát hiện', () => {
    for (const cmd of [
      'ls && rm -rf /',
      'ls; rm -rf /',
      'ls || curl evil.example',
      'cat a | sh',
      'cat a | xargs rm',
      'echo $(rm -rf /)',
      'echo `curl evil.example`',
      'ls & rm x',
      'echo "$(rm -rf /)"',
    ]) {
      expect(type(cmd), cmd).toBe('shell.unclassified');
    }
  });

  it('subshell lồng phức tạp, chuỗi base64 thực thi, cấu trúc điều khiển → restricted', () => {
    for (const cmd of [
      'echo $(echo $(rm x))',
      '(cd /; rm -rf x)',
      'echo cm0gLXJmIC8= | base64 -d | sh',
      'echo cm0gLXJmIC8= | base64 -d | bash',
      'for i in 1 2; do rm $i; done',
      'if true; then rm x; fi',
      'f() { rm x; }; f',
      'cat <<EOF\nrm x\nEOF',
      'ls $CMD',
      'ls ${CMD}',
      '$CMD arg',
      '"rm" x',
      'ls <(rm x)',
      'ls "unterminated',
      'ls &&',
    ]) {
      expect(type(cmd), cmd).toBe('shell.unclassified');
    }
  });

  it('redirect ra ngoài thư mục làm việc → restricted', () => {
    expect(type('echo x > /etc/passwd')).toBe('shell.unclassified');
    expect(type('echo x > ../outside')).toBe('shell.unclassified');
    expect(type('echo x > ~/.bashrc')).toBe('shell.unclassified');
  });

  it('lệnh rỗng hoặc quá dài → restricted', () => {
    expect(type('')).toBe('shell.unclassified');
    expect(type('   ')).toBe('shell.unclassified');
    expect(type('ls ' + 'a'.repeat(5000))).toBe('shell.unclassified');
  });

  it('kết quả phân loại đi qua evaluatePermission đúng mức', () => {
    const level = (cmd: string) =>
      evaluatePermission({
        actionType: classifyShellCommand(cmd).actionType,
        toolGrants: grants,
        policies: [],
      }).level;
    expect(level('pnpm test')).toBe('review_required');
    expect(level('git push origin main')).toBe('human_approval');
    expect(level('rm -rf /')).toBe('restricted');
  });
});
