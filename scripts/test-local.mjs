// Chạy test contract/integration/security trên máy không có Docker.
//
// Test mặc định dùng Testcontainers (Docker). Script này dựng PostgreSQL (và Redis nếu có) tạm thời từ bản cài sẵn
// trên máy rồi trỏ test vào đó qua TEST_POSTGRES_URL / TEST_REDIS_URL (xem tests/support/containers.ts).
//
// Dùng:
//   node scripts/test-local.mjs                         # contract + integration + security
//   node scripts/test-local.mjs integration security    # chọn nhóm
//   node scripts/test-local.mjs tests/integration/office-audit.spec.ts   # chọn file (tham số khác chuyển cho vitest)
//   pnpm test:local ...                                 # tương đương nếu có pnpm
//
// Yêu cầu: PostgreSQL 16+ (không cần cài thành service: giải nén bản "binaries zip" của EnterpriseDB là đủ).
//   - Tìm theo thứ tự: biến PG_BIN (thư mục chứa pg_ctl/initdb), PATH, C:\Program Files\PostgreSQL\<phiên bản>\bin.
//   - Không chạy bằng quyền Administrator (PostgreSQL từ chối khởi động).
// Redis (tùy chọn): redis-server hoặc Memurai (biến REDIS_BIN, PATH, C:\Program Files\Memurai). Không có Redis thì
// các test cần gateway realtime (outbox-realtime, realtime-propagation, realtime-isolation) bị bỏ qua và các test còn
// lại dùng Redis giả trong bộ nhớ.
// Đặt sẵn TEST_POSTGRES_URL / TEST_REDIS_URL thì script dùng dịch vụ đó và không tự dựng gì.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const EXE = process.platform === 'win32' ? '.exe' : '';
const GROUPS = ['unit', 'contract', 'integration', 'security'];
const NEEDS_REDIS = [
  'tests/integration/outbox-realtime.spec.ts',
  'tests/integration/realtime-propagation.spec.ts',
  'tests/security/realtime-isolation.spec.ts',
];

const log = (message) => process.stdout.write(`[test-local] ${message}\n`);
const cleanups = [];

/** Tìm file thực thi theo danh sách thư mục ứng viên và PATH. */
function findBinary(name, extraDirs = []) {
  const dirs = [...extraDirs, ...(process.env.PATH ?? '').split(delimiter)].filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, name + EXE);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function programFilesDirs(vendor, bin = 'bin') {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const found = [];
  for (const root of roots) {
    const base = join(root, vendor);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base).sort().reverse()) found.push(join(base, entry, bin));
    found.push(base);
  }
  return found;
}

const freePort = () =>
  new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });

async function startPostgres() {
  const pgBin = process.env.PG_BIN ? [process.env.PG_BIN] : programFilesDirs('PostgreSQL');
  const pgCtl = findBinary('pg_ctl', pgBin);
  const initdb = findBinary('initdb', pgBin);
  if (!pgCtl || !initdb) {
    throw new Error(
      'Không tìm thấy PostgreSQL (pg_ctl/initdb). Cài PostgreSQL 16+, hoặc giải nén bản binaries zip và đặt PG_BIN=<thư mục bin>, ' +
        'hoặc đặt TEST_POSTGRES_URL trỏ tới server có sẵn (role superuser).',
    );
  }
  const dir = mkdtempSync(join(tmpdir(), 'cc-test-pg-'));
  const data = join(dir, 'data');
  const port = await freePort();
  log(`Khởi tạo PostgreSQL tạm trong ${dir} (cổng ${port})`);
  execFileSync(initdb, ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C'], {
    stdio: 'ignore',
  });
  cleanups.push(() => {
    try {
      execFileSync(pgCtl, ['-D', data, 'stop', '-m', 'immediate', '-w'], { stdio: 'ignore' });
    } catch {
      /* đã dừng */
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  // fsync tắt cho nhanh: dữ liệu chỉ dùng một lần.
  execFileSync(
    pgCtl,
    [
      '-D',
      data,
      '-o',
      `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=300`,
      '-l',
      join(dir, 'postgres.log'),
      'start',
      '-w',
    ],
    { stdio: 'ignore' },
  );
  return `postgres://postgres@127.0.0.1:${port}/postgres`;
}

async function startRedis() {
  const dirs = process.env.REDIS_BIN
    ? [process.env.REDIS_BIN]
    : [...programFilesDirs('Memurai', ''), ...programFilesDirs('Redis', '')];
  const bin = findBinary('redis-server', dirs) ?? findBinary('memurai', dirs);
  if (!bin) return null;
  const port = await freePort();
  log(`Khởi động Redis tạm (${bin}, cổng ${port})`);
  const child = spawn(
    bin,
    ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'],
    {
      stdio: 'ignore',
    },
  );
  cleanups.push(() => child.kill());
  for (let i = 0; i < 50; i += 1) {
    const ok = await new Promise((r) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => (socket.destroy(), r(true)));
      socket.once('error', () => r(false));
    });
    if (ok) return `redis://127.0.0.1:${port}`;
    await sleep(100);
  }
  throw new Error('Redis không khởi động được');
}

async function main() {
  const args = process.argv.slice(2);
  const groups = args.filter((a) => GROUPS.includes(a));
  const passthrough = args.filter((a) => !GROUPS.includes(a));
  const projects =
    groups.length > 0
      ? groups
      : passthrough.length > 0
        ? []
        : ['contract', 'integration', 'security'];

  const needsDb = projects.length === 0 || projects.some((p) => p !== 'unit');
  const env = { ...process.env };
  const extra = [];

  if (needsDb) {
    env.TEST_POSTGRES_URL ??= await startPostgres();
    if (!env.TEST_REDIS_URL) {
      const redisUrl = await startRedis();
      if (redisUrl) {
        env.TEST_REDIS_URL = redisUrl;
      } else {
        log('Không có Redis: dùng Redis giả; bỏ qua các test cần gateway realtime:');
        for (const file of NEEDS_REDIS) {
          log(`  - ${file}`);
          extra.push('--exclude', file);
        }
        // URL giả chỉ để `startInfra` không đòi container; createTestApp thay bằng Redis trong bộ nhớ.
        env.TEST_REDIS_URL = 'redis://127.0.0.1:1';
        env.TEST_INMEMORY = '1';
      }
    }
  }

  const vitest = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const vitestArgs = [
    'run',
    ...projects.flatMap((p) => ['--project', p]),
    ...extra,
    ...passthrough,
  ];
  log(`vitest ${vitestArgs.join(' ')}`);
  const child = spawn(process.execPath, [vitest, ...vitestArgs], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
  });
  return new Promise((done) => child.on('exit', (code) => done(code ?? 1)));
}

let exiting = false;
async function cleanup() {
  if (exiting) return;
  exiting = true;
  for (const fn of cleanups.reverse()) await fn();
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => void cleanup().then(() => process.exit(130)));
}

main()
  .then(async (code) => {
    await cleanup();
    process.exit(code);
  })
  .catch(async (error) => {
    process.stderr.write(
      `[test-local] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    await cleanup();
    process.exit(1);
  });
