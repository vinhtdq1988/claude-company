import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/platform/config/config';

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://app_user:x@127.0.0.1:1/x',
  REDIS_URL: 'redis://127.0.0.1:1',
  SESSION_SECRET: 'test-session-secret-test-session-secret',
  S3_ENDPOINT: 'http://127.0.0.1:1',
  S3_BUCKET: 'b',
  S3_ACCESS_KEY: 'a',
  S3_SECRET_KEY: 'bbbbbbbbbbbb',
};

describe('MODEL_PROVIDER', () => {
  it('claude_subscription chạy local không cần ANTHROPIC_API_KEY', () => {
    for (const NODE_ENV of ['development', 'test']) {
      const config = loadConfig({ ...base, NODE_ENV, MODEL_PROVIDER: 'claude_subscription' });
      expect(config.MODEL_PROVIDER).toBe('claude_subscription');
    }
  });

  it('claude_subscription bị từ chối khi NODE_ENV=production', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', MODEL_PROVIDER: 'claude_subscription' }),
    ).toThrow(/production phải đặt MODEL_PROVIDER=anthropic/);
  });

  it('production dùng anthropic và bắt buộc API key', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', MODEL_PROVIDER: 'anthropic' }),
    ).toThrow(/ANTHROPIC_API_KEY/);
    const config = loadConfig({
      ...base,
      NODE_ENV: 'production',
      MODEL_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-prod',
    });
    expect(config.MODEL_PROVIDER).toBe('anthropic');
  });

  it('mặc định là fake', () => {
    expect(loadConfig(base).MODEL_PROVIDER).toBe('fake');
  });
});
