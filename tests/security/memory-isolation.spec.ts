import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmployeeProfile } from '@claude-company/contracts';
import { withTenant } from '@claude-company/db';
import { memoryEntry } from '@claude-company/db/schema/memory';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { createFlowHarness, type FlowHarness, type Scene } from '../support/flow-harness';

/**
 * Cô lập bộ nhớ theo scope (T087; FR-013, R11, Nguyên tắc II): `recall` không trả dữ liệu ngoài scope khi
 * `share_rule` null, kể cả giữa hai công ty. Chạy với engine thật trên PostgreSQL (RLS bật).
 */
describe('Cô lập Memory Engine (T087)', () => {
  let infra: StartedInfra;
  let h: FlowHarness;
  let a: Scene;
  let b: Scene;
  let aDev: EmployeeProfile;
  let aBa: EmployeeProfile;
  let bDev: EmployeeProfile;

  const scope = (employeeId: string) => ({ employeeId, taskId: randomUUID() });
  const contents = async (scene: Scene, employeeId: string) =>
    (await h.memory.recall(scene.ctx(), scope(employeeId), 100)).map((m) => m.content).sort();

  beforeAll(async () => {
    infra = await startInfra({ redis: false });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    h = await createFlowHarness({ infra });
    a = await h.newScene('Công ty A');
    b = await h.newScene('Công ty B');
    aDev = await h.hire(a);
    aBa = await h.hire(a, { name: 'AI BA', position: 'AI BA', homeOrgUnitId: a.units.BA! });
    bDev = await h.hire(b);
  });

  afterAll(async () => {
    await h?.close();
    await infra?.stop();
  });

  it('share_rule null: ký ức riêng của nhân viên không lộ cho nhân viên khác cùng công ty', async () => {
    await h.memory.remember(a.ctx(), {
      ownerScopeKind: 'ai_employee',
      ownerScopeId: aDev.id,
      kind: 'note',
      content: 'bí mật của dev A',
      shareRule: null,
    });
    expect(await contents(a, aDev.id)).toContain('bí mật của dev A');
    expect(await contents(a, aBa.id)).not.toContain('bí mật của dev A');
  });

  it('share_rule bỏ trống (undefined) cũng là không chia sẻ', async () => {
    await h.memory.remember(a.ctx(), {
      ownerScopeKind: 'ai_employee',
      ownerScopeId: aDev.id,
      kind: 'note',
      content: 'không khai báo share_rule',
    });
    expect(await contents(a, aBa.id)).not.toContain('không khai báo share_rule');
  });

  it('ký ức của phòng ban khác không lộ cho nhân viên không thuộc phòng đó', async () => {
    await h.memory.remember(a.ctx(), {
      ownerScopeKind: 'org_unit',
      ownerScopeId: a.units.Development!,
      kind: 'note',
      content: 'chỉ phòng Development',
    });
    expect(await contents(a, aDev.id)).toContain('chỉ phòng Development');
    expect(await contents(a, aBa.id)).not.toContain('chỉ phòng Development');
  });

  it('share_rule chỉ mở cho đúng scope được liệt kê, không mở cho scope khác', async () => {
    await h.memory.remember(a.ctx(), {
      ownerScopeKind: 'ai_employee',
      ownerScopeId: aDev.id,
      kind: 'note',
      content: 'chia sẻ cho phòng BA',
      shareRule: { scopes: [{ kind: 'org_unit', id: a.units.BA! }] },
    });
    expect(await contents(a, aBa.id)).toContain('chia sẻ cho phòng BA');
    const qa = await h.hire(a, { name: 'AI QA', position: 'AI QA', homeOrgUnitId: a.units.QA! });
    expect(await contents(a, qa.id)).not.toContain('chia sẻ cho phòng BA');
  });

  it('giữa hai công ty: recall của công ty B không thấy ký ức của A', async () => {
    await h.memory.remember(a.ctx(), {
      ownerScopeKind: 'ai_employee',
      ownerScopeId: aDev.id,
      kind: 'note',
      content: 'chỉ công ty A',
    });
    expect(await contents(b, bDev.id)).toEqual([]);
  });

  it('share_rule trỏ tới scope của công ty khác vẫn không lộ (RLS chặn theo company_id)', async () => {
    await h.memory.remember(a.ctx(), {
      ownerScopeKind: 'ai_employee',
      ownerScopeId: aDev.id,
      kind: 'note',
      content: 'cố chia sẻ sang công ty B',
      shareRule: {
        scopes: [
          { kind: 'ai_employee', id: bDev.id },
          { kind: 'org_unit', id: b.units.Development! },
        ],
      },
    });
    expect(await contents(b, bDev.id)).not.toContain('cố chia sẻ sang công ty B');
  });

  it('recall dùng employeeId của công ty khác trong ngữ cảnh này → NOT_FOUND, không rò dữ liệu', async () => {
    await expect(h.memory.recall(b.ctx(), scope(aDev.id), 10)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(h.memory.recall(a.ctx(), scope(bDev.id), 10)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('truy vấn thẳng bảng memory_entry dưới tenant B không thấy dòng nào của A (RLS)', async () => {
    const seenByB = await withTenant(b.companyId, (tx) => tx.select().from(memoryEntry));
    expect(seenByB.every((row) => row.companyId === b.companyId)).toBe(true);
    expect(seenByB.some((row) => row.content.includes('công ty A'))).toBe(false);
    const seenByA = await withTenant(a.companyId, (tx) => tx.select().from(memoryEntry));
    expect(seenByA.length).toBeGreaterThan(0);
    expect(seenByA.every((row) => row.companyId === a.companyId)).toBe(true);
  });

  it('ghi memory_entry với company_id của công ty khác bị RLS từ chối', async () => {
    await expect(
      withTenant(b.companyId, (tx) =>
        tx.insert(memoryEntry).values({
          companyId: a.companyId,
          ownerScopeKind: 'ai_employee',
          ownerScopeId: aDev.id,
          kind: 'note',
          content: 'ghi chéo công ty',
        }),
      ),
    ).rejects.toBeDefined();
  });
});
