import {
  Global,
  Module,
  type MiddlewareConsumer,
  type NestMiddleware,
  Injectable,
  type NestModule,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { resolveTraceId, runWithTrace } from './trace';

declare module 'express-serve-static-core' {
  interface Request {
    traceId?: string;
  }
}

/** Gắn trace id vào request, response (`x-trace-id`) và AsyncLocalStorage cho logger. */
@Injectable()
export class TraceMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const traceId = resolveTraceId(req.headers.traceparent);
    req.traceId = traceId;
    res.setHeader('x-trace-id', traceId);
    runWithTrace(traceId, next);
  }
}

@Global()
@Module({ providers: [TraceMiddleware], exports: [TraceMiddleware] })
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceMiddleware).forRoutes('*path');
  }
}
