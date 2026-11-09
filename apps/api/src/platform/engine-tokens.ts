/**
 * Injection token cho interface engine/platform (Nguyên tắc VI: engine chỉ gọi nhau qua interface).
 * Dùng Symbol để module không phải import class cụ thể của engine khác.
 */
export const ORGANIZATION_ENGINE = Symbol('ORGANIZATION_ENGINE');
export const EMPLOYEE_ENGINE = Symbol('EMPLOYEE_ENGINE');
export const TASK_ENGINE = Symbol('TASK_ENGINE');
export const ORCHESTRATION_ENGINE = Symbol('ORCHESTRATION_ENGINE');
export const PERMISSION_ENGINE = Symbol('PERMISSION_ENGINE');
export const COMMUNICATION_ENGINE = Symbol('COMMUNICATION_ENGINE');
export const MEMORY_ENGINE = Symbol('MEMORY_ENGINE');
export const GAMIFICATION_ENGINE = Symbol('GAMIFICATION_ENGINE');
export const OFFICE_SIMULATION_ENGINE = Symbol('OFFICE_SIMULATION_ENGINE');
export const BUDGET_SERVICE = Symbol('BUDGET_SERVICE');
export const MODEL_CATALOG = Symbol('MODEL_CATALOG');

/** `platform/auth` bind IdentityDirectory; engine khác hỏi thông tin user qua token này. */
export const IDENTITY_DIRECTORY = Symbol('IDENTITY_DIRECTORY');

/** Worker bind registry ToolAdapter; API không cung cấp. */
export const TOOL_ADAPTER_LOOKUP = Symbol('TOOL_ADAPTER_LOOKUP');
