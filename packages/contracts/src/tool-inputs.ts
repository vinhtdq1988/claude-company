import { z } from 'zod';
import { artifactKindSchema, decompositionPlanSchema } from './task';

/** Đường dẫn tương đối trong thư mục làm việc của run; việc chặn thoát khỏi workspace do tool thực hiện. */
const relativePath = z.string().trim().min(1).max(1_000);

/**
 * Lý do agent đề xuất hành động cần Human Approval (hiển thị như dữ liệu cho người duyệt). Không thuộc payload:
 * ToolBroker tách trường này ra trước khi băm và thực thi nên đổi lý do không đổi hành động được duyệt.
 */
export const APPROVAL_RATIONALE_FIELD = 'rationale';
const rationale = z.string().trim().max(2_000).optional();

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
} as const;

export type ToolActionType = keyof typeof TOOL_INPUT_SCHEMAS;
export type ToolInput<K extends ToolActionType> = z.infer<(typeof TOOL_INPUT_SCHEMAS)[K]>;

export function hasToolInputSchema(actionType: string): actionType is ToolActionType {
  return Object.hasOwn(TOOL_INPUT_SCHEMAS, actionType);
}
