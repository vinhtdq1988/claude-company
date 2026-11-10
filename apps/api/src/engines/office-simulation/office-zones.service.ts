import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type {
  EmployeeEngine,
  OrganizationEngine,
  OrgChartNode,
  RequestContext,
} from '@claude-company/contracts';
import type { Tx } from '@claude-company/db';
import { EMPLOYEE_ENGINE, ORGANIZATION_ENGINE } from '../../platform/engine-tokens';
import { placeZones, type ZoneSlot } from './office-layout';
import { OfficeRepository } from './office.repository';

const byOrder = (a: OrgChartNode, b: OrgChartNode) =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * Đồng bộ `office_zone` với cơ cấu tổ chức (T155, FR-034): mỗi department một zone cùng CEO Office và Break Room.
 * Bố cục tất định (office-layout.ts). Đọc department qua `OrganizationEngine` và nhân viên qua `EmployeeEngine`
 * (Nguyên tắc VI), chỉ ghi bảng của mình.
 */
@Injectable()
export class OfficeZonesService {
  constructor(
    private readonly repo: OfficeRepository,
    private readonly moduleRef: ModuleRef,
  ) {}

  private get organization(): OrganizationEngine {
    return this.moduleRef.get<OrganizationEngine>(ORGANIZATION_ENGINE, { strict: false });
  }
  private get employees(): EmployeeEngine {
    return this.moduleRef.get<EmployeeEngine>(EMPLOYEE_ENGINE, { strict: false });
  }

  /** Mọi nhân viên chưa archived, theo thứ tự tạo (UUIDv7 tăng dần theo thời gian): quyết định `deskIndex`. */
  async employeesByUnit(ctx: RequestContext): Promise<Map<string, string[]>> {
    const list = (await this.employees.list(ctx, {})).filter((e) => e.status !== 'archived');
    const byUnit = new Map<string, string[]>();
    for (const e of [...list].sort((a, b) => a.id.localeCompare(b.id))) {
      byUnit.set(e.homeOrgUnitId, [...(byUnit.get(e.homeOrgUnitId) ?? []), e.id]);
    }
    return byUnit;
  }

  /** Trả `true` nếu có thay đổi. Chạy trong transaction của người gọi (đã giữ khóa công ty). */
  async sync(tx: Tx, ctx: RequestContext): Promise<boolean> {
    const [chart, byUnit] = await Promise.all([
      this.organization.getOrgChart(ctx),
      this.employeesByUnit(ctx),
    ]);

    const slots: ZoneSlot[] = [];
    const visit = (nodes: OrgChartNode[]) => {
      for (const node of [...nodes].sort(byOrder)) {
        const count = byUnit.get(node.id)?.length ?? 0;
        // Division chỉ có zone khi có nhân viên "nhà" trực tiếp để nhân vật không bị mất chỗ.
        if (node.kind === 'department' || count > 0) {
          slots.push({
            key: `org_unit:${node.id}`,
            kind: 'department',
            name: node.name,
            orgUnitId: node.id,
            employeeCount: count,
          });
        }
        visit(node.children);
      }
    };
    visit(chart.roots);

    const desired = placeZones(slots);
    const existing = await this.repo.listZones(tx, ctx.companyId);
    const keyOf = (z: { kind: string; orgUnitId: string | null }) =>
      z.kind === 'department' ? `org_unit:${z.orgUnitId}` : z.kind;
    const current = new Map(existing.map((z) => [keyOf(z), z]));

    let changed = false;
    for (const zone of desired) {
      const row = current.get(zone.key);
      if (!row) {
        await this.repo.insertZone(tx, ctx.companyId, {
          kind: zone.kind,
          orgUnitId: zone.orgUnitId,
          name: zone.name,
          layout: zone.layout,
        });
        changed = true;
      } else if (
        row.name !== zone.name ||
        JSON.stringify(row.layout) !== JSON.stringify(zone.layout)
      ) {
        await this.repo.updateZone(tx, ctx.companyId, row.id, {
          name: zone.name,
          layout: zone.layout,
        });
        changed = true;
      }
      current.delete(zone.key);
    }
    const stale = [...current.values()].map((z) => z.id);
    await this.repo.deleteZones(tx, ctx.companyId, stale);
    return changed || stale.length > 0;
  }
}
