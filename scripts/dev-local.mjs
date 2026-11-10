// Chạy toàn bộ stack để test thủ công trên máy không có Docker/pnpm.
//
//   node scripts/dev-local.mjs            # khởi động PostgreSQL, Redis, S3 giả, migrate+seed, api, worker, web
//   node scripts/dev-local.mjs --reset    # xóa dữ liệu dev (PostgreSQL, S3, workspace) trước khi chạy
//   node scripts/dev-local.mjs --build    # chỉ build web (vite build) rồi thoát
//
// Giao diện http://localhost:5173, API http://localhost:3000/api/v1 (tài liệu: /api/v1/docs). Dừng bằng Ctrl+C.
//
// Yêu cầu:
//   - Node.js 24; đã `pnpm install` (thư mục node_modules có sẵn).
//   - PostgreSQL 16+ (PG_BIN, PATH hoặc C:\Program Files\PostgreSQL\<bản>\bin). Cluster riêng được tạo một lần ở
//     <CC_DEV_DIR>/pgdata (cổng 55432), không đụng tới PostgreSQL đang chạy của máy.
//   - Redis 6.2+ (REDIS_BIN hoặc <CC_DEV_DIR>/redis/**/redis-server.exe). Bản Windows: github.com/redis-windows/redis-windows.
//   - S3: dùng scripts/dev-s3.mjs (MinIO đã ngừng phân phối bản cài).
// CC_DEV_DIR mặc định: %LOCALAPPDATA%\cc-dev-stack (hoặc ~/.cc-dev-stack). MODEL_PROVIDER mặc định `fake` (không tốn token);
// đặt MODEL_PROVIDER=anthropic và ANTHROPIC_API_KEY trong môi trường để chạy Claude thật.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { startS3Mock } from './dev-s3.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const EXE = process.platform === 'win32' ? '.exe' : '';
const STACK =
  process.env.CC_DEV_DIR ??
  join(process.env.LOCALAPPDATA ?? join(homedir(), '.cache'), 'cc-dev-stack');
const PORTS = { pg: 55432, redis: 56379, s3: 59000, api: 3000, web: 5173 };
const DB = 'claude_company';
const APP_DB_PASSWORD = 'dev-app-password';
const args = new Set(process.argv.slice(2));

const log = (message) => process.stdout.write(`[dev] ${message}\n`);
const cleanups = [];

function findBinary(name, extraDirs = []) {
  const dirs = [...extraDirs, ...(process.env.PATH ?? '').split(delimiter)].filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, name + EXE);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Mọi thư mục dưới `base` (tối đa `depth` cấp) để tìm file thực thi trong bản giải nén có thư mục con. */
function walkDirs(base, depth = 2) {
  if (!existsSync(base)) return [];
  const out = [base];
  if (depth > 0) {
    for (const entry of readdirSync(base)) {
      const sub = join(base, entry);
      if (statSync(sub).isDirectory()) out.push(...walkDirs(sub, depth - 1));
    }
  }
  return out;
}

const isListening = (port) =>
  new Promise((done) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), done(true)));
    socket.once('error', () => done(false));
  });

async function waitForPort(port, label, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    if (await isListening(port)) return;
    await sleep(150);
  }
  throw new Error(`${label} không khởi động được (cổng ${port})`);
}

async function startPostgres() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const candidates = process.env.PG_BIN
    ? [process.env.PG_BIN]
    : roots.flatMap((r) =>
        existsSync(join(r, 'PostgreSQL'))
          ? readdirSync(join(r, 'PostgreSQL'))
              .sort()
              .reverse()
              .map((v) => join(r, 'PostgreSQL', v, 'bin'))
          : [],
      );
  const pgCtl = findBinary('pg_ctl', candidates);
  const initdb = findBinary('initdb', candidates);
  if (!pgCtl || !initdb)
    throw new Error('Không tìm thấy PostgreSQL (pg_ctl/initdb). Đặt PG_BIN=<thư mục bin>.');

  const data = join(STACK, 'pgdata');
  if (!existsSync(join(data, 'PG_VERSION'))) {
    log(`Tạo cluster PostgreSQL dev tại ${data}`);
    mkdirSync(STACK, { recursive: true });
    execFileSync(
      initdb,
      ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C'],
      { stdio: 'ignore' },
    );
  }
  if (!(await isListening(PORTS.pg))) {
    log(`Khởi động PostgreSQL (cổng ${PORTS.pg})`);
    execFileSync(
      pgCtl,
      [
        '-D',
        data,
        '-o',
        `-p ${PORTS.pg} -c listen_addresses=127.0.0.1 -c max_connections=200`,
        '-l',
        join(STACK, 'postgres.log'),
        'start',
        '-w',
      ],
      { stdio: 'ignore' },
    );
    cleanups.push(() => {
      try {
        execFileSync(pgCtl, ['-D', data, 'stop', '-m', 'fast', '-w'], { stdio: 'ignore' });
      } catch {
        /* đã dừng */
      }
    });
  } else {
    log(`PostgreSQL đã chạy ở cổng ${PORTS.pg}, dùng lại`);
  }
  const admin = new pg.Client({
    connectionString: `postgres://postgres@127.0.0.1:${PORTS.pg}/postgres`,
  });
  await admin.connect();
  const exists = await admin.query('select 1 from pg_database where datname = $1', [DB]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();
}

async function startRedis() {
  const bin = findBinary('redis-server', [
    ...(process.env.REDIS_BIN ? [process.env.REDIS_BIN] : []),
    ...walkDirs(join(STACK, 'redis')),
  ]);
  if (!bin)
    throw new Error(
      `Không tìm thấy redis-server. Giải nén Redis cho Windows vào ${join(STACK, 'redis')} hoặc đặt REDIS_BIN.`,
    );
  if (await isListening(PORTS.redis)) return log(`Redis đã chạy ở cổng ${PORTS.redis}, dùng lại`);
  log(`Khởi động Redis (cổng ${PORTS.redis})`);
  const child = spawn(
    bin,
    ['--port', String(PORTS.redis), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'],
    { stdio: 'ignore', cwd: STACK },
  );
  cleanups.push(() => child.kill());
  await waitForPort(PORTS.redis, 'Redis');
}

async function startS3() {
  if (await isListening(PORTS.s3)) return log(`S3 giả đã chạy ở cổng ${PORTS.s3}, dùng lại`);
  log(`Khởi động S3 giả (cổng ${PORTS.s3})`);
  const server = await startS3Mock({ dir: join(STACK, 's3data'), port: PORTS.s3 });
  cleanups.push(() => server.close());
}

const dirs = {
  workspaces: join(STACK, 'workspaces'),
  worktrees: join(STACK, 'worktrees'),
  dryRun: join(STACK, 'dry-run'),
};

const baseUrl = `postgres://postgres@127.0.0.1:${PORTS.pg}/${DB}`;
const env = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(PORTS.api),
  WEB_ORIGIN: `http://localhost:${PORTS.web}`,
  DATABASE_MIGRATION_URL: baseUrl,
  DATABASE_URL: `postgres://app_user:${APP_DB_PASSWORD}@127.0.0.1:${PORTS.pg}/${DB}`,
  APP_DB_PASSWORD,
  REDIS_URL: `redis://127.0.0.1:${PORTS.redis}`,
  S3_ENDPOINT: `http://127.0.0.1:${PORTS.s3}`,
  S3_BUCKET: 'claude-company-artifacts',
  S3_ACCESS_KEY: 'dev',
  S3_SECRET_KEY: 'dev-secret',
  S3_FORCE_PATH_STYLE: 'true',
  SESSION_SECRET: process.env.SESSION_SECRET ?? 'dev-only-session-secret-0123456789abcdef',
  MODEL_PROVIDER: process.env.MODEL_PROVIDER ?? 'fake',
  ADAPTER_MODE: 'dry_run',
  WORKSPACE_HOST_PATH: dirs.workspaces,
  RUN_WORKTREES_PATH: dirs.worktrees,
  DRY_RUN_LOG_PATH: dirs.dryRun,
};

const SWC = ['--import', '@swc-node/register/esm-register'];

/** Chạy một tiến trình Node trong `cwd`, gắn tiền tố nhãn vào mỗi dòng log. */
function run(label, cwd, nodeArgs, extraEnv = {}) {
  const child = spawn(process.execPath, nodeArgs, {
    cwd,
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pipe = (stream, sink) => {
    let rest = '';
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) sink.write(`[${label}] ${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  const exited = new Promise((done) => child.on('exit', (code) => done(code ?? 1)));
  return { child, exited };
}

async function runOnce(label, cwd, nodeArgs) {
  const { exited } = run(label, cwd, nodeArgs);
  const code = await exited;
  if (code !== 0) throw new Error(`${label} thất bại (mã ${code})`);
}

async function cleanup() {
  for (const fn of cleanups.reverse()) await fn();
}

async function main() {
  const viteJs = join(ROOT, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js');
  if (args.has('--build')) {
    await runOnce('web-build', join(ROOT, 'apps', 'web'), [viteJs, 'build']);
    return 0;
  }
  if (args.has('--reset')) {
    log(`Xóa dữ liệu dev trong ${STACK} (giữ lại Redis đã giải nén)`);
    for (const name of ['pgdata', 's3data', 'workspaces', 'worktrees', 'dry-run'])
      rmSync(join(STACK, name), { recursive: true, force: true });
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });

  await startPostgres();
  await startRedis();
  await startS3();

  log('Migration và seed');
  const apiDir = join(ROOT, 'apps', 'api');
  await runOnce('migrate', apiDir, [...SWC, join(ROOT, 'packages', 'db', 'src', 'migrate.ts')]);
  await runOnce('seed', apiDir, [...SWC, join(ROOT, 'packages', 'db', 'src', 'seed.ts')]);

  const procs = [
    run('api', apiDir, [...SWC, 'src/main.ts']),
    run('worker', join(ROOT, 'apps', 'worker'), [...SWC, 'src/main.ts']),
    run('web', join(ROOT, 'apps', 'web'), [
      viteJs,
      '--host',
      '127.0.0.1',
      '--port',
      String(PORTS.web),
      '--strictPort',
    ]),
  ];
  for (const { child } of procs) cleanups.push(() => child.kill());
  await waitForPort(PORTS.api, 'API', 300);
  await waitForPort(PORTS.web, 'Web', 100);
  log('────────────────────────────────────────────────────────────');
  log(`Giao diện : http://localhost:${PORTS.web}`);
  log(`API       : http://localhost:${PORTS.api}/api/v1   (tài liệu: /api/v1/docs)`);
  log(`Model     : ${env.MODEL_PROVIDER}   Dữ liệu: ${STACK}`);
  log('Nhấn Ctrl+C để dừng.');
  log('────────────────────────────────────────────────────────────');
  // Một tiến trình chết thì dừng cả stack để không chạy trong trạng thái nửa vời.
  const first = await Promise.race(procs.map((p) => p.exited));
  log(`Một tiến trình đã thoát (mã ${first}); dừng stack.`);
  return first;
}

let exiting = false;
async function shutdown(code) {
  if (exiting) return;
  exiting = true;
  await cleanup();
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutdown(0));

main().then(
  (code) => shutdown(code),
  async (error) => {
    process.stderr.write(`[dev] ${error instanceof Error ? error.message : String(error)}\n`);
    await shutdown(1);
  },
);
