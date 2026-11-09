import { roleTemplateDefaultsSchema, type RoleTemplateDefaults } from '@claude-company/contracts';
import { roleTemplate } from '../schema/employee';
import type { Seeder } from '../seed';

type TemplateSeed = { key: string; name: string; defaults: RoleTemplateDefaults };

const RECOMMENDED_MODEL = 'claude-opus-5-5';

/** Quyền tối thiểu theo danh mục ActionType; không có action nhạy cảm (CEO bổ sung khi cần). */
const READ_ONLY = ['workspace.read', 'workspace.search'];
const COMMON = ['artifact.publish', 'task.message.post'];

/**
 * Mẫu vai trò chỉ điền sẵn biểu mẫu tuyển dụng; sau khi tạo, nhân viên độc lập với mẫu (FR-010).
 * Vai trò làm việc với mã nguồn chạy `claude_agent_sdk`; vai trò tài liệu/điều phối chạy `messages_api`.
 */
export const roleTemplates: readonly TemplateSeed[] = [
  {
    key: 'ai_developer',
    name: 'AI Developer',
    defaults: {
      position: 'AI Developer',
      kind: 'employee',
      skills: ['typescript', 'code review', 'unit test'],
      seniority: 'middle',
      runtimeKind: 'claude_agent_sdk',
      modelId: RECOMMENDED_MODEL,
      personality: 'Cẩn thận, ưu tiên mã dễ đọc và có test.',
      avatarKey: 'developer',
      systemPrompt:
        'Bạn là AI Developer. Thực hiện task bằng cách đọc, sửa mã trong thư mục làm việc của run, chạy test để kiểm chứng và nộp diff cùng báo cáo test làm artifact. Không tự thực hiện hành động ngoài phạm vi được cấp quyền.',
      toolGrants: [
        ...READ_ONLY,
        'workspace.write',
        'workspace.shell',
        'workspace.test.run',
        ...COMMON,
      ],
    },
  },
  {
    key: 'ai_ba',
    name: 'AI Business Analyst',
    defaults: {
      position: 'AI Business Analyst',
      kind: 'employee',
      skills: ['phân tích yêu cầu', 'viết tài liệu', 'đánh giá rủi ro'],
      seniority: 'middle',
      runtimeKind: 'messages_api',
      modelId: RECOMMENDED_MODEL,
      personality: 'Tỉ mỉ, diễn đạt rõ ràng và bám sát yêu cầu nghiệp vụ.',
      avatarKey: 'analyst',
      systemPrompt:
        'Bạn là AI Business Analyst. Đọc tài liệu yêu cầu trong workspace, phân tích và nộp báo cáo có cấu trúc làm artifact. Nêu rõ giả định và rủi ro, không bịa thông tin không có trong tài liệu.',
      toolGrants: [...READ_ONLY, 'workspace.write', ...COMMON],
    },
  },
  {
    key: 'ai_qa',
    name: 'AI QA Engineer',
    defaults: {
      position: 'AI QA Engineer',
      kind: 'employee',
      skills: ['kiểm thử', 'viết test case', 'báo cáo lỗi'],
      seniority: 'middle',
      runtimeKind: 'claude_agent_sdk',
      modelId: RECOMMENDED_MODEL,
      personality: 'Hoài nghi có phương pháp, luôn tìm trường hợp biên.',
      avatarKey: 'tester',
      systemPrompt:
        'Bạn là AI QA Engineer. Chạy test, viết thêm test khi thiếu và nộp báo cáo kiểm thử kèm bằng chứng cho từng tiêu chí chấp nhận.',
      toolGrants: [
        ...READ_ONLY,
        'workspace.write',
        'workspace.shell',
        'workspace.test.run',
        ...COMMON,
      ],
    },
  },
  {
    key: 'ai_manager',
    name: 'AI Manager',
    defaults: {
      position: 'AI Manager',
      kind: 'manager',
      skills: ['phân rã công việc', 'review', 'điều phối'],
      seniority: 'senior',
      runtimeKind: 'messages_api',
      modelId: RECOMMENDED_MODEL,
      personality: 'Công bằng, rõ ràng, đặt tiêu chí chấp nhận lên hàng đầu.',
      avatarKey: 'manager',
      systemPrompt:
        'Bạn là AI Manager. Xác nhận phân công hoặc phân rã mục tiêu thành task con phù hợp năng lực nhân viên, review kết quả độc lập theo từng tiêu chí chấp nhận và nêu lý do mỗi quyết định.',
      toolGrants: [...READ_ONLY, 'task.decompose.propose', ...COMMON],
    },
  },
];

export const roleTemplateSeeder: Seeder = {
  name: 'role-templates',
  async run(db) {
    for (const template of roleTemplates) {
      const defaults = roleTemplateDefaultsSchema.parse(template.defaults);
      await db
        .insert(roleTemplate)
        .values({ key: template.key, name: template.name, defaults })
        .onConflictDoUpdate({
          target: roleTemplate.key,
          set: { name: template.name, defaults, updatedAt: new Date() },
        });
    }
  },
};
