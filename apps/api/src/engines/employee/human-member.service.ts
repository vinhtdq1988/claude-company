import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  type EmployeeEngine,
  type HumanMember,
  type HumanRole,
  type IdentityDirectory,
  type Membership,
  type RequestContext,
} from '@claude-company/contracts';
import { withUser } from '@claude-company/db';
import { humanMember } from '@claude-company/db/schema/employee';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { IDENTITY_DIRECTORY } from '../../platform/engine-tokens';
import { inTenant } from '../../platform/tenancy/tenant-store';
import { EventPublisher } from '../../platform/events/event-publisher';
import { EmployeeRepository } from './employee.repository';
import { walkManagementChain, type ChainNode } from './management-chain';

type HumanMemberRow = typeof humanMember.$inferSelect;

const UNIQUE_VIOLATION = '23505';

function pgErrorCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
}

/** Số nhân viên tối đa liệt kê trong lỗi khi chặn vô hiệu người thật. */
const BLOCKER_LIMIT = 50;

/** Phần human member của EmployeeEngine (D4), gồm kiểm tra chuỗi quản lý khi vô hiệu (T071). */
@Injectable()
export class HumanMemberService implements Pick<
  EmployeeEngine,
  'addHumanMember' | 'listHumanMembers' | 'findMemberships' | 'deactivateHumanMember'
> {
  constructor(
    @Inject(IDENTITY_DIRECTORY) private readonly identity: IdentityDirectory,
    private readonly events: EventPublisher,
    private readonly employees: EmployeeRepository,
  ) {}

  private toDto(row: HumanMemberRow, displayName: string): HumanMember {
    return {
      id: row.id,
      companyId: row.companyId,
      userId: row.userId,
      role: row.role,
      title: row.title,
      displayName,
      disabledAt: row.disabledAt?.toISOString() ?? null,
    };
  }

  async addHumanMember(
    ctx: RequestContext,
    input: { userId: string; role: HumanRole; title?: string },
  ): Promise<HumanMember> {
    const [user] = await this.identity.getUsers([input.userId]);
    if (!user) throw new DomainError('NOT_FOUND', 'Tài khoản không tồn tại');
    try {
      const row = await inTenant(ctx, async (tx) => {
        const [inserted] = await tx
          .insert(humanMember)
          .values({
            companyId: ctx.companyId,
            userId: input.userId,
            role: input.role,
            title: input.title ?? null,
          })
          .returning();
        if (!inserted) throw new Error('Không tạo được human_member');
        await this.events.publish(tx, ctx, {
          type: 'human_member.added',
          aggregateKind: 'human_member',
          aggregateId: inserted.id,
          payload: { memberId: inserted.id, role: inserted.role },
        });
        return inserted;
      });
      return this.toDto(row, user.displayName);
    } catch (error) {
      if (pgErrorCode(error) === UNIQUE_VIOLATION) {
        throw new DomainError('CONFLICT', 'Người dùng đã là thành viên của công ty');
      }
      throw error;
    }
  }

  async listHumanMembers(ctx: RequestContext): Promise<HumanMember[]> {
    const rows = await inTenant(ctx, (tx) =>
      tx
        .select()
        .from(humanMember)
        .where(and(eq(humanMember.companyId, ctx.companyId), isNull(humanMember.disabledAt)))
        .orderBy(asc(humanMember.createdAt)),
    );
    const users = await this.identity.getUsers(rows.map((r) => r.userId));
    const names = new Map(users.map((u) => [u.id, u.displayName]));
    return rows.map((r) => this.toDto(r, names.get(r.userId) ?? ''));
  }

  /** Chạy theo `app.user_id` (policy human_member theo user, D3); không có ctx vì chưa biết company. */
  async findMemberships(userId: string): Promise<Membership[]> {
    const rows = await withUser(userId, (tx) =>
      tx
        .select({
          companyId: humanMember.companyId,
          memberId: humanMember.id,
          role: humanMember.role,
        })
        .from(humanMember)
        .where(and(eq(humanMember.userId, userId), isNull(humanMember.disabledAt))),
    );
    return rows;
  }

  /**
   * Vô hiệu một người thật. Bị chặn nếu họ là người thật cuối của chuỗi quản lý của bất kỳ AI Employee
   * chưa archived nào (kể cả manager trực tiếp), vì chuỗi phải luôn kết thúc ở người đang hoạt động (FR-006).
   */
  async deactivateHumanMember(ctx: RequestContext, memberId: string): Promise<void> {
    await inTenant(ctx, async (tx) => {
      const member = await this.employees.findHumanMember(tx, ctx.companyId, memberId);
      if (!member || member.disabledAt) {
        throw new DomainError('NOT_FOUND', 'Không tìm thấy thành viên đang hoạt động');
      }
      const [rows, humanIds] = await Promise.all([
        this.employees.list(tx, ctx.companyId),
        this.employees.listActiveHumanIds(tx, ctx.companyId),
      ]);
      const nodes = new Map<string, ChainNode>(
        rows.map((r) => [
          r.id,
          {
            id: r.id,
            kind: r.kind,
            status: r.status,
            manager: { kind: r.managerKind, id: r.managerId },
          },
        ]),
      );
      const remaining = new Set(humanIds.filter((id) => id !== memberId));
      const orphaned = rows.filter((r) => {
        const result = walkManagementChain(
          { employees: nodes, activeHumanIds: remaining },
          { id: r.id, manager: { kind: r.managerKind, id: r.managerId } },
        );
        return !result.ok && result.reason === 'HUMAN_INACTIVE' && result.at === memberId;
      });
      if (orphaned.length > 0) {
        throw new DomainError(
          'MANAGEMENT_CHAIN_INVALID',
          'Người này là người thật cuối của chuỗi quản lý AI: hãy chuyển manager trước khi vô hiệu',
          {
            reason: 'LAST_HUMAN_IN_CHAIN',
            employees: orphaned.slice(0, BLOCKER_LIMIT).map((r) => ({ id: r.id, name: r.name })),
          },
        );
      }
      await this.employees.disableHumanMember(tx, ctx.companyId, memberId);
      await this.events.publish(tx, ctx, {
        type: 'human_member.deactivated',
        aggregateKind: 'human_member',
        aggregateId: memberId,
        payload: { memberId },
      });
    });
  }
}
