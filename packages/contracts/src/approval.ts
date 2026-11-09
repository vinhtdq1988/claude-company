// Type khung; US4 (T133) thay bằng Zod schema ApprovalRequest.
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

import type { ToolInvocationStatus } from './run';

/** Tham chiếu tới một dòng ledger `tool_invocation` (kèm trạng thái để dedupe theo idempotency key). */
export type ToolInvocationRef = {
  id: string;
  actionType: string;
  payloadHash: string;
  idempotencyKey: string;
  status: ToolInvocationStatus;
  result?: unknown;
};

export type ApprovalRequest = {
  id: string;
  taskId: string;
  employeeId: string;
  actionType: string;
  summary: string;
  rationale: string;
  payloadHash: string;
  status: ApprovalStatus;
  approverMemberId: string;
};
