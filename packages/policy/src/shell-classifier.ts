import { createRequire } from 'node:module';
import { Language, Parser, type Node } from 'web-tree-sitter';
import { ALLOWED_ENV_ASSIGNMENTS, SHELL_ALLOWLIST } from './shell-allowlist';

export type ShellClassification =
  | { actionType: 'workspace.shell'; reason: string }
  | { actionType: 'workspace.git.push'; input: { remote: string; branch: string }; reason: string }
  /** Không thuộc catalog nên `evaluatePermission` luôn trả restricted. */
  | { actionType: 'shell.unclassified'; reason: string };

// Khởi tạo parser một lần; tree-sitter-bash dùng bản wasm nên không cần build native.
const require = createRequire(import.meta.url);
await Parser.init();
const bashLanguage = await Language.load(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'));

const MAX_COMMAND_LENGTH = 4_000;
const SAFE_PATH_REDIRECT = /^(?!\/|~|.*\.\.)[\w./-]+$/;

class Unclassified extends Error {}

function reject(reason: string): never {
  throw new Unclassified(reason);
}

type Collected = { name: string; args: string[] };

type WalkState = {
  commands: Collected[];
  /** Độ sâu command substitution hiện tại (chỉ cho phép 1 cấp). */
  depth: number;
};

/** Giá trị chữ của một đối số; `$(...)` được duyệt đệ quy và thay bằng placeholder. */
function wordValue(node: Node, state: WalkState): string {
  switch (node.type) {
    case 'word':
    case 'number':
    case 'string_content':
      return node.text;
    case 'raw_string':
      return node.text.slice(1, -1);
    case 'string':
    case 'concatenation': {
      let out = '';
      for (const child of node.children) {
        if (child.type === '"') continue;
        out += wordValue(child, state);
      }
      return out;
    }
    case 'command_substitution':
      walkSubstitution(node, state);
      return '<sub>';
    default:
      // Gồm simple_expansion, expansion, arithmetic_expansion, process_substitution, ansi_c_string…
      return reject(`Thành phần shell "${node.type}" không phân tích được`);
  }
}

function walkSubstitution(node: Node, state: WalkState): void {
  if (state.depth >= 1) reject('Command substitution lồng nhau');
  const inner: WalkState = { commands: state.commands, depth: state.depth + 1 };
  for (const child of node.namedChildren) walkStatement(child, inner);
}

function checkRedirect(node: Node, state: WalkState): void {
  if (node.type !== 'file_redirect') reject(`Redirect "${node.type}" không được phép`);
  const dest = node.childForFieldName('destination');
  const op = node.children.find((c) => !c.isNamed)?.text ?? '';
  // `2>&1`, `>&2`: nối stream, không ghi file
  if (op.endsWith('&')) return;
  if (!dest) reject('Redirect thiếu đích');
  const path = wordValue(dest, state);
  if (path === '/dev/null') return;
  if (!SAFE_PATH_REDIRECT.test(path)) reject(`Redirect tới "${path}" nằm ngoài thư mục làm việc`);
}

function handleCommand(node: Node, state: WalkState): void {
  let name: string | null = null;
  const args: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'variable_assignment') {
      const varName = child.childForFieldName('name')?.text ?? '';
      if (!ALLOWED_ENV_ASSIGNMENTS.has(varName)) reject(`Gán biến "${varName}" không được phép`);
      const value = child.childForFieldName('value');
      if (value) wordValue(value, state);
    } else if (child.type === 'command_name') {
      const inner = child.namedChildren;
      const only = inner[0];
      if (inner.length !== 1 || !only || only.type !== 'word')
        reject('Tên lệnh không phải từ thuần');
      name = only.text;
    } else if (child.type === 'file_redirect') {
      checkRedirect(child, state);
    } else {
      args.push(wordValue(child, state));
    }
  }
  if (name === null) reject('Không có tên lệnh');
  state.commands.push({ name, args });
}

function walkStatement(node: Node, state: WalkState): void {
  switch (node.type) {
    case 'program':
    case 'list':
    case 'pipeline':
      for (const child of node.namedChildren) walkStatement(child, state);
      return;
    case 'command':
      handleCommand(node, state);
      return;
    case 'redirected_statement':
      for (const child of node.namedChildren) {
        if (child.type === 'file_redirect') checkRedirect(child, state);
        else walkStatement(child, state);
      }
      return;
    case 'comment':
      return;
    default:
      // subshell, if/for/while, function_definition, heredoc, eval…
      reject(`Cấu trúc shell "${node.type}" không nằm trong allowlist`);
  }
}

function checkAllowlisted(cmd: Collected): void {
  const rule = SHELL_ALLOWLIST[cmd.name];
  if (!rule) reject(`Lệnh "${cmd.name}" không nằm trong allowlist`);
  if (rule.subcommands && !(cmd.args[0] !== undefined && rule.subcommands.includes(cmd.args[0]))) {
    reject(`"${cmd.name} ${cmd.args[0] ?? ''}" không nằm trong allowlist`.replace('  ', ' '));
  }
  const problem = rule.check?.(cmd.args);
  if (problem) reject(problem);
}

/** `git push [-u] <remote> <branch>`; cờ khác (force, delete, mirror…) hoặc thiếu remote/branch → không chuẩn hóa được. */
function normalizeGitPush(args: readonly string[]): { remote: string; branch: string } {
  const positional: string[] = [];
  for (const arg of args.slice(1)) {
    if (arg === '-u' || arg === '--set-upstream') continue;
    if (arg.startsWith('-')) reject(`git push với "${arg}" không chuẩn hóa được`);
    positional.push(arg);
  }
  const [remote, branch] = positional;
  if (
    positional.length !== 2 ||
    !remote ||
    !branch ||
    branch.includes(':') ||
    branch === '<sub>' ||
    remote === '<sub>'
  ) {
    reject('git push thiếu remote/branch rõ ràng');
  }
  return { remote, branch };
}

/**
 * Phân loại một lệnh shell trước khi đánh giá quyền (action-policy.md, "Phân loại lại lệnh shell").
 * Dùng parser AST (tree-sitter-bash), allowlist, không chỉ regex. Không phân tích được → unclassified (restricted).
 */
export function classifyShellCommand(command: string): ShellClassification {
  try {
    if (command.trim() === '') reject('Lệnh rỗng');
    if (command.length > MAX_COMMAND_LENGTH) reject('Lệnh quá dài');
    const parser = new Parser();
    parser.setLanguage(bashLanguage);
    const tree = parser.parse(command);
    if (!tree) reject('Không phân tích được lệnh');
    try {
      if (tree.rootNode.hasError) reject('Cú pháp shell không hợp lệ hoặc không phân tích được');
      const state: WalkState = { commands: [], depth: 0 };
      walkStatement(tree.rootNode, state);
      if (state.commands.length === 0) reject('Không có lệnh nào');

      const pushes: Collected[] = [];
      for (const cmd of state.commands) {
        if (cmd.name === 'git' && cmd.args[0] === 'push') {
          pushes.push(cmd);
          continue;
        }
        checkAllowlisted(cmd);
      }
      if (pushes.length > 1) reject('Nhiều lệnh git push trong một chuỗi');
      const push = pushes[0];
      if (push) {
        return {
          actionType: 'workspace.git.push',
          input: normalizeGitPush(push.args),
          reason: 'git push cần Human Approval',
        };
      }
      return { actionType: 'workspace.shell', reason: 'Mọi lệnh nằm trong allowlist' };
    } finally {
      tree.delete();
      parser.delete();
    }
  } catch (error) {
    if (error instanceof Unclassified)
      return { actionType: 'shell.unclassified', reason: error.message };
    throw error;
  }
}
