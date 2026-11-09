// Type khung; US7 (T179) thay bằng Zod schema Run.
export type AgentRunRef = { runId: string };
export type AgentRunSummary = {
  id: string;
  taskId: string;
  employeeId: string;
  status: string;
  purpose: string;
  startedAt: string | null;
  endedAt: string | null;
};
export type AgentRunDetail = AgentRunSummary & { steps: unknown[]; toolInvocations: unknown[] };
export type AgentRunStatusPatch = {
  status?: string;
  error?: { code: string; message: string };
  sessionId?: string;
};
export type RunStepInput = { kind: string; payload?: unknown };
export type RunStepRef = { id: string; seq: number };
export type ToolInvocationInput = {
  runId: string;
  stepSeq: number;
  actionType: string;
  input: unknown;
  idempotencyKey: string;
  level: string;
};
export type ToolInvocationPatch = { status?: string; output?: unknown; error?: string };
export type RecoveryReport = { recovered: number; failed: number };
export type ExecutedAction = {
  toolInvocationId: string;
  actionType: string;
  adapterMode: 'dry_run' | 'live';
  status: string;
  executedAt: string;
};
export type MemoryEntry = { id: string; content: string };
export type MemoryEntryInput = { employeeId: string; taskId: string; content: string };
export type TaskMessage = {
  id: string;
  taskId: string;
  authorKind: 'human' | 'ai';
  authorId: string;
  body: string;
  createdAt: string;
};
export type NotificationInput = {
  type: string;
  title: string;
  body?: string;
  taskId?: string;
  approvalRequestId?: string;
};
export type ToolResult = {
  status: 'ok' | 'pending_approval' | 'run_locked' | 'denied' | 'error';
  output?: unknown;
  message?: string;
};
