import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, createdAtColumn, idColumn, updatedAtColumn } from './_columns';
import { user } from './auth';
import { orgUnit } from './organization';

export const humanRoleEnum = pgEnum('human_role', ['ceo', 'manager']);

export const humanMember = pgTable(
  'human_member',
  {
    ...baseColumns(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    role: humanRoleEnum('role').notNull(),
    title: text('title'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (t) => [unique('human_member_company_user_unique').on(t.companyId, t.userId)],
);

export const employeeKindEnum = pgEnum('ai_employee_kind', ['employee', 'manager']);
export const seniorityEnum = pgEnum('ai_seniority', ['junior', 'middle', 'senior', 'expert']);
export const runtimeKindEnum = pgEnum('ai_runtime_kind', ['claude_agent_sdk', 'messages_api']);
export const managerKindEnum = pgEnum('ai_manager_kind', ['human', 'ai']);
export const employeeStatusEnum = pgEnum('ai_employee_status', ['active', 'suspended', 'archived']);
export const workspaceKindEnum = pgEnum('workspace_kind', ['git_repo', 'docs_folder']);

/** Thư mục làm việc do CEO đăng ký; `mount_path` nằm trong `WORKSPACE_HOST_PATH`. */
export const workspace = pgTable(
  'workspace',
  {
    ...baseColumns(),
    name: text('name').notNull(),
    kind: workspaceKindEnum('kind').notNull(),
    mountPath: text('mount_path').notNull(),
    defaultBranch: text('default_branch'),
  },
  (t) => [
    check('workspace_name_length', sql`char_length(${t.name}) between 1 and 120`),
    unique('workspace_company_mount_unique').on(t.companyId, t.mountPath),
  ],
);

/** Thư mục gốc cho phép của workspace do CEO đặt theo công ty; không có dòng thì dùng `WORKSPACE_HOST_PATH`. */
export const workspaceSetting = pgTable(
  'workspace_setting',
  {
    ...baseColumns(),
    rootPath: text('root_path').notNull(),
  },
  (t) => [
    unique('workspace_setting_company_unique').on(t.companyId),
    check('workspace_setting_root_length', sql`char_length(${t.rootPath}) between 1 and 512`),
  ],
);

/**
 * Hồ sơ AI Employee (FR-009). `manager_id` là nguồn sự thật duy nhất về manager trực tiếp:
 * trỏ `human_member` hoặc `ai_employee` tùy `manager_kind` nên không có khóa ngoại.
 */
export const aiEmployee = pgTable(
  'ai_employee',
  {
    ...baseColumns(),
    name: text('name').notNull(),
    avatarKey: text('avatar_key').notNull(),
    position: text('position').notNull(),
    // NOT NULL, ngoại lệ duy nhất là CEO AI Assistant (CHECK bên dưới): trợ lý cấp công ty nên không thuộc đơn vị nào.
    homeOrgUnitId: uuid('home_org_unit_id').references(() => orgUnit.id),
    kind: employeeKindEnum('kind').notNull(),
    roleTemplateKey: text('role_template_key'),
    personality: text('personality').notNull().default(''),
    skills: text('skills')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    seniority: seniorityEnum('seniority').notNull(),
    modelId: text('model_id').notNull(),
    runtimeKind: runtimeKindEnum('runtime_kind').notNull(),
    systemPrompt: text('system_prompt').notNull(),
    toolGrants: text('tool_grants')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    workspaceId: uuid('workspace_id').references(() => workspace.id),
    managerKind: managerKindEnum('manager_kind').notNull(),
    managerId: uuid('manager_id').notNull(),
    maxConcurrentTasks: integer('max_concurrent_tasks').notNull().default(2),
    status: employeeStatusEnum('status').notNull().default('active'),
  },
  (t) => [
    check('ai_employee_name_length', sql`char_length(${t.name}) between 1 and 80`),
    check('ai_employee_max_concurrent_positive', sql`${t.maxConcurrentTasks} >= 1`),
    // AI Manager chỉ chạy runtime messages_api (Nguyên tắc VI).
    check(
      'ai_employee_manager_runtime',
      sql`${t.kind} <> 'manager' or ${t.runtimeKind} = 'messages_api'`,
    ),
    check(
      'ai_employee_home_org_unit_required',
      sql`${t.homeOrgUnitId} is not null or ${t.roleTemplateKey} = 'ceo_assistant'`,
    ),
    // Mỗi công ty tối đa một CEO AI Assistant chưa lưu trữ (kể cả `suspended`); sau khi archive thì tạo lại được.
    uniqueIndex('ai_employee_one_ceo_assistant')
      .on(t.companyId)
      .where(sql`${t.roleTemplateKey} = 'ceo_assistant' and ${t.status} <> 'archived'`),
    index('ai_employee_home_idx').on(t.companyId, t.homeOrgUnitId),
    index('ai_employee_manager_idx').on(t.companyId, t.managerKind, t.managerId),
  ],
);

/** Mẫu vai trò: dữ liệu seed dùng chung, không theo company và không bật RLS. */
export const roleTemplate = pgTable('role_template', {
  id: idColumn(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  defaults: jsonb('defaults').notNull(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});
