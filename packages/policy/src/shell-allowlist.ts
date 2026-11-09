/**
 * Allowlist lệnh shell (contracts/action-policy.md). Lệnh không khớp allowlist là chưa phân loại → restricted.
 * Mỗi rule trả `null` nếu các đối số hợp lệ, hoặc lý do từ chối.
 */
export type ShellRule = {
  /** Đối số đầu tiên (subcommand) phải thuộc tập này; bỏ trống nghĩa là không ràng buộc. */
  subcommands?: readonly string[];
  /** Kiểm tra bổ sung trên toàn bộ đối số. */
  check?: (args: readonly string[]) => string | null;
};

const FIND_FORBIDDEN = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
]);

function noFindActions(args: readonly string[]): string | null {
  const bad = args.find((a) => FIND_FORBIDDEN.has(a));
  return bad ? `find ${bad} không nằm trong allowlist` : null;
}

export const SHELL_ALLOWLIST: Readonly<Record<string, ShellRule>> = {
  // Lệnh đọc và điều hướng
  ls: {},
  cat: {},
  head: {},
  tail: {},
  wc: {},
  grep: {},
  sort: {},
  uniq: {},
  pwd: {},
  echo: {},
  cd: {},
  find: { check: noFindActions },
  // Build, test, lint đã khai báo
  pnpm: { subcommands: ['test'] },
  npm: { subcommands: ['test'] },
  npx: { subcommands: ['vitest'] },
  pytest: {},
  tsc: {},
  eslint: {},
  // git cục bộ (không cho tùy chọn toàn cục như -c; `git push` xử lý riêng)
  git: { subcommands: ['status', 'diff', 'log', 'add', 'commit'] },
};

/** Biến môi trường được phép đặt trước lệnh (`FOO=1 pnpm test`). */
export const ALLOWED_ENV_ASSIGNMENTS: ReadonlySet<string> = new Set([
  'CI',
  'NODE_ENV',
  'FORCE_COLOR',
  'TZ',
  'LANG',
  'LC_ALL',
]);
