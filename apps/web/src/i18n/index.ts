import type { ErrorCode } from '@claude-company/contracts';
import { ApiError } from '../lib/api';
import { errorMessages, messages, type MessageKey } from './vi';

/** Dịch khóa giao diện; tiếng Việt là ngôn ngữ duy nhất ở v1.0. */
export function t(key: MessageKey): string {
  return messages[key];
}

/** Thông điệp tiếng Việt cho một mã lỗi nghiệp vụ. */
export function errorText(code: ErrorCode | 'NETWORK_ERROR'): string {
  return code === 'NETWORK_ERROR' ? messages['app.networkError'] : errorMessages[code];
}

/** Chuyển lỗi bất kỳ thành thông điệp hiển thị cho người dùng. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return errorText(error.code);
  return errorMessages.INTERNAL;
}

export { errorMessages, messages, type MessageKey };
