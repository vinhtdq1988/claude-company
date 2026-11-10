import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  CreateTaskBody,
  ExecutedAction,
  Page,
  Task,
  TaskDecisionBody,
  TaskDetail,
  TaskMessage,
  TaskPriority,
  TaskStatus,
} from '@claude-company/contracts';
import { api } from '../../lib/api';
import { queryClient, queryKeys } from '../../lib/query';
import { realtime } from '../../realtime/socket';

/** Bộ lọc Task Board (FR-021); khớp query của `GET /companies/{cid}/tasks`. */
export type TaskBoardFilter = {
  status?: TaskStatus;
  orgUnitId?: string;
  assigneeKind?: 'ai_employee' | 'team' | 'org_unit';
  assigneeId?: string;
  priority?: TaskPriority;
  overdue?: boolean;
  deadlineBefore?: string;
};

/** Tải các trang cho đến hết (Task Board hiển thị đủ cột); server giới hạn 200 task mỗi trang. */
async function fetchAllTasks(companyId: string, filter: TaskBoardFilter): Promise<Task[]> {
  const tasks: Task[] = [];
  let cursor: string | undefined;
  do {
    const page: Page<Task> = await api.get<Page<Task>>(`/companies/${companyId}/tasks`, {
      query: { ...filter, limit: 200, cursor },
    });
    tasks.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return tasks;
}

export const useTasks = (companyId: string, filter: TaskBoardFilter = {}) =>
  useQuery({
    queryKey: [...queryKeys.tasks(companyId), 'list', filter],
    queryFn: () => fetchAllTasks(companyId, filter),
  });

export const useTask = (companyId: string, id: string) =>
  useQuery({
    queryKey: queryKeys.task(companyId, id),
    queryFn: () => api.get<TaskDetail>(`/companies/${companyId}/tasks/${id}`),
  });

export const useTaskMessages = (companyId: string, id: string) =>
  useQuery({
    queryKey: queryKeys.taskMessages(companyId, id),
    queryFn: () => api.get<TaskMessage[]>(`/companies/${companyId}/tasks/${id}/messages`),
  });

export const useExecutedActions = (companyId: string, id: string) =>
  useQuery({
    queryKey: queryKeys.taskActions(companyId, id),
    queryFn: () =>
      api.get<ExecutedAction[]>(`/companies/${companyId}/tasks/${id}/executed-actions`),
  });

export const createTask = (companyId: string, body: CreateTaskBody, assign: boolean) =>
  api.post<Task>(`/companies/${companyId}/tasks`, body, { query: { assign: assign || undefined } });

export const transitionTask = (
  companyId: string,
  id: string,
  action: 'assign' | 'cancel' | 'resume',
) => api.post<Task>(`/companies/${companyId}/tasks/${id}/transitions`, { action });

export const decideTask = (companyId: string, id: string, body: TaskDecisionBody) =>
  api.post<Task>(`/companies/${companyId}/tasks/${id}/decisions`, body);

export const postTaskMessage = (companyId: string, id: string, body: string) =>
  api.post<TaskMessage>(`/companies/${companyId}/tasks/${id}/messages`, { body });

/** Tải nội dung artifact (stream về văn bản); server kiểm tra phạm vi của task chứa nó. */
export const fetchArtifactText = async (companyId: string, artifactId: string): Promise<string> => {
  const response = await fetch(`/api/v1/companies/${companyId}/artifacts/${artifactId}/content`, {
    credentials: 'include',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
};

/** Mọi thay đổi của task ảnh hưởng bảng, chi tiết, tin nhắn và hành động đã thực thi. */
export const invalidateTasks = (companyId: string) =>
  queryClient.invalidateQueries({ queryKey: queryKeys.tasks(companyId) });

/**
 * Nghe realtime: sự kiện `task.*` và `run.*` làm mới dữ liệu; `task.progress` cập nhật tiến độ ngay (FR-037 vẫn
 * dựa vào snapshot REST khi mất đồng bộ, nên chỉ coi sự kiện là tín hiệu làm mới). Trả về tiến độ theo task.
 */
export function useTaskRealtime(companyId: string): Record<string, number> {
  const [progress, setProgress] = useState<Record<string, number>>({});
  useEffect(
    () =>
      realtime.onEnvelope((envelope) => {
        if (envelope.type === 'task.progress') {
          const { taskId, progress: value } = envelope.payload as {
            taskId?: string;
            progress?: number;
          };
          if (taskId && typeof value === 'number')
            setProgress((prev) => ({ ...prev, [taskId]: value }));
          return;
        }
        if (envelope.type.startsWith('task.') || envelope.type.startsWith('run.')) {
          void invalidateTasks(companyId);
        }
      }),
    [companyId],
  );
  return progress;
}
