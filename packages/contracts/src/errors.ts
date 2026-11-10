/** Mã lỗi nghiệp vụ (contracts/rest-api.md). Giá trị trùng tên khóa. */
export const BUSINESS_ERROR_CODES = [
  'ORG_UNIT_NOT_EMPTY',
  'TEAM_NOT_EMPTY',
  'MANAGER_REQUIRED',
  'MANAGEMENT_CHAIN_INVALID',
  'MODEL_NOT_ALLOWED',
  'EMPLOYEE_HAS_OPEN_TASKS',
  'TASK_FIELDS_REQUIRED',
  'ASSIGNEE_OUT_OF_SCOPE',
  'TASK_INVALID_TRANSITION',
  'EVIDENCE_INCOMPLETE',
  'REVIEWER_NOT_INDEPENDENT',
  'DEPENDENCY_CYCLE',
  'NO_SUITABLE_ASSIGNEE',
  'NO_AI_MANAGER',
  'APPROVAL_PAYLOAD_CHANGED',
  'APPROVAL_NOT_PENDING',
  'NO_INDEPENDENT_REVIEWER',
  'EMPLOYEE_SUSPENDED',
  'ADAPTER_LIVE_NOT_CONFIGURED',
  'HUMAN_REJECTED',
  'MAX_REWORK_REACHED',
  'SUBTASK_CANCELLED',
  'RUN_INTERRUPTED',
  'BUDGET_EXCEEDED',
  'RETRIES_EXHAUSTED',
  'TOOL_OUTCOME_UNKNOWN',
  'FORBIDDEN',
] as const;

/** Mã lỗi nền tảng (xác thực, validation, không tìm thấy). */
export const PLATFORM_ERROR_CODES = [
  'UNAUTHENTICATED',
  'CSRF_INVALID',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'CONFLICT',
  'EMAIL_TAKEN',
  'INVALID_CREDENTIALS',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export type BusinessErrorCode = (typeof BUSINESS_ERROR_CODES)[number];
export type PlatformErrorCode = (typeof PLATFORM_ERROR_CODES)[number];
export type ErrorCode = BusinessErrorCode | PlatformErrorCode;

/** Trạng thái HTTP mặc định của từng mã: 409 xung đột, 422 validation, 403 phạm vi. */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  ORG_UNIT_NOT_EMPTY: 409,
  TEAM_NOT_EMPTY: 409,
  MANAGER_REQUIRED: 422,
  MANAGEMENT_CHAIN_INVALID: 422,
  MODEL_NOT_ALLOWED: 422,
  EMPLOYEE_HAS_OPEN_TASKS: 409,
  TASK_FIELDS_REQUIRED: 422,
  ASSIGNEE_OUT_OF_SCOPE: 403,
  TASK_INVALID_TRANSITION: 409,
  EVIDENCE_INCOMPLETE: 409,
  REVIEWER_NOT_INDEPENDENT: 409,
  DEPENDENCY_CYCLE: 422,
  NO_SUITABLE_ASSIGNEE: 409,
  NO_AI_MANAGER: 409,
  APPROVAL_PAYLOAD_CHANGED: 409,
  APPROVAL_NOT_PENDING: 409,
  NO_INDEPENDENT_REVIEWER: 409,
  EMPLOYEE_SUSPENDED: 409,
  ADAPTER_LIVE_NOT_CONFIGURED: 409,
  HUMAN_REJECTED: 409,
  MAX_REWORK_REACHED: 409,
  SUBTASK_CANCELLED: 409,
  RUN_INTERRUPTED: 409,
  BUDGET_EXCEEDED: 409,
  RETRIES_EXHAUSTED: 409,
  TOOL_OUTCOME_UNKNOWN: 409,
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
  CSRF_INVALID: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  CONFLICT: 409,
  EMAIL_TAKEN: 409,
  INVALID_CREDENTIALS: 401,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/** Lỗi nghiệp vụ ném từ engine; error filter đổi thành `{ error: { code, message, details } }`. */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message?: string, details: Record<string, unknown> = {}) {
    super(message ?? code);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
}

export type ErrorBody = {
  error: { code: ErrorCode; message: string; details: Record<string, unknown> };
};
