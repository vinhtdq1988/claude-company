import { z } from 'zod';
import type { EmployeeProfile } from './employee';
import { taskPrioritySchema } from './task';

/** Trạng thái màn hình CEO AI Assistant: trợ lý hiện có (nếu có) và CEO có tạo được thêm không. */
export type CeoAssistantState = {
  assistant: EmployeeProfile | null;
  /** True khi chưa có trợ lý chưa lưu trữ (kể cả `suspended` thì vẫn là đã có). */
  canCreate: boolean;
};

/** Body `POST /companies/{cid}/ceo-assistant/requests` (FR-047): `goal` là lời CEO, không rỗng. */
export const createAssistantRequestSchema = z.object({
  goal: z.string().trim().min(1).max(20_000),
  priority: taskPrioritySchema.optional(),
  deadline: z.iso.datetime({ offset: true }).optional(),
});
export type CreateAssistantRequestInput = z.infer<typeof createAssistantRequestSchema>;
