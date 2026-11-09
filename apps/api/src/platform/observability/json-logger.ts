import type { LoggerService } from '@nestjs/common';
import { redact } from './redact';
import { currentTraceId } from './trace';

type Level = 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';

/** Logger JSON một dòng, gắn trace id, che secret. */
export class JsonLogger implements LoggerService {
  constructor(
    private readonly sink: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
  ) {}

  private write(level: Level, message: unknown, rest: unknown[]): void {
    const context = typeof rest[rest.length - 1] === 'string' ? (rest.pop() as string) : undefined;
    const entry = {
      time: new Date().toISOString(),
      level,
      context,
      traceId: currentTraceId(),
      message: redact(message),
      ...(rest.length > 0 ? { data: redact(rest.length === 1 ? rest[0] : rest) } : {}),
    };
    this.sink(JSON.stringify(entry));
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.write('log', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('verbose', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }
}
