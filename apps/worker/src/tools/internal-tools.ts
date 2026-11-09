import {
  decompositionPlanSchema,
  type CommunicationEngine,
  type TaskEngine,
  type ToolInput,
} from '@claude-company/contracts';
import type { RunContext, ToolHandler } from '../runtime/run-context';

/** Phần của StorageService mà tool nội bộ dùng. */
export type ArtifactStorage = {
  put(input: {
    companyId: string;
    body: Buffer | Uint8Array | string;
    contentType?: string;
    key?: string;
  }): Promise<{ key: string; checksumSha256: string; sizeBytes: number }>;
};

export type InternalToolsDeps = {
  tasks: Pick<TaskEngine, 'attachArtifact'>;
  communication: Pick<CommunicationEngine, 'postTaskMessage'>;
  storage: ArtifactStorage;
};

/**
 * Tool nội bộ (không tác động ra ngoài): nộp artifact, gửi trao đổi gắn task, đề xuất phân rã.
 * `artifact.publish` lưu S3 rồi gọi `TaskEngine.attachArtifact`; artifact ghi nhận người tạo để reviewer độc lập (Nguyên tắc VII).
 */
export function createInternalHandlers(deps: InternalToolsDeps): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set('artifact.publish', async (run: RunContext, raw) => {
    const input = raw as ToolInput<'artifact.publish'>;
    const stored = await deps.storage.put({
      companyId: run.ctx.companyId,
      body: input.content,
      contentType: input.mimeType,
    });
    const artifact = await deps.tasks.attachArtifact(run.ctx, run.taskId, {
      kind: input.kind,
      title: input.title,
      mimeType: input.mimeType,
      storageKey: stored.key,
      sizeBytes: stored.sizeBytes,
      checksumSha256: stored.checksumSha256,
      agentRunId: run.runId,
    });
    return { artifactId: artifact.id, title: artifact.title, sizeBytes: artifact.sizeBytes };
  });

  handlers.set('task.message.post', async (run: RunContext, raw) => {
    const { body } = raw as ToolInput<'task.message.post'>;
    const message = await deps.communication.postTaskMessage(run.ctx, run.taskId, body);
    return { messageId: message.id };
  });

  // Kế hoạch phân rã chính thức do job `task.decompose` nhận qua structured output và được hệ thống kiểm tra
  // trước khi áp dụng; tool này chỉ ghi nhận đề xuất vào ledger, không tạo task con.
  handlers.set('task.decompose.propose', async (_run: RunContext, raw) => {
    const plan = decompositionPlanSchema.parse(raw);
    return { recorded: true, mode: plan.mode, subtasks: plan.subtasks.length };
  });

  return handlers;
}
