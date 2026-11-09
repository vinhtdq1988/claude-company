import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { trace } from '@opentelemetry/api';

const store = new AsyncLocalStorage<{ traceId: string }>();

const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i;

/** Trace id từ span OpenTelemetry đang hoạt động, rồi tới `traceparent`, cuối cùng sinh mới. */
export function resolveTraceId(traceparent?: string | string[]): string {
  const active = trace.getActiveSpan()?.spanContext().traceId;
  if (active && /^0+$/.test(active) === false) return active;
  const header = Array.isArray(traceparent) ? traceparent[0] : traceparent;
  const match = header ? TRACEPARENT.exec(header) : null;
  return match?.[1]?.toLowerCase() ?? randomBytes(16).toString('hex');
}

export function runWithTrace<T>(traceId: string, fn: () => T): T {
  return store.run({ traceId }, fn);
}

export function currentTraceId(): string | undefined {
  return store.getStore()?.traceId;
}
