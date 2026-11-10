import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Chuẩn hóa CRLF (file trong repo có thể là CRLF trên Windows) để regex theo dòng hoạt động.
const read = (file: string) =>
  readFileSync(join(__dirname, '../../../../docker', file), 'utf8').replaceAll('\r\n', '\n');

/** Phần định nghĩa của một service trong compose: từ `  <tên>:` tới service kế tiếp (hoặc `volumes:` gốc). */
function service(compose: string, name: string): string {
  const match = compose.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|^\\S)`, 'm'));
  if (!match) throw new Error(`Không thấy service ${name} trong docker-compose.yml`);
  return match[1] ?? '';
}

describe('docker-compose.yml (T196)', () => {
  const compose = read('docker-compose.yml');

  it('có đủ các service của plan.md', () => {
    for (const name of [
      'postgres',
      'redis',
      'minio',
      'migrate',
      'api',
      'worker',
      'sandbox-runner',
      'egress-proxy',
      'web',
    ]) {
      expect(() => service(compose, name), name).not.toThrow();
    }
  });

  it('migration và seed chạy một lần trước api và worker (DB mới không có schema nếu thiếu bước này)', () => {
    const migrate = service(compose, 'migrate');
    expect(migrate).toContain('packages/db/src/migrate.ts');
    expect(migrate).toContain('packages/db/src/seed.ts');
    expect(migrate).toMatch(/restart: 'no'/);
    for (const name of ['api', 'worker']) {
      expect(service(compose, name), name).toMatch(
        /migrate:\n\s+condition: service_completed_successfully/,
      );
    }
  });

  it('chỉ api, web, minio (console) và egress-proxy nối mạng edge; sandbox-runner chỉ ở mạng sandbox', () => {
    expect(service(compose, 'sandbox-runner')).toContain('networks: [sandbox]');
    expect(service(compose, 'worker')).toContain('networks: [backend, sandbox]');
    expect(service(compose, 'postgres')).toContain('networks: [backend]');
    expect(service(compose, 'redis')).toContain('networks: [backend]');
  });

  it('API đứng sau nginx nên tin X-Forwarded-For; worker không chạy với biến này', () => {
    expect(service(compose, 'api')).toContain("TRUST_PROXY: 'true'");
    expect(service(compose, 'worker')).not.toContain('TRUST_PROXY');
  });

  it('mọi service phụ thuộc service_healthy đều có HEALTHCHECK (compose hoặc Dockerfile)', () => {
    const dockerfiles = {
      'egress-proxy': read('egress-proxy/Dockerfile'),
      'sandbox-runner': read('sandbox-runner/Dockerfile'),
    } as const;
    for (const name of ['postgres', 'redis', 'minio']) {
      expect(service(compose, name), name).toContain('healthcheck:');
    }
    for (const [name, dockerfile] of Object.entries(dockerfiles)) {
      expect(dockerfile, name).toContain('HEALTHCHECK');
    }
  });

  it('biến cấu hình rate limit có trong compose và .env.example', () => {
    const env = read('.env.example');
    for (const name of ['LOGIN_RATE_LIMIT_MAX', 'LOGIN_RATE_LIMIT_WINDOW_MS']) {
      expect(compose, name).toContain(name);
      expect(env, name).toContain(name);
    }
  });
});
