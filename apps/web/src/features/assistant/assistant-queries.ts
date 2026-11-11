import { useQuery } from '@tanstack/react-query';
import type {
  CeoAssistantState,
  CreateAssistantRequestInput,
  EmployeeProfile,
  Page,
  RoleTemplate,
  Task,
  TaskDraftPatch,
  TaskOperation,
} from '@claude-company/contracts';
import { api } from '../../lib/api';
import { queryClient, queryKeys } from '../../lib/query';
import { applyTemplate, emptyForm, toRequestBody } from '../employees/employee-form-model';
import { invalidateEmployees } from '../employees/employee-queries';

/** Chu kỳ làm mới ngắn khi còn đề xuất đang soạn (`proposalStatus = pending`). */
export const PROPOSAL_POLL_MS = 2_000;
const OPERATIONS_POLL_MS = 5_000;

const assistantKey = (companyId: string) => ['company', companyId, 'ceo-assistant'] as const;

/** Trợ lý hiện có của công ty và khả năng tạo mới. Chỉ CEO gọi được (Manager thường nhận 403). */
export const useCeoAssistant = (companyId: string) =>
  useQuery({
    queryKey: assistantKey(companyId),
    queryFn: () => api.get<CeoAssistantState>(`/companies/${companyId}/ceo-assistant`),
  });

/** Yêu cầu đã gửi trợ lý: task giao cho trợ lý, mới nhất trước; tự làm mới nhanh khi còn đề xuất đang soạn. */
export const useAssistantRequests = (companyId: string, assistantId: string | undefined) =>
  useQuery({
    queryKey: [...queryKeys.tasks(companyId), 'assistant', assistantId ?? ''],
    enabled: Boolean(assistantId),
    queryFn: async () => {
      const page = await api.get<Page<Task>>(`/companies/${companyId}/tasks`, {
        query: { assigneeKind: 'ai_employee', assigneeId: assistantId, limit: 50 },
      });
      return page.items;
    },
    refetchInterval: (query) =>
      query.state.data?.some((task) => task.proposalStatus === 'pending') ? PROPOSAL_POLL_MS : false,
  });

/** Thao tác điều hành của trợ lý trên một task; làm mới theo chu kỳ khi còn thao tác chưa xong. */
export const useTaskOperations = (companyId: string, taskId: string, enabled = true) =>
  useQuery({
    queryKey: [...queryKeys.tasks(companyId), taskId, 'operations'],
    enabled,
    queryFn: () => api.get<TaskOperation[]>(`/companies/${companyId}/tasks/${taskId}/operations`),
    // Còn thao tác đang chạy hoặc chờ duyệt: làm mới để CEO thấy trạng thái mới.
    refetchInterval: (query) =>
      query.state.data?.some((op) => ['executing', 'pending', 'pending_approval'].includes(op.status))
        ? OPERATIONS_POLL_MS
        : false,
  });

/** Tạo CEO AI Assistant từ mẫu `ceo_assistant`; server ép đơn vị nhà rỗng, manager là CEO, runtime messages_api. */
export async function createAssistant(companyId: string, template: RoleTemplate) {
  const form = applyTemplate({ ...emptyForm(), name: template.name }, template);
  const created = await api.post<EmployeeProfile>(
    `/companies/${companyId}/employees`,
    toRequestBody(form),
  );
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: assistantKey(companyId) }),
    invalidateEmployees(companyId),
  ]);
  return created;
}

/** Gửi yêu cầu điều hành: tạo task nháp chờ đề xuất của trợ lý. */
export async function sendAssistantRequest(companyId: string, input: CreateAssistantRequestInput) {
  const task = await api.post<Task>(`/companies/${companyId}/ceo-assistant/requests`, input);
  await queryClient.invalidateQueries({ queryKey: queryKeys.tasks(companyId) });
  return task;
}

/** CEO sửa đề xuất của trợ lý trước khi giao (chỉ task `draft`). */
export const patchDraftTask = (companyId: string, taskId: string, patch: TaskDraftPatch) =>
  api.patch<Task>(`/companies/${companyId}/tasks/${taskId}`, patch);
