import { z } from 'zod';
import { usagePeriodSchema } from './budget';
import { orgUnitKindSchema } from './organization';
import { senioritySchema } from './employee';
import {
  artifactKindSchema,
  assigneeKindSchema,
  decompositionPlanSchema,
  taskPrioritySchema,
} from './task';
import { uuidSchema } from './common';

/** Đường dẫn tương đối trong thư mục làm việc của run; việc chặn thoát khỏi workspace do tool thực hiện. */
const relativePath = z.string().trim().min(1).max(1_000);

/**
 * Lý do agent đề xuất hành động cần Human Approval (hiển thị như dữ liệu cho người duyệt). Không thuộc payload:
 * ToolBroker tách trường này ra trước khi băm và thực thi nên đổi lý do không đổi hành động được duyệt.
 */
export const APPROVAL_RATIONALE_FIELD = 'rationale';
const rationale = z.string().trim().max(2_000).optional();

const trimmed = (max: number) => z.string().trim().min(1).max(max);

/** Nguồn của một tiêu chí nghiệm thu khi trợ lý tạo task: trích nguyên văn lời CEO hay do trợ lý đề xuất (R14 Decision 6). */
export const criterionSourceSchema = z.enum(['ceo_quote', 'proposed']);
export type CriterionSource = z.infer<typeof criterionSourceSchema>;

/**
 * Input tool điều hành của CEO AI Assistant (action-policy.md, "Input schema của tool điều hành"). Mọi schema đều
 * `strict` và KHÔNG có trường nào cho phép nâng quyền: không `toolGrants`, `modelId`, `runtimeKind`, `systemPrompt`,
 * `managerId`, `workspaceId`, giới hạn ngân sách của nhân viên, `level`, `actorId`/`memberId`.
 * `rationale` là lý do hiển thị cho người duyệt, tách trước khi băm như các tool Human Approval khác.
 */
export const COMPANY_OPS_INPUT_SCHEMAS = {
  'company.query': z
    .object({
      view: z.enum(['overview', 'org_chart', 'employees', 'tasks', 'blockers', 'usage', 'budget']),
      orgUnitId: uuidSchema.optional(),
      status: trimmed(64).optional(),
      period: usagePeriodSchema.optional(),
    })
    .strict(),
  'task.create': z
    .object({
      title: trimmed(200),
      objective: trimmed(20_000),
      assignee: z.object({ kind: assigneeKindSchema, id: uuidSchema }).strict(),
      deadline: z.iso.datetime({ offset: true }),
      priority: taskPrioritySchema,
      expectedOutput: trimmed(5_000),
      acceptanceCriteria: z
        .array(z.object({ text: trimmed(2_000), source: criterionSourceSchema }).strict())
        .min(1)
        .max(30),
      tokenCap: z.number().int().positive().optional(),
      costCap: z.number().positive().optional(),
      dependsOn: z.array(uuidSchema).max(50).optional(),
    })
    .strict(),
  'org.unit.upsert': z
    .object({
      id: uuidSchema.optional(),
      kind: orgUnitKindSchema,
      parentId: uuidSchema.nullable().optional(),
      name: trimmed(120),
      sortOrder: z.number().int().min(0).optional(),
    })
    .strict(),
  'org.team.upsert': z
    .object({
      id: uuidSchema.optional(),
      orgUnitId: uuidSchema,
      name: trimmed(120),
      sortOrder: z.number().int().min(0).optional(),
    })
    .strict(),
  'employee.create': z
    .object({
      roleTemplateKey: trimmed(64).refine((k) => k !== 'ceo_assistant', {
        message: 'Không tạo CEO AI Assistant qua tool',
      }),
      name: trimmed(80),
      homeOrgUnitId: uuidSchema,
      teamIds: z.array(uuidSchema).max(20).optional(),
      seniority: senioritySchema.optional(),
      personality: z.string().trim().max(2_000).optional(),
      skills: z.array(trimmed(64)).max(50).optional(),
    })
    .strict(),
  'employee.update': z
    .object({
      employeeId: uuidSchema,
      name: trimmed(80).optional(),
      position: trimmed(120).optional(),
      personality: z.string().trim().max(2_000).optional(),
      skills: z.array(trimmed(64)).max(50).optional(),
      seniority: senioritySchema.optional(),
      homeOrgUnitId: uuidSchema.optional(),
      teamIds: z.array(uuidSchema).max(20).optional(),
    })
    .strict(),
  'employee.suspend': z.object({ employeeId: uuidSchema }).strict(),
  'employee.resume': z.object({ employeeId: uuidSchema }).strict(),
  'employee.archive': z.object({ employeeId: uuidSchema, rationale }).strict(),
  'org.archive': z
    .object({ targetKind: z.enum(['org_unit', 'team']), targetId: uuidSchema, rationale })
    .strict(),
  'task.cancel': z.object({ taskId: uuidSchema, reason: trimmed(2_000), rationale }).strict(),
} as const;

/** Các ActionType điều hành có tool; dòng `restricted` của danh mục không có schema. */
export type CompanyOpsActionType = keyof typeof COMPANY_OPS_INPUT_SCHEMAS;
export type CompanyOpsInput<K extends CompanyOpsActionType> = z.infer<
  (typeof COMPANY_OPS_INPUT_SCHEMAS)[K]
>;

/**
 * Zod input cho mọi ActionType mà agent gọi được (action-policy.md, mục "Tool cho agent").
 * `network.fetch` không có schema vì không bao giờ được sinh thành tool.
 */
export const TOOL_INPUT_SCHEMAS = {
  'workspace.read': z.object({ path: relativePath }),
  'workspace.search': z.object({
    query: z.string().trim().min(1).max(500),
    path: relativePath.optional(),
  }),
  'workspace.write': z.object({ path: relativePath, content: z.string().max(2_000_000) }),
  'workspace.shell': z.object({ command: z.string().trim().min(1).max(4_000) }),
  'workspace.test.run': z.object({ target: z.string().trim().max(500).optional() }),
  'artifact.publish': z.object({
    kind: artifactKindSchema.default('document'),
    title: z.string().trim().min(1).max(200),
    mimeType: z.string().trim().min(1).max(100).default('text/markdown'),
    content: z.string().min(1).max(5_000_000),
  }),
  'task.message.post': z.object({ body: z.string().trim().min(1).max(10_000) }),
  'task.decompose.propose': decompositionPlanSchema,
  'email.send': z.object({
    to: z.array(z.string().trim().min(3).max(320)).min(1).max(50),
    subject: z.string().trim().min(1).max(500),
    body: z.string().min(1).max(100_000),
    rationale,
  }),
  'data.delete': z.object({
    target: z.string().trim().min(1).max(1_000),
    reason: z.string().trim().min(1).max(2_000),
    rationale,
  }),
  'deploy.staging': z.object({
    ref: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(2_000).optional(),
    rationale,
  }),
  'deploy.production': z.object({
    ref: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(2_000).optional(),
    rationale,
  }),
  'workspace.git.push': z.object({
    remote: z.string().trim().min(1).max(200),
    branch: z.string().trim().min(1).max(200),
    rationale,
  }),
  ...COMPANY_OPS_INPUT_SCHEMAS,
} as const;

export type ToolActionType = keyof typeof TOOL_INPUT_SCHEMAS;
export type ToolInput<K extends ToolActionType> = z.infer<(typeof TOOL_INPUT_SCHEMAS)[K]>;

export function hasToolInputSchema(actionType: string): actionType is ToolActionType {
  return Object.hasOwn(TOOL_INPUT_SCHEMAS, actionType);
}
