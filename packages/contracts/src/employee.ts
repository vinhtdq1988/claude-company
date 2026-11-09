import { z } from 'zod';
import { uuidSchema } from './common';

export const runtimeKindSchema = z.enum(['claude_agent_sdk', 'messages_api']);
export type RuntimeKind = z.infer<typeof runtimeKindSchema>;

export const senioritySchema = z.enum(['junior', 'middle', 'senior', 'expert']);
export type Seniority = z.infer<typeof senioritySchema>;

export const employeeKindSchema = z.enum(['employee', 'manager']);
export type EmployeeKind = z.infer<typeof employeeKindSchema>;

export const employeeStatusSchema = z.enum(['active', 'suspended', 'archived']);
export type EmployeeStatus = z.infer<typeof employeeStatusSchema>;

export const managerRefSchema = z.object({ kind: z.enum(['human', 'ai']), id: uuidSchema });
export type ManagerRef = z.infer<typeof managerRefSchema>;

export type EmployeeProfile = {
  id: string;
  name: string;
  avatarKey: string;
  position: string;
  homeOrgUnitId: string;
  teamIds: string[];
  kind: EmployeeKind;
  roleTemplateKey: string | null;
  personality: string;
  skills: string[];
  seniority: Seniority;
  modelId: string;
  runtimeKind: RuntimeKind;
  systemPrompt: string;
  toolGrants: string[];
  workspaceId: string | null;
  manager: ManagerRef;
  maxConcurrentTasks: number;
  status: EmployeeStatus;
  performance: { completedTasks: number; onTimeRate: number; reworkRate: number };
};

/** Giá trị mặc định của `maxConcurrentTasks` (data-model: mặc định 2). */
export const DEFAULT_MAX_CONCURRENT_TASKS = 2;

/** Giới hạn độ dài tên AI Employee (data-model: 1–80 ký tự). */
export const EMPLOYEE_NAME_MAX = 80;

/** Trường chung của hồ sơ AI Employee (hợp đồng Nguyên tắc VI, FR-009). */
const employeeFields = z.object({
  name: z.string().trim().min(1).max(EMPLOYEE_NAME_MAX),
  avatarKey: z.string().trim().min(1).max(64),
  position: z.string().trim().min(1).max(120),
  homeOrgUnitId: uuidSchema,
  kind: employeeKindSchema,
  roleTemplateKey: z.string().trim().min(1).max(64).nullable(),
  personality: z.string().trim().max(2000),
  skills: z.array(z.string().trim().min(1).max(64)).max(50),
  seniority: senioritySchema,
  modelId: z.string().trim().min(1).max(128),
  runtimeKind: runtimeKindSchema,
  systemPrompt: z.string().trim().min(1).max(20_000),
  toolGrants: z.array(z.string().trim().min(1).max(64)).max(50),
  workspaceId: uuidSchema.nullable(),
  manager: managerRefSchema,
  maxConcurrentTasks: z.number().int().min(1).max(20).default(DEFAULT_MAX_CONCURRENT_TASKS),
});

/** AI Manager chỉ chạy runtime `messages_api` (kind = manager bắt buộc `runtimeKind = messages_api`). */
const managerRuntimeRule = (
  value: { kind?: EmployeeKind; runtimeKind?: RuntimeKind },
  ctx: z.RefinementCtx,
) => {
  if (value.kind === 'manager' && value.runtimeKind && value.runtimeKind !== 'messages_api') {
    ctx.addIssue({
      code: 'custom',
      path: ['runtimeKind'],
      message: 'AI Manager phải dùng runtime messages_api',
    });
  }
};

/** Dạng đầy đủ, `manager` bắt buộc: kiểu của `EmployeeEngine.create`. */
export const employeeProfileInputSchema = employeeFields.superRefine(managerRuntimeRule);
export type EmployeeProfileInput = z.infer<typeof employeeProfileInputSchema>;

/**
 * Body `POST /employees`. `manager` được phép thiếu ở tầng validate để service trả đúng mã
 * `MANAGER_REQUIRED` (US2-AS2) thay vì lỗi validation chung.
 */
export const createEmployeeSchema = employeeFields
  .extend({ manager: managerRefSchema.nullish() })
  .superRefine(managerRuntimeRule);
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

export const updateEmployeeSchema = employeeFields
  .partial()
  .superRefine(managerRuntimeRule)
  .refine((v) => Object.keys(v).length > 0, { message: 'Cần ít nhất một trường để cập nhật' });
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

export type EmployeeFilter = {
  orgUnitId?: string;
  teamId?: string;
  kind?: EmployeeKind;
  /** Bỏ trống: chỉ nhân viên chưa archived. */
  status?: EmployeeStatus;
  /** Tính `performance` từ Task Engine; mặc định bỏ qua (0) để các lệnh gọi nội bộ thường xuyên không tốn truy vấn. */
  withPerformance?: boolean;
};

export const employeeFilterQuerySchema = z.object({
  orgUnitId: uuidSchema.optional(),
  teamId: uuidSchema.optional(),
  kind: employeeKindSchema.optional(),
  status: employeeStatusSchema.optional(),
});

/** Task cản trở khi archive nhân viên (`409 EMPLOYEE_HAS_OPEN_TASKS`). */
export type EmployeeBlockers = { tasks: Array<{ id: string; title: string }> };

/** Mẫu vai trò (dữ liệu seed): giá trị điền sẵn khi tuyển nhân viên. */
export const roleTemplateDefaultsSchema = z.object({
  position: z.string(),
  kind: employeeKindSchema,
  skills: z.array(z.string()),
  seniority: senioritySchema,
  runtimeKind: runtimeKindSchema,
  systemPrompt: z.string(),
  toolGrants: z.array(z.string()),
  modelId: z.string(),
  personality: z.string().default(''),
  avatarKey: z.string(),
});
export type RoleTemplateDefaults = z.infer<typeof roleTemplateDefaultsSchema>;

export type RoleTemplate = { key: string; name: string; defaults: RoleTemplateDefaults };

export const workspaceKindSchema = z.enum(['git_repo', 'docs_folder']);
export type WorkspaceKind = z.infer<typeof workspaceKindSchema>;

export type Workspace = {
  id: string;
  name: string;
  kind: WorkspaceKind;
  mountPath: string;
  defaultBranch: string | null;
};

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: workspaceKindSchema,
  mountPath: z.string().trim().min(1).max(512),
  defaultBranch: z.string().trim().min(1).max(128).nullish(),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export type ModelInfo = {
  modelId: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheWritePerMtok: number;
};
