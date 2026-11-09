import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  type CreateWorkspaceInput,
  type RequestContext,
  type Workspace,
} from '@claude-company/contracts';
import type { AppConfig } from '../../platform/config/config';
import { CONFIG } from '../../platform/config/infra.providers';
import { EventPublisher } from '../../platform/events/event-publisher';
import { inTenant } from '../../platform/tenancy/tenant-store';
import {
  EmployeeRepository,
  pgErrorCode,
  UNIQUE_VIOLATION,
  type WorkspaceRow,
} from './employee.repository';

const toWorkspace = (row: WorkspaceRow): Workspace => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  mountPath: row.mountPath,
  defaultBranch: row.defaultBranch,
});

/**
 * Chuẩn hóa đường dẫn workspace và bảo đảm nó nằm trong thư mục gốc cho phép. Đường dẫn tương đối
 * được hiểu từ gốc; `..` thoát ra ngoài, chính thư mục gốc và byte NUL đều bị từ chối.
 */
export function resolveMountPath(root: string, input: string): string | null {
  if (input.includes('\0')) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(base, input);
  const relative = path.relative(base, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

/** Workspace do CEO đăng ký (FR-012). AI Employee chỉ được cấp workspace đã đăng ký. */
@Injectable()
export class WorkspaceService {
  constructor(
    private readonly repo: EmployeeRepository,
    private readonly events: EventPublisher,
    @Inject(CONFIG) private readonly config: Pick<AppConfig, 'WORKSPACE_HOST_PATH'>,
  ) {}

  async list(ctx: RequestContext): Promise<Workspace[]> {
    const rows = await inTenant(ctx, (tx) => this.repo.listWorkspaces(tx, ctx.companyId));
    return rows.map(toWorkspace);
  }

  async create(ctx: RequestContext, input: CreateWorkspaceInput): Promise<Workspace> {
    const mountPath = resolveMountPath(this.config.WORKSPACE_HOST_PATH, input.mountPath);
    if (!mountPath) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'Đường dẫn phải nằm trong thư mục workspace được phép',
        { field: 'mountPath' },
      );
    }
    try {
      const row = await inTenant(ctx, async (tx) => {
        const inserted = await this.repo.insertWorkspace(tx, {
          companyId: ctx.companyId,
          name: input.name,
          kind: input.kind,
          mountPath,
          defaultBranch: input.kind === 'git_repo' ? (input.defaultBranch ?? 'main') : null,
        });
        await this.events.publish(tx, ctx, {
          type: 'workspace.created',
          aggregateKind: 'workspace',
          aggregateId: inserted.id,
          payload: { workspaceId: inserted.id, name: inserted.name, kind: inserted.kind },
        });
        return inserted;
      });
      return toWorkspace(row);
    } catch (error) {
      if (pgErrorCode(error) === UNIQUE_VIOLATION) {
        throw new DomainError('CONFLICT', 'Đường dẫn này đã được đăng ký làm workspace');
      }
      throw error;
    }
  }
}
