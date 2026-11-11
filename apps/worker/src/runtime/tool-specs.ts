import {
  hasToolInputSchema,
  TOOL_INPUT_SCHEMAS,
  type RuntimeKind,
  type ToolActionType,
} from '@claude-company/contracts';
import type { ToolSpec } from '@claude-company/model-gateway';
import { ACTION_CATALOG, getActionDefinition } from '@claude-company/policy';
import { z, type ZodObject, type ZodType } from 'zod';

/** Tên tool = ActionType đổi `.` thành `_` (engine-interfaces.md, ToolSpec). */
export function toolNameFor(actionType: string): string {
  return actionType.replaceAll('.', '_');
}

/**
 * Hành động điều hành `restricted` được khai báo tường minh nhưng không có tool (task.decide, budget.update…): lời gọi
 * tới tên đó (ví dụ do prompt injection) vẫn ánh xạ về đúng ActionType để ledger ghi đúng tên bị từ chối (SC-015).
 */
const DECLARED_RESTRICTED: readonly string[] = ACTION_CATALOG.filter(
  (a) => a.assistantOnly && a.runtimes.length === 0,
).map((a) => a.actionType);

const TOOL_TO_ACTION = new Map<string, string>([
  ...(Object.keys(TOOL_INPUT_SCHEMAS) as ToolActionType[]).map((a) => [toolNameFor(a), a] as const),
  ...DECLARED_RESTRICTED.map((a) => [toolNameFor(a), a] as const),
]);

/**
 * Bảng ánh xạ ngược tên tool → ActionType cho ToolBroker. Tên không ánh xạ được trả `undefined`
 * và broker coi là `restricted` (FR-024, SC-004). `network_fetch` cố ý không có trong bảng.
 */
export function actionTypeForTool(toolName: string): string | undefined {
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
  'company.query':
    'Đọc trạng thái công ty theo view (overview, org_chart, employees, tasks, blockers, usage, budget) trong phạm vi CEO. Chỉ trích số liệu từ kết quả của tool này.',
  'task.create':
    'Tạo và giao task thay mặt CEO. Mỗi tiêu chí nghiệm thu phải ghi source="ceo_quote" (trích NGUYÊN VĂN lời CEO) hoặc "proposed" (do bạn đề xuất); chỉ khi mọi tiêu chí là ceo_quote task mới được giao ngay, còn lại chờ CEO xác nhận.',
  'org.unit.upsert': 'Tạo, đổi tên hoặc sắp xếp lại Division/Department (không lưu trữ).',
  'org.team.upsert': 'Tạo, đổi tên hoặc sắp xếp lại Team.',
  'employee.create':
    'Tạo AI Employee từ mẫu vai trò; model, công cụ và manager do hệ thống lấy từ mẫu, bạn không đặt được.',
  'employee.update':
    'Sửa tên, vị trí, tính cách, kỹ năng, cấp bậc, đơn vị nhà hoặc team của AI Employee (không sửa được công cụ, model, manager).',
  'employee.suspend': 'Tạm ngưng một AI Employee (không áp dụng cho chính bạn).',
  'employee.resume': 'Kích hoạt lại một AI Employee đang tạm ngưng.',
  'org.archive':
    'Đề xuất lưu trữ Division/Department/Team. Cần Human Approval: bạn chỉ tạo đề xuất, hệ thống thực thi sau khi CEO duyệt.',
  'employee.archive':
    'Đề xuất lưu trữ một AI Employee. Cần Human Approval: bạn chỉ tạo đề xuất.',
  'task.cancel':
    'Đề xuất hủy một task. Cần Human Approval: bạn chỉ tạo đề xuất; không hủy được task của chính bạn.',
};

function isObjectSchema(schema: ZodType): schema is ZodObject {
  return schema instanceof z.ZodObject;
}

/**
 * Sinh `ToolSpec` cho mọi ActionType trong `tool_grants` có cột Runtime khớp `runtimeKind`
 * (contracts/action-policy.md, "Tool cho agent"). Không bao giờ sinh `network.fetch`, tool chưa cấp hoặc sai runtime.
 */
export function buildToolSpecs(
  toolGrants: readonly string[],
  runtimeKind: RuntimeKind,
  options: { isCeoAssistant?: boolean } = {},
): ToolSpec[] {
  const specs: ToolSpec[] = [];
  for (const actionType of new Set(toolGrants)) {
    const def = getActionDefinition(actionType);
    if (!def || !def.runtimes.includes(runtimeKind) || !hasToolInputSchema(actionType)) continue;
    // Phòng thủ nhiều lớp: hành động điều hành chỉ sinh tool cho CEO AI Assistant, và trợ lý không có tool workspace
    // dù `tool_grants` bị sửa trực tiếp trong DB (FR-049).
    if (def.assistantOnly && !options.isCeoAssistant) continue;
    if (options.isCeoAssistant && actionType.startsWith('workspace.')) continue;
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
