import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  type CreateWorkspaceInput,
  type RequestContext,
  type UpdateWorkspaceSettingsInput,
  type Workspace,
  type WorkspaceSettings,
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

/** `child` nằm trong `root` (hoặc chính là `root`). */
function isWithin(root: string, child: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

  /** Thư mục gốc hiệu lực: cài đặt của công ty, nếu chưa có thì `WORKSPACE_HOST_PATH`. */
  async getRoot(ctx: RequestContext): Promise<string> {
    return (await this.getSettings(ctx)).effectiveRoot;
  }

  async getSettings(ctx: RequestContext): Promise<WorkspaceSettings> {
    const row = await inTenant(ctx, (tx) => this.repo.findWorkspaceSetting(tx, ctx.companyId));
    const defaultRoot = path.resolve(this.config.WORKSPACE_HOST_PATH);
    return {
      rootPath: row?.rootPath ?? null,
      defaultRoot,
      effectiveRoot: row ? path.resolve(row.rootPath) : defaultRoot,
    };
  }

  /**
   * Đặt (hoặc đặt lại về mặc định bằng `null`) thư mục gốc. Đường dẫn phải tuyệt đối, là thư mục tồn tại, và
   * mọi workspace đã đăng ký phải nằm trong gốc mới (worker từ chối workspace ngoài gốc khi chạy).
   */
  async updateSettings(
    ctx: RequestContext,
    input: UpdateWorkspaceSettingsInput,
  ): Promise<WorkspaceSettings> {
    const next = input.rootPath;
    if (next !== null) {
      if (next.includes('\0') || !path.isAbsolute(next)) {
        throw new DomainError('VALIDATION_FAILED', 'Thư mục gốc phải là đường dẫn tuyệt đối', {
          field: 'rootPath',
        });
      }
      const isDirectory = await stat(next).then(
        (s) => s.isDirectory(),
        () => false,
      );
      if (!isDirectory) {
        throw new DomainError('VALIDATION_FAILED', 'Thư mục gốc không tồn tại hoặc không phải thư mục', {
          field: 'rootPath',
        });
      }
    }
    const root = path.resolve(next ?? this.config.WORKSPACE_HOST_PATH);
    const existing = await this.list(ctx);
    const outside = existing.filter((w) => !isWithin(root, w.mountPath));
    if (outside.length > 0) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'Còn workspace đã đăng ký nằm ngoài thư mục gốc mới',
        { field: 'rootPath', workspaces: outside.map((w) => ({ id: w.id, name: w.name })) },
      );
    }
    await inTenant(ctx, async (tx) => {
      if (next === null) await this.repo.deleteWorkspaceSetting(tx, ctx.companyId);
      else await this.repo.upsertWorkspaceSetting(tx, ctx.companyId, path.resolve(next));
      await this.events.publish(tx, ctx, {
        type: 'workspace.root_changed',
        aggregateKind: 'workspace',
        aggregateId: ctx.companyId,
        payload: { rootPath: next === null ? null : path.resolve(next) },
      });
    });
    return this.getSettings(ctx);
  }

  async create(ctx: RequestContext, input: CreateWorkspaceInput): Promise<Workspace> {
    const mountPath = resolveMountPath(await this.getRoot(ctx), input.mountPath);
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
