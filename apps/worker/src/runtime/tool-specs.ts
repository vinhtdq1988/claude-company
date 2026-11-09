import {
  hasToolInputSchema,
  TOOL_INPUT_SCHEMAS,
  type RuntimeKind,
  type ToolActionType,
} from '@claude-company/contracts';
import type { ToolSpec } from '@claude-company/model-gateway';
import { getActionDefinition } from '@claude-company/policy';
import { z, type ZodObject, type ZodType } from 'zod';

/** Tên tool = ActionType đổi `.` thành `_` (engine-interfaces.md, ToolSpec). */
export function toolNameFor(actionType: string): string {
  return actionType.replaceAll('.', '_');
}

const TOOL_TO_ACTION = new Map<string, ToolActionType>(
  (Object.keys(TOOL_INPUT_SCHEMAS) as ToolActionType[]).map((a) => [toolNameFor(a), a]),
);

/**
 * Bảng ánh xạ ngược tên tool → ActionType cho ToolBroker. Tên không ánh xạ được trả `undefined`
 * và broker coi là `restricted` (FR-024, SC-004). `network_fetch` cố ý không có trong bảng.
 */
export function actionTypeForTool(toolName: string): ToolActionType | undefined {
  return TOOL_TO_ACTION.get(toolName);
}

const DESCRIPTIONS: Record<ToolActionType, string> = {
  'workspace.read': 'Đọc một file trong workspace của run (đường dẫn tương đối).',
  'workspace.search': 'Tìm kiếm văn bản trong workspace của run.',
  'workspace.write': 'Tạo hoặc ghi đè một file trong thư mục làm việc của run (không ghi vào nguồn).',
  'workspace.shell':
    'Chạy một lệnh trong sandbox (chạy test, build, lint, lệnh git cục bộ). Lệnh ngoài danh sách cho phép bị từ chối.',
  'workspace.test.run': 'Chạy bộ test đã cấu hình cho workspace.',
  'artifact.publish':
    'Nộp kết quả công việc dưới dạng artifact cho task. Đây là cách duy nhất để giao kết quả.',
  'task.message.post': 'Gửi một trao đổi gắn với task hiện tại.',
  'task.decompose.propose': 'Đề xuất kế hoạch phân rã task (hệ thống sẽ kiểm tra trước khi áp dụng).',
  'email.send': 'Đề xuất gửi email. Cần Human Approval: bạn chỉ tạo đề xuất, hệ thống thực thi sau khi được duyệt.',
  'data.delete': 'Đề xuất xóa dữ liệu. Cần Human Approval: bạn chỉ tạo đề xuất.',
  'deploy.staging': 'Đề xuất deploy lên staging. Cần Human Approval.',
  'deploy.production': 'Đề xuất deploy lên production. Cần Human Approval.',
  'workspace.git.push': 'Đề xuất push lên remote. Cần Human Approval.',
};

function isObjectSchema(schema: ZodType): schema is ZodObject {
  return schema instanceof z.ZodObject;
}

/**
 * Sinh `ToolSpec` cho mọi ActionType trong `tool_grants` có cột Runtime khớp `runtimeKind`
 * (contracts/action-policy.md, "Tool cho agent"). Không bao giờ sinh `network.fetch`, tool chưa cấp hoặc sai runtime.
 */
export function buildToolSpecs(toolGrants: readonly string[], runtimeKind: RuntimeKind): ToolSpec[] {
  const specs: ToolSpec[] = [];
  for (const actionType of new Set(toolGrants)) {
    const def = getActionDefinition(actionType);
    if (!def || !def.runtimes.includes(runtimeKind) || !hasToolInputSchema(actionType)) continue;
    const schema = TOOL_INPUT_SCHEMAS[actionType] as ZodType;
    specs.push({
      name: toolNameFor(actionType),
      actionType,
      description: DESCRIPTIONS[actionType],
      inputSchema: z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>,
      zodShape: isObjectSchema(schema) ? (schema.shape as Record<string, ZodType>) : undefined,
    });
  }
  return specs;
}
