import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  DomainError,
  type EmployeeEngine,
  type MemoryEngine,
  type MemoryEntry,
  type MemoryEntryInput,
  type OrganizationEngine,
  type RequestContext,
} from '@claude-company/contracts';
import { memoryEntry } from '@claude-company/db/schema/memory';
import { and, desc, eq } from 'drizzle-orm';
import { EMPLOYEE_ENGINE, ORGANIZATION_ENGINE } from '../../platform/engine-tokens';
import { inTenant } from '../../platform/tenancy/tenant-store';

type Row = typeof memoryEntry.$inferSelect;
type ScopeKey = { kind: MemoryEntry['ownerScopeKind']; id: string };

const toEntry = (row: Row): MemoryEntry => ({
  id: row.id,
  ownerScopeKind: row.ownerScopeKind,
  ownerScopeId: row.ownerScopeId,
  sourceTaskId: row.sourceTaskId,
  kind: row.kind,
  content: row.content,
  createdAt: row.createdAt.toISOString(),
});

/** Số mục tối đa lấy từ DB trước khi lọc theo scope; đủ lớn để `limit` thường không bị thiếu. */
const SCAN_LIMIT = 500;

/**
 * Entry hiển thị cho các scope của người xem khi chủ sở hữu thuộc một scope đó, hoặc
 * `share_rule.scopes` liệt kê một scope đó. `share_rule` null: không chia sẻ ngoài scope sở hữu (FR-013).
 */
export function isVisibleTo(
  row: Pick<Row, 'ownerScopeKind' | 'ownerScopeId' | 'shareRule'>,
  viewer: readonly ScopeKey[],
): boolean {
  const matches = (kind: string, id: string) => viewer.some((s) => s.kind === kind && s.id === id);
  if (matches(row.ownerScopeKind, row.ownerScopeId)) return true;
  const shared = (row.shareRule as { scopes?: Array<{ kind?: string; id?: string }> } | null)
    ?.scopes;
  return Array.isArray(shared) && shared.some((s) => !!s.kind && !!s.id && matches(s.kind, s.id));
}

/**
 * Memory Engine (R11): tóm tắt công việc theo scope, truy xuất theo scope và độ gần đây, không vector search.
 * Cô lập giữa các công ty do RLS đảm bảo.
 */
@Injectable()
export class MemoryService implements MemoryEngine {
  constructor(private readonly moduleRef: ModuleRef) {}

  private get employees(): EmployeeEngine {
    return this.moduleRef.get<EmployeeEngine>(EMPLOYEE_ENGINE, { strict: false });
  }
  private get organization(): OrganizationEngine {
    return this.moduleRef.get<OrganizationEngine>(ORGANIZATION_ENGINE, { strict: false });
  }

  async recall(
    ctx: RequestContext,
    scope: { employeeId: string; taskId: string },
    limit: number,
  ): Promise<MemoryEntry[]> {
    const employee = await this.employees.get(ctx, scope.employeeId);
    // CEO AI Assistant không thuộc đơn vị nào nên không đọc được bộ nhớ của đơn vị.
    const unitChain = employee.homeOrgUnitId
      ? await this.organization.resolveOrgUnitChain(ctx, employee.homeOrgUnitId)
      : [];
    const viewer: ScopeKey[] = [
      { kind: 'ai_employee', id: employee.id },
      ...employee.teamIds.map((id) => ({ kind: 'team' as const, id })),
      ...unitChain.map((id) => ({ kind: 'org_unit' as const, id })),
    ];
    const rows = await inTenant(ctx, (tx) =>
      tx
        .select()
        .from(memoryEntry)
        .where(eq(memoryEntry.companyId, ctx.companyId))
        .orderBy(desc(memoryEntry.createdAt), desc(memoryEntry.id))
        .limit(SCAN_LIMIT),
    );
    return rows
      .filter((row) => isVisibleTo(row, viewer))
      .slice(0, Math.max(0, limit))
      .map(toEntry);
  }

  async remember(ctx: RequestContext, entry: MemoryEntryInput): Promise<void> {
    if (!entry.content.trim()) throw new DomainError('VALIDATION_FAILED', 'Nội dung memory rỗng');
    await inTenant(ctx, async (tx) => {
      // Cùng task được tóm tắt hai lần (sự kiện giao lại) chỉ lưu một bản.
      if (entry.sourceTaskId) {
        const existing = await tx
          .select({ id: memoryEntry.id })
          .from(memoryEntry)
          .where(
            and(
              eq(memoryEntry.companyId, ctx.companyId),
              eq(memoryEntry.sourceTaskId, entry.sourceTaskId),
              eq(memoryEntry.ownerScopeKind, entry.ownerScopeKind),
              eq(memoryEntry.ownerScopeId, entry.ownerScopeId),
              eq(memoryEntry.kind, entry.kind),
            ),
          )
          .limit(1);
        if (existing.length > 0) return;
      }
      await tx.insert(memoryEntry).values({
        companyId: ctx.companyId,
        ownerScopeKind: entry.ownerScopeKind,
        ownerScopeId: entry.ownerScopeId,
        sourceTaskId: entry.sourceTaskId ?? null,
        kind: entry.kind,
        content: entry.content,
        shareRule: entry.shareRule ?? null,
      });
    });
  }
}
