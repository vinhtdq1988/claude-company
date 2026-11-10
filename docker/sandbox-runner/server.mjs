// sandbox-runner: nơi duy nhất chạy lệnh shell/test do agent sinh ra (R4, action-policy.md).
// Mỗi run chạy bằng một UID không đặc quyền riêng; thư mục /worktrees/{runId} thuộc UID đó, group của worker,
// mode 2770 (setgid), thư mục cha 0711. Env của lệnh đã xóa sạch secret. Service nằm trong mạng `sandbox` nội bộ,
// không có đường tới Postgres, Redis, MinIO, API model hay internet.
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { chown, lchown, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path/posix';

/** runId là UUID (v7); chỉ chấp nhận đúng dạng này để không thể chèn đường dẫn. */
export const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_COMMAND_CHARS = 20_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
/** UID của run nằm trong dải này, tránh các UID hệ thống và UID của worker. */
const UID_MIN = 100_000;
const UID_SPAN = 4_000_000;

/** Env tối thiểu cho lệnh của agent: không kế thừa env của service (token, cấu hình). */
export function buildCommandEnv(dir) {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: dir,
    TMPDIR: join(dir, '.tmp'),
    LANG: 'C.UTF-8',
    CI: '1',
  };
}

/** UID khởi đầu của run, tất định theo runId; va chạm với UID đang dùng thì dò tuyến tính. */
export function pickUid(runId, taken) {
  const digest = createHash('sha256').update(runId).digest();
  let uid = UID_MIN + (digest.readUInt32BE(0) % UID_SPAN);
  while (taken.has(uid)) uid = UID_MIN + ((uid - UID_MIN + 1) % UID_SPAN);
  return uid;
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Body quá lớn'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Body không phải JSON'), { status: 400 });
  }
}

/**
 * `deps` cho phép test thay hệ thống file và tiến trình. Mặc định dùng `node:fs/promises` và `node:child_process`
 * (cần root với CAP_CHOWN, CAP_SETUID, CAP_SETGID).
 */
export function createSandboxServer(config, deps = {}) {
  const fs = deps.fs ?? { chown, lchown, lstat, mkdir, readdir, readFile, writeFile };
  const run = deps.spawn ?? spawn;
  const { token, worktreesDir, workerGid, stateFile } = config;
  if (!token || token.length < 16) throw new Error('SANDBOX_TOKEN phải có ít nhất 16 ký tự');

  const dirOf = (runId) => join(worktreesDir, runId);

  /**
   * Sổ đăng ký runId → UID, lưu trong volume riêng của sandbox. Thư mục cha `0711` không cho sandbox liệt kê
   * (nó chỉ có CAP_CHOWN, SETUID, SETGID) nên không thể dò UID đang dùng từ owner của các thư mục.
   */
  let registry = null;
  async function loadRegistry() {
    if (registry) return registry;
    registry = new Map();
    if (stateFile) {
      try {
        for (const [runId, uid] of Object.entries(JSON.parse(await fs.readFile(stateFile, 'utf8'))))
          registry.set(runId, uid);
      } catch {
        // chưa có sổ: bắt đầu trống
      }
    }
    return registry;
  }
  async function persistRegistry() {
    if (stateFile) await fs.writeFile(stateFile, JSON.stringify(Object.fromEntries(registry)));
  }

  async function uidOf(runId) {
    const uid = (await loadRegistry()).get(runId);
    if (uid === undefined)
      throw Object.assign(new Error('Run chưa được chuẩn hóa (prepare)'), { status: 409 });
    const info = await fs.lstat(dirOf(runId));
    // Owner của thư mục phải khớp sổ: nếu không, không chạy lệnh (ngăn chạy dưới UID sai).
    if (info.uid !== uid)
      throw Object.assign(new Error('Owner thư mục run không khớp UID đã cấp'), { status: 409 });
    return uid;
  }

  /**
   * Đặt owner = UID của run, group = worker. Worker đã tạo thư mục (mode 2770, setgid) và chuẩn hóa mode con để
   * sandbox, vốn không có DAC_OVERRIDE, duyệt được cây. Gọi lại với run đã chuẩn hóa là no-op.
   */
  async function prepare(runId) {
    const dir = dirOf(runId);
    let info;
    try {
      info = await fs.lstat(dir);
    } catch {
      throw Object.assign(new Error('Thư mục run không tồn tại'), { status: 404 });
    }
    if (!info.isDirectory())
      throw Object.assign(new Error('Đường dẫn run không phải thư mục'), { status: 409 });
    const map = await loadRegistry();
    const known = map.get(runId);
    if (known !== undefined && info.uid === known) return known;

    const taken = new Set(map.values());
    const uid = known ?? pickUid(runId, taken);
    await chownTree(dir, uid, workerGid);
    map.set(runId, uid);
    await persistRegistry();
    // `.tmp` riêng của run (TMPDIR), không dùng /tmp dùng chung.
    await fs.mkdir(join(dir, '.tmp'), { recursive: true });
    await fs.chown(join(dir, '.tmp'), uid, workerGid);
    return uid;
  }

  async function chownTree(path, uid, gid) {
    const info = await fs.lstat(path);
    // lchown không theo symlink: symlink trong thư mục run không thể kéo chown ra ngoài.
    await fs.lchown(path, uid, gid);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      for (const entry of await fs.readdir(path)) await chownTree(join(path, entry), uid, gid);
    }
  }

  function exec({ runId, command, timeoutMs }, uid) {
    const dir = dirOf(runId);
    return new Promise((resolve) => {
      // umask 007: file do lệnh tạo ra đọc/ghi được bởi group worker (thư mục setgid) nhưng không bởi UID khác.
      const child = run('/bin/sh', ['-c', `umask 007; ${command}`], {
        cwd: dir,
        env: buildCommandEnv(dir),
        uid,
        gid: uid,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const append = (current, chunk) =>
        current.length >= MAX_OUTPUT_BYTES
          ? current
          : current + chunk.toString('utf8').slice(0, MAX_OUTPUT_BYTES - current.length);
      child.stdout?.on('data', (c) => (stdout = append(stdout, c)));
      child.stderr?.on('data', (c) => (stderr = append(stderr, c)));
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, 'SIGKILL'); // cả nhóm tiến trình, gồm tiến trình con
        } catch {
          child.kill('SIGKILL');
        }
      }, timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ exitCode: 127, stdout, stderr: `${stderr}${error.message}`, timedOut: false });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? (signal ? 137 : 1), stdout, stderr, timedOut });
      });
    });
  }

  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      if (request.method === 'GET' && request.url === '/healthz') return send(200, { ok: true });
      const auth = request.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), token)) {
        return send(401, { error: 'Thiếu hoặc sai token' });
      }
      if (request.method !== 'POST') return send(405, { error: 'Chỉ nhận POST' });
      const body = await readJson(request);
      if (typeof body.runId !== 'string' || !RUN_ID_PATTERN.test(body.runId)) {
        return send(400, { error: 'runId không hợp lệ' });
      }
      if (request.url === '/prepare') {
        await prepare(body.runId);
        return send(200, { ok: true });
      }
      if (request.url === '/exec') {
        if (
          typeof body.command !== 'string' ||
          body.command.length === 0 ||
          body.command.length > MAX_COMMAND_CHARS
        ) {
          return send(400, { error: 'command không hợp lệ' });
        }
        const timeoutMs = Math.min(
          Math.max(Number(body.timeoutMs) || 60_000, 1_000),
          MAX_TIMEOUT_MS,
        );
        const uid = await uidOf(body.runId);
        return send(200, await exec({ runId: body.runId, command: body.command, timeoutMs }, uid));
      }
      return send(404, { error: 'Không có đường dẫn này' });
    } catch (error) {
      send(error.status ?? 500, { error: error.status ? error.message : 'Lỗi nội bộ' });
    }
  });
  return { server, prepare, uidOf };
}

// Chạy trực tiếp: `node server.mjs`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.mjs')) {
  const gid = Number(process.env.WORKER_GID ?? '');
  if (!Number.isInteger(gid) || gid < 1) throw new Error('WORKER_GID là bắt buộc (gid của worker)');
  const { server } = createSandboxServer({
    token: process.env.SANDBOX_TOKEN ?? '',
    worktreesDir: process.env.WORKTREES_DIR ?? '/worktrees',
    workerGid: gid,
    stateFile: process.env.STATE_FILE ?? '/var/lib/sandbox/uids.json',
  });
  // Xóa token khỏi env của chính tiến trình để lệnh con (đã có env riêng) cũng không thể thừa hưởng nó.
  delete process.env.SANDBOX_TOKEN;
  server.listen(Number(process.env.PORT ?? 8081), '0.0.0.0');
}
