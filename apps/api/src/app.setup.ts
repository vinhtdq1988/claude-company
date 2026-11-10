import type { INestApplication } from '@nestjs/common';
import type { AppConfig } from './platform/config/config';
import { registerOpenApi } from './platform/http/openapi';
import { API_PREFIX } from './platform/http/prefix';
import { securityHeaders } from './platform/http/security';
import { JsonLogger } from './platform/observability/json-logger';

export { API_PREFIX };

/**
 * Cấu hình dùng chung cho main.ts và test: tiền tố `/api/v1`, header bảo mật và CSP, CORS cho web, logger JSON,
 * tài liệu OpenAPI (không phải production), shutdown hook.
 */
export function configureApp(
  app: INestApplication,
  config: Pick<AppConfig, 'WEB_ORIGIN' | 'NODE_ENV' | 'TRUST_PROXY'>,
): void {
  app.useLogger(new JsonLogger());
  app.setGlobalPrefix(API_PREFIX);
  const express = app.getHttpAdapter().getInstance() as {
    disable(name: string): void;
    set(name: string, value: unknown): void;
  };
  express.disable('x-powered-by');
  // Sau nginx: tin `X-Forwarded-For` của một proxy để `req.ip` là IP người dùng (rate limit đăng nhập).
  if (config.TRUST_PROXY) express.set('trust proxy', 1);
  app.use(securityHeaders({ production: config.NODE_ENV === 'production' }));
  registerOpenApi(app, config);
  app.enableCors({ origin: config.WEB_ORIGIN, credentials: true });
  app.enableShutdownHooks();
}
