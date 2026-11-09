// Type khung; US4 (T133) thay bằng Zod schema ApprovalRequest.
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export type ToolInvocationRef = { id: string; actionType: string; payloadHash: string };

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
