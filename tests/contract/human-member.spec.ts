import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { RequestContext } from '@claude-company/contracts';
import { closeDatabase, initDatabase, newId, withTenant } from '@claude-company/db';
import { domainEvent } from '@claude-company/db/schema/events';
import { humanMember } from '@claude-company/db/schema/employee';
import { asc, eq } from 'drizzle-orm';
import pg from 'pg';
import { EmployeeRepository } from '../../apps/api/src/engines/employee/employee.repository';
import { HumanMemberService } from '../../apps/api/src/engines/employee/human-member.service';
import { IDENTITY_DIRECTORY } from '../../apps/api/src/platform/engine-tokens';
import { EventPublisher } from '../../apps/api/src/platform/events/event-publisher';
import { prepareDatabase, startInfra, type StartedInfra } from '../support/containers';
import { FakeIdentityDirectory } from '../support/fake-engines';

describe('Contract: EmployeeEngine phần human member (T041a)', () => {
  let infra: StartedInfra;
  let owner: pg.Pool;
  let service: HumanMemberService;
  const identity = new FakeIdentityDirectory();
  const companyA = newId();
  const companyB = newId();
  const users = { ana: newId(), binh: newId(), chi: newId() };

  const ctx = (companyId: string): RequestContext => ({
    companyId,
    actor: { kind: 'system' },
    traceId: 't',
  });

  beforeAll(async () => {
    infra = await startInfra({ postgres: true, redis: false });
    initDatabase(await prepareDatabase(infra));
    owner = new pg.Pool({ connectionString: infra.databaseMigrationUrl, max: 1 });
    for (const [name, id] of Object.entries(users)) {
      const email = `${name}-${randomUUID().slice(0, 6)}@example.com`;
      await owner.query(
        `insert into "user"(id,email,password_hash,display_name) values ($1,$2,'h',$3)`,
        [id, email, name],
      );
      identity.add({ id, email, displayName: name });
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        HumanMemberService,
        EmployeeRepository,
        EventPublisher,
        { provide: IDENTITY_DIRECTORY, useValue: identity },
      ],
    }).compile();
    service = moduleRef.get(HumanMemberService);
  });

  afterAll(async () => {
    await owner?.end();
    await closeDatabase();
    await infra?.stop();
  });

  it('addHumanMember tạo member, kèm tên hiển thị, và ghi domain_event cùng transaction', async () => {
    const member = await service.addHumanMember(ctx(companyA), {
      userId: users.ana,
      role: 'ceo',
      title: 'CEO',
    });
    expect(member).toMatchObject({
      companyId: companyA,
      userId: users.ana,
      role: 'ceo',
      title: 'CEO',
      displayName: 'ana',
      disabledAt: null,
    });

    const events = await withTenant(companyA, (tx) =>
      tx.select().from(domainEvent).orderBy(asc(domainEvent.seq)),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seq: 1, type: 'human_member.added', aggregateId: member.id });
  });

  it('seq của domain_event liên tục theo company, độc lập giữa các company', async () => {
    await service.addHumanMember(ctx(companyA), { userId: users.binh, role: 'manager' });
    await service.addHumanMember(ctx(companyB), { userId: users.ana, role: 'ceo' });
    const a = await withTenant(companyA, (tx) =>
      tx.select({ seq: domainEvent.seq }).from(domainEvent).orderBy(asc(domainEvent.seq)),
    );
    const b = await withTenant(companyB, (tx) =>
      tx.select({ seq: domainEvent.seq }).from(domainEvent).orderBy(asc(domainEvent.seq)),
    );
    expect(a.map((e) => e.seq)).toEqual([1, 2]);
    expect(b.map((e) => e.seq)).toEqual([1]);
  });

  it('seq không trùng và không hở khi ghi đồng thời', async () => {
    const company = newId();
    await Promise.all(
      [users.ana, users.binh, users.chi].map((userId) =>
        service.addHumanMember(ctx(company), { userId, role: 'manager' }),
      ),
    );
    const rows = await withTenant(company, (tx) =>
      tx.select({ seq: domainEvent.seq }).from(domainEvent).orderBy(asc(domainEvent.seq)),
    );
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('thêm trùng người dùng vào cùng công ty → CONFLICT; user không tồn tại → NOT_FOUND', async () => {
    await expect(
      service.addHumanMember(ctx(companyA), { userId: users.ana, role: 'manager' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      service.addHumanMember(ctx(companyA), { userId: newId(), role: 'manager' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('listHumanMembers chỉ trả thành viên của công ty hiện tại và đang hoạt động', async () => {
    const listA = await service.listHumanMembers(ctx(companyA));
    expect(listA.map((m) => m.displayName).sort()).toEqual(['ana', 'binh']);
    const listB = await service.listHumanMembers(ctx(companyB));
    expect(listB.map((m) => m.displayName)).toEqual(['ana']);

    await withTenant(companyA, (tx) =>
      tx
        .update(humanMember)
        .set({ disabledAt: new Date() })
        .where(eq(humanMember.userId, users.binh)),
    );
    expect((await service.listHumanMembers(ctx(companyA))).map((m) => m.displayName)).toEqual([
      'ana',
    ]);
  });

  it('findMemberships trả các company của chính người dùng, bỏ thành viên đã vô hiệu', async () => {
    const ana = await service.findMemberships(users.ana);
    // ana còn là manager của công ty tạo ở bài test ghi đồng thời, nên chỉ kiểm tra hai công ty đã biết.
    const byCompany = new Map(ana.map((m) => [m.companyId, m.role]));
    expect(byCompany.get(companyA)).toBe('ceo');
    expect(byCompany.get(companyB)).toBe('ceo');
    expect(ana).toHaveLength(3);

    const binh = await service.findMemberships(users.binh);
    expect(binh.map((m) => m.companyId)).not.toContain(companyA); // đã vô hiệu ở công ty A
    expect(await service.findMemberships(newId())).toEqual([]);
  });
});
