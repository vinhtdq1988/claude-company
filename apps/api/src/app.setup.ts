import type { INestApplication } from '@nestjs/common';
import type { AppConfig } from './platform/config/config';
import { JsonLogger } from './platform/observability/json-logger';

export const API_PREFIX = 'api/v1';

/** Cấu hình dùng chung cho main.ts và test: tiền tố `/api/v1`, CORS cho web, logger JSON, shutdown hook. */
export function configureApp(app: INestApplication, config: Pick<AppConfig, 'WEB_ORIGIN'>): void {
  app.useLogger(new JsonLogger());
  app.setGlobalPrefix(API_PREFIX);
  app.enableCors({ origin: config.WEB_ORIGIN, credentials: true });
  app.enableShutdownHooks();
}
