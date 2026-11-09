import { ArgumentsHost, Catch, HttpException, Logger, type ExceptionFilter } from '@nestjs/common';
import { DomainError, type ErrorBody, type ErrorCode } from '@claude-company/contracts';
import type { Response } from 'express';
import { ZodError } from 'zod';

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION_FAILED',
};

function body(code: ErrorCode, message: string, details: Record<string, unknown> = {}): ErrorBody {
  return { error: { code, message, details } };
}

/** Định dạng lỗi thống nhất `{ error: { code, message, details } }`; 409 cho xung đột, 422 cho validation. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, payload } = this.translate(exception);
    if (status >= 500)
      this.logger.error(exception instanceof Error ? exception : String(exception));
    res.status(status).json(payload);
  }

  private translate(exception: unknown): { status: number; payload: ErrorBody } {
    if (exception instanceof DomainError) {
      return {
        status: exception.httpStatus,
        payload: body(exception.code, exception.message, exception.details),
      };
    }
    if (exception instanceof ZodError) {
      return {
        status: 422,
        payload: body('VALIDATION_FAILED', 'Dữ liệu không hợp lệ', { issues: exception.issues }),
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = STATUS_TO_CODE[status] ?? (status >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED');
      const response = exception.getResponse();
      const message = typeof response === 'string' ? response : exception.message;
      return { status, payload: body(code, message) };
    }
    return { status: 500, payload: body('INTERNAL', 'Lỗi hệ thống') };
  }
}
