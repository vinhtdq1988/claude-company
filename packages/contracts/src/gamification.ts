import { z } from 'zod';

/**
 * Cột mốc Achievement cơ bản (FR-045). Chỉ ba cột mốc, mỗi cột mốc chỉ xuất hiện một lần cho mỗi công ty và chỉ
 * được cấp từ sự kiện nghiệp vụ thật. Không có cột mốc nào dựa trên token đã dùng hay thời lượng chạy (US8-AS2).
 * Tên `milestone` chỉ dùng trong code; giao diện gọi là Achievement.
 */
export const MILESTONE_KEYS = [
  'first_employee',
  'first_department',
  'first_approved_task',
] as const;
export const milestoneKeySchema = z.enum(MILESTONE_KEYS);
export type MilestoneKey = z.infer<typeof milestoneKeySchema>;

export type Milestone = {
  key: MilestoneKey;
  achievedAt: string;
  /** `domain_event.seq` đã làm phát sinh cột mốc, để truy vết về sự kiện thật. */
  sourceEventSeq: number;
};
