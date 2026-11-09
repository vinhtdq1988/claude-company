import { Injectable } from '@nestjs/common';
import type { Tx } from '@claude-company/db';
import {
  aiEmployee,
  humanMember,
  roleTemplate,
  workspace,
} from '@claude-company/db/schema/employee';
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';

export type EmployeeRow = typeof aiEmployee.$inferSelect;
export type NewEmployeeRow = typeof aiEmployee.$inferInsert;
export type HumanMemberRow = typeof humanMember.$inferSelect;
export type WorkspaceRow = typeof workspace.$inferSelect;
export type RoleTemplateRow = typeof roleTemplate.$inferSelect;

/** Mã lỗi PostgreSQL vi phạm ràng buộc UNIQUE. */
export const UNIQUE_VIOLATION = '23505';

export function pgErrorCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
}

/** Truy cập bảng của Employee Engine. Mọi phương thức chạy trong transaction `withTenant` (RLS). */
@Injectable()
export class EmployeeRepository {
  // --- ai_employee ---

  async insert(tx: Tx, values: NewEmployeeRow): Promise<EmployeeRow> {
    const [row] = await tx.insert(aiEmployee).values(values).returning();
    if (!row) throw new Error('Không tạo được ai_employee');
    return row;
  }

  async update(
    tx: Tx,
    companyId: string,
    id: string,
    patch: Partial<Omit<NewEmployeeRow, 'id' | 'companyId'>>,
  ): Promise<EmployeeRow> {
    const [row] = await tx
      .update(aiEmployee)
      .set(patch)
      .where(and(eq(aiEmployee.companyId, companyId), eq(aiEmployee.id, id)))
      .returning();
    if (!row) throw new Error('Không cập nhật được ai_employee');
    return row;
  }

  async find(tx: Tx, companyId: string, id: string): Promise<EmployeeRow | undefined> {
    const [row] = await tx
      .select()
      .from(aiEmployee)
      .where(and(eq(aiEmployee.companyId, companyId), eq(aiEmployee.id, id)));
    return row;
  }

  /** Nhân viên của công ty theo thứ tự tuyển; `archived` quyết định có lấy cả nhân viên đã lưu trữ. */
  list(
    tx: Tx,
    companyId: string,
    filter: {
      orgUnitId?: string;
      kind?: EmployeeRow['kind'];
      status?: EmployeeRow['status'];
      ids?: string[];
    } = {},
  ): Promise<EmployeeRow[]> {
    const conditions = [eq(aiEmployee.companyId, companyId)];
    if (filter.orgUnitId) conditions.push(eq(aiEmployee.homeOrgUnitId, filter.orgUnitId));
    if (filter.kind) conditions.push(eq(aiEmployee.kind, filter.kind));
    if (filter.status) conditions.push(eq(aiEmployee.status, filter.status));
    else conditions.push(ne(aiEmployee.status, 'archived'));
    if (filter.ids) {
      if (filter.ids.length === 0) return Promise.resolve([]);
      conditions.push(inArray(aiEmployee.id, filter.ids));
    }
    return tx
      .select()
      .from(aiEmployee)
      .where(and(...conditions))
      .orderBy(asc(aiEmployee.createdAt), asc(aiEmployee.id));
  }

  /** Cấp dưới trực tiếp chưa archived của một manager (người thật hoặc AI Manager). */
  listDirectReports(
    tx: Tx,
    companyId: string,
    manager: { kind: EmployeeRow['managerKind']; id: string },
  ): Promise<EmployeeRow[]> {
    return tx
      .select()
      .from(aiEmployee)
      .where(
        and(
          eq(aiEmployee.companyId, companyId),
          eq(aiEmployee.managerKind, manager.kind),
          eq(aiEmployee.managerId, manager.id),
          ne(aiEmployee.status, 'archived'),
        ),
      )
      .orderBy(asc(aiEmployee.createdAt), asc(aiEmployee.id));
  }

  // --- human_member ---

  async findHumanMember(
    tx: Tx,
    companyId: string,
    id: string,
  ): Promise<HumanMemberRow | undefined> {
    const [row] = await tx
      .select()
      .from(humanMember)
      .where(and(eq(humanMember.companyId, companyId), eq(humanMember.id, id)));
    return row;
  }

  async listActiveHumanIds(tx: Tx, companyId: string): Promise<string[]> {
    const rows = await tx
      .select({ id: humanMember.id })
      .from(humanMember)
      .where(and(eq(humanMember.companyId, companyId), isNull(humanMember.disabledAt)));
    return rows.map((r) => r.id);
  }

  async disableHumanMember(tx: Tx, companyId: string, id: string): Promise<void> {
    await tx
      .update(humanMember)
      .set({ disabledAt: new Date() })
      .where(and(eq(humanMember.companyId, companyId), eq(humanMember.id, id)));
  }

  // --- workspace ---

  async insertWorkspace(tx: Tx, values: typeof workspace.$inferInsert): Promise<WorkspaceRow> {
    const [row] = await tx.insert(workspace).values(values).returning();
    if (!row) throw new Error('Không tạo được workspace');
    return row;
  }

  listWorkspaces(tx: Tx, companyId: string): Promise<WorkspaceRow[]> {
    return tx
      .select()
      .from(workspace)
      .where(eq(workspace.companyId, companyId))
      .orderBy(asc(workspace.name), asc(workspace.id));
  }

  async findWorkspace(tx: Tx, companyId: string, id: string): Promise<WorkspaceRow | undefined> {
    const [row] = await tx
      .select()
      .from(workspace)
      .where(and(eq(workspace.companyId, companyId), eq(workspace.id, id)));
    return row;
  }

  // --- role_template (bảng toàn cục, không RLS) ---

  listRoleTemplates(tx: Tx): Promise<RoleTemplateRow[]> {
    return tx
      .select()
      .from(roleTemplate)
      .orderBy(asc(roleTemplate.createdAt), asc(roleTemplate.key));
  }
}
