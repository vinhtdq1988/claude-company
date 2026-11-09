// Type khung; US3 (T096) thay bằng Zod schema Task, TaskInput, DecompositionPlan.
export type TaskStatus =
  | 'draft'
  | 'assigned'
  | 'in_progress'
  | 'in_review'
  | 'awaiting_human_approval'
  | 'completed'
  | 'blocked'
  | 'cancelled';

export type TaskAction = 'assign' | 'cancel' | 'resume' | 'start' | 'submit' | 'block';

export type Task = {
  id: string;
  title: string;
  objective: string;
  status: TaskStatus;
  assigneeKind: 'ai' | 'human';
  assigneeId: string;
  createdByMemberId: string;
  deadline: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  acceptanceCriteria: string[];
  expectedOutput: string;
  isOverdue: boolean;
  parentTaskId: string | null;
};

export type TaskInput = Omit<
  Task,
  'id' | 'status' | 'isOverdue' | 'createdByMemberId' | 'parentTaskId'
> & {
  parentTaskId?: string | null;
  dependsOn?: string[];
  tokenCap?: number;
  costCap?: number;
};

export type Artifact = {
  id: string;
  taskId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
};

export type TaskDetail = Task & { subtasks: Task[]; artifacts: Artifact[] };

export type TaskFilter = {
  statusIn?: TaskStatus[];
  /** `team`/`org_unit` để Organization Engine kiểm tra task đang giao cho đơn vị trước khi archive. */
  assigneeKind?: 'ai' | 'human' | 'team' | 'org_unit';
  assigneeId?: string;
  orgUnitId?: string;
  overdue?: boolean;
  cursor?: string;
  limit?: number;
};

export type TaskStats = {
  completedTasks: number;
  onTimeRate: number;
  reworkRate: number;
  activeTasks: number;
};

export type ArtifactInput = { name: string; mimeType: string; content: Uint8Array | string };
export type EvidenceInput = {
  criterionIndex: number;
  result: 'met' | 'not_met';
  explanation: string;
};
export type DecompositionPlan = {
  subtasks: Array<{
    key: string;
    title: string;
    objective: string;
    assigneeId: string;
    dependsOnKeys: string[];
  }>;
};
