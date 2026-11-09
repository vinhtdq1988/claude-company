import { Injectable } from '@nestjs/common';
import type { MemberRef } from '@claude-company/contracts';
import type { Tx } from '@claude-company/db';
import {
  company,
  managementAssignment,
  orgTemplate,
  orgUnit,
  team,
  teamMembership,
} from '@claude-company/db/schema/organization';
import { and, asc, eq, inArray, isNull, max, sql } from 'drizzle-orm';

export type CompanyRow = typeof company.$inferSelect;
export type OrgUnitRow = typeof orgUnit.$inferSelect;
export type TeamRow = typeof team.$inferSelect;
export type TeamMembershipRow = typeof teamMembership.$inferSelect;
export type ManagementAssignmentRow = typeof managementAssignment.$inferSelect;
export type OrgTemplateRow = typeof orgTemplate.$inferSelect;

export type ManagementTarget = ManagementAssignmentRow['targetKind'];

/** Mã lỗi PostgreSQL vi phạm ràng buộc UNIQUE. */
export const UNIQUE_VIOLATION = '23505';

export function pgErrorCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
}

/** Truy cập bảng của Organization Engine. Mọi phương thức chạy trong transaction `withTenant` (RLS). */
@Injectable()
export class OrganizationRepository {
  // --- company ---

  async insertCompany(
    tx: Tx,
    values: { id: string; name: string; templateKey: string | null },
  ): Promise<CompanyRow> {
    const [row] = await tx.insert(company).values(values).returning();
    if (!row) throw new Error('Không tạo được company');
    return row;
  }

  async findCompany(tx: Tx, id: string): Promise<CompanyRow | undefined> {
    const [row] = await tx.select().from(company).where(eq(company.id, id));
    return row;
  }

  // --- org_template (bảng toàn cục, không RLS) ---

  async findTemplate(tx: Tx, key: string): Promise<OrgTemplateRow | undefined> {
    const [row] = await tx.select().from(orgTemplate).where(eq(orgTemplate.key, key));
    return row;
  }

  listTemplates(tx: Tx): Promise<OrgTemplateRow[]> {
    return tx.select().from(orgTemplate).orderBy(asc(orgTemplate.name));
  }

  // --- org_unit ---

  async insertOrgUnit(
    tx: Tx,
    values: {
      id?: string;
      companyId: string;
      kind: OrgUnitRow['kind'];
      parentId: string | null;
      name: string;
      sortOrder: number;
    },
  ): Promise<OrgUnitRow> {
    const [row] = await tx.insert(orgUnit).values(values).returning();
    if (!row) throw new Error('Không tạo được org_unit');
    return row;
  }

  async updateOrgUnit(
    tx: Tx,
    companyId: string,
    id: string,
    patch: Partial<Pick<OrgUnitRow, 'name' | 'parentId' | 'sortOrder' | 'archivedAt'>>,
  ): Promise<OrgUnitRow> {
    const [row] = await tx
      .update(orgUnit)
      .set(patch)
      .where(and(eq(orgUnit.companyId, companyId), eq(orgUnit.id, id)))
      .returning();
    if (!row) throw new Error('Không cập nhật được org_unit');
    return row;
  }

  async findOrgUnit(tx: Tx, companyId: string, id: string): Promise<OrgUnitRow | undefined> {
    const [row] = await tx
      .select()
      .from(orgUnit)
      .where(and(eq(orgUnit.companyId, companyId), eq(orgUnit.id, id)));
    return row;
  }

  /** Đơn vị chưa archived của công ty, theo thứ tự hiển thị. */
  listActiveOrgUnits(tx: Tx, companyId: string): Promise<OrgUnitRow[]> {
    return tx
      .select()
      .from(orgUnit)
      .where(and(eq(orgUnit.companyId, companyId), isNull(orgUnit.archivedAt)))
      .orderBy(asc(orgUnit.sortOrder), asc(orgUnit.createdAt), asc(orgUnit.id));
  }

  /** `sort_order` kế tiếp trong cùng parent, để đơn vị mới nằm cuối danh sách. */
  async nextOrgUnitSortOrder(tx: Tx, companyId: string, parentId: string | null): Promise<number> {
    const [row] = await tx
      .select({ value: max(orgUnit.sortOrder) })
      .from(orgUnit)
      .where(
        and(
          eq(orgUnit.companyId, companyId),
          isNull(orgUnit.archivedAt),
          parentId === null ? isNull(orgUnit.parentId) : eq(orgUnit.parentId, parentId),
        ),
      );
    return (row?.value ?? -1) + 1;
  }

  // --- team ---

  async insertTeam(
    tx: Tx,
    values: { companyId: string; orgUnitId: string; name: string; sortOrder: number },
  ): Promise<TeamRow> {
    const [row] = await tx.insert(team).values(values).returning();
    if (!row) throw new Error('Không tạo được team');
    return row;
  }

  async updateTeam(
    tx: Tx,
    companyId: string,
    id: string,
    patch: Partial<Pick<TeamRow, 'name' | 'orgUnitId' | 'sortOrder' | 'archivedAt'>>,
  ): Promise<TeamRow> {
    const [row] = await tx
      .update(team)
      .set(patch)
      .where(and(eq(team.companyId, companyId), eq(team.id, id)))
      .returning();
    if (!row) throw new Error('Không cập nhật được team');
    return row;
  }

  async findTeam(tx: Tx, companyId: string, id: string): Promise<TeamRow | undefined> {
    const [row] = await tx
      .select()
      .from(team)
      .where(and(eq(team.companyId, companyId), eq(team.id, id)));
    return row;
  }

  listActiveTeams(tx: Tx, companyId: string): Promise<TeamRow[]> {
    return tx
      .select()
      .from(team)
      .where(and(eq(team.companyId, companyId), isNull(team.archivedAt)))
      .orderBy(asc(team.sortOrder), asc(team.createdAt), asc(team.id));
  }

  async nextTeamSortOrder(tx: Tx, companyId: string, orgUnitId: string): Promise<number> {
    const [row] = await tx
      .select({ value: max(team.sortOrder) })
      .from(team)
      .where(
        and(eq(team.companyId, companyId), eq(team.orgUnitId, orgUnitId), isNull(team.archivedAt)),
      );
    return (row?.value ?? -1) + 1;
  }

  // --- team_membership ---

  listTeamMemberships(tx: Tx, companyId: string): Promise<TeamMembershipRow[]> {
    return tx.select().from(teamMembership).where(eq(teamMembership.companyId, companyId));
  }

  listMembersOfTeam(tx: Tx, companyId: string, teamId: string): Promise<TeamMembershipRow[]> {
    return tx
      .select()
      .from(teamMembership)
      .where(and(eq(teamMembership.companyId, companyId), eq(teamMembership.teamId, teamId)))
      .orderBy(asc(teamMembership.createdAt), asc(teamMembership.id));
  }

  /** Thay toàn bộ thành viên của team bằng danh sách mới (đã được service kiểm tra). */
  async replaceTeamMembers(
    tx: Tx,
    companyId: string,
    teamId: string,
    members: MemberRef[],
  ): Promise<void> {
    await tx
      .delete(teamMembership)
      .where(and(eq(teamMembership.companyId, companyId), eq(teamMembership.teamId, teamId)));
    if (members.length === 0) return;
    await tx
      .insert(teamMembership)
      .values(members.map((m) => ({ companyId, teamId, memberKind: m.kind, memberId: m.id })));
  }

  // --- management_assignment ---

  listAssignments(tx: Tx, companyId: string): Promise<ManagementAssignmentRow[]> {
    return tx
      .select()
      .from(managementAssignment)
      .where(eq(managementAssignment.companyId, companyId));
  }

  async upsertAssignment(
    tx: Tx,
    values: {
      companyId: string;
      targetKind: ManagementTarget;
      targetId: string;
      managerMemberId: string;
    },
  ): Promise<void> {
    await tx
      .insert(managementAssignment)
      .values(values)
      .onConflictDoUpdate({
        target: [
          managementAssignment.companyId,
          managementAssignment.targetKind,
          managementAssignment.targetId,
        ],
        set: { managerMemberId: values.managerMemberId, updatedAt: sql`now()` },
      });
  }

  async deleteAssignmentsOf(
    tx: Tx,
    companyId: string,
    targetKind: ManagementTarget,
    targetIds: string[],
  ): Promise<void> {
    if (targetIds.length === 0) return;
    await tx
      .delete(managementAssignment)
      .where(
        and(
          eq(managementAssignment.companyId, companyId),
          eq(managementAssignment.targetKind, targetKind),
          inArray(managementAssignment.targetId, targetIds),
        ),
      );
  }
}
