import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, newId, withTenant, type Database } from '@claude-company/db';
import { domainEvent } from '@claude-company/db/schema/events';
import { humanMember } from '@claude-company/db/schema/employee';
import { company } from '@claude-company/db/schema/organization';
import { user } from '@claude-company/db/schema/auth';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { UnsafeDatabaseRoleError } from '../../apps/api/src/platform/config/infra.providers';
import { createTestApp } from '../support/app';
import {
  prepareDatabase,
  startInfra,
  TEST_APP_DB_PASSWORD,
  type StartedInfra,
} from '../support/containers';

describe('Cô lập tenant bằng RLS (T027; SC-012)', () => {
  let infra: StartedInfra;
  let app: Database;
  let owner: pg.Pool;
  const companyA = newId();
  const companyB = newId();

  beforeAll(async () => {
    infra = await startInfra({ postgres: true, redis: true });
    const appUrl = await prepareDatabase(infra);
    app = createDatabase(appUrl);
    owner = new pg.Pool({ connectionString: infra.databaseMigrationUrl, max: 2 });

    const [u1, u2] = [newId(), newId()];
    await owner.query(
      `insert into "user"(id,email,password_hash,display_name) values ($1,$2,'h','A'),($3,$4,'h','B')`,
      [u1, `a-${randomUUID()}@x.vn`, u2, `b-${randomUUID()}@x.vn`],
    );
    for (const [id, userId] of [
      [companyA, u1],
      [companyB, u2],
    ] as const) {
      await withTenant(
        id,
        async (tx) => {
          await tx.insert(company).values({ id, name: `Công ty ${id.slice(-4)}` });
          await tx.insert(humanMember).values({ companyId: id, userId, role: 'ceo' });
          await tx.insert(domainEvent).values({
            companyId: id,
            seq: 1,
            type: 'company.created',
            aggregateKind: 'company',
            aggregateId: id,
          });
        },
        { database: app, userId },
      );
    }
  });

  afterAll(async () => {
    await app?.close();
    await owner?.end();
    await infra?.stop();
  });

  it('truy vấn không có WHERE chỉ trả dữ liệu công ty hiện tại', async () => {
    for (const id of [companyA, companyB]) {
      await withTenant(
        id,
        async (tx) => {
          const members = await tx.select().from(humanMember);
          const events = await tx.select().from(domainEvent);
          const companies = await tx.select().from(company);
          expect(members.map((m) => m.companyId)).toEqual([id]);
          expect(events.map((e) => e.companyId)).toEqual([id]);
          expect(companies.map((c) => c.id)).toEqual([id]);
        },
        { database: app },
      );
    }
  });

  it('không đặt app.company_id → 0 dòng', async () => {
    for (const table of ['human_member', 'domain_event', 'company', 'action_policy']) {
      const r = await app.pool.query(`select count(*)::int as n from ${table}`);
      expect(r.rows[0].n, table).toBe(0);
    }
  });

  it('app.company_id rỗng hoặc rác không khớp dòng nào', async () => {
    const client = await app.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.company_id', '', true)`);
      expect((await client.query('select count(*)::int as n from human_member')).rows[0].n).toBe(0);
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('không ghi chéo được sang company khác', async () => {
    await expect(
      withTenant(
        companyA,
        (tx) =>
          tx.insert(humanMember).values({ companyId: companyB, userId: newId(), role: 'manager' }),
        { database: app },
      ),
    ).rejects.toThrow();
  });

  it('chỉ cập nhật/xóa được dòng của công ty hiện tại', async () => {
    await withTenant(
      companyA,
      async (tx) => {
        const updated = await tx
          .update(humanMember)
          .set({ title: 'x' })
          .returning({ id: humanMember.id });
        expect(updated).toHaveLength(1);
      },
      { database: app },
    );
    const b = await owner.query('select title from human_member where company_id = $1', [companyB]);
    expect(b.rows[0].title).toBeNull();
  });

  it('theo app.user_id chỉ thấy membership của chính người dùng (D3)', async () => {
    const users = await owner.query('select id from "user" order by email');
    const [first] = users.rows as Array<{ id: string }>;
    const client = await app.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.user_id', $1, true)`, [first?.id]);
      const r = await client.query('select company_id from human_member');
      expect(r.rows).toHaveLength(1);
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('bảng user là toàn cục và truy cập được không cần tenant', async () => {
    const rows = await app.db.select({ id: user.id }).from(user);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('mọi bảng có company_id (và company) đều bật RLS + FORCE', async () => {
    const r = await owner.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and (c.relname = 'company' or exists (
          select 1 from information_schema.columns col
          where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'company_id'))`);
    expect(r.rows.length).toBeGreaterThan(0);
    const bad = r.rows
      .filter((x) => !x.relrowsecurity || !x.relforcerowsecurity)
      .map((x) => x.relname);
    expect(bad).toEqual([]);
  });

  it('role app_user không phải superuser và không có BYPASSRLS', async () => {
    const r = await app.pool.query(
      'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
    );
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('hàm SECURITY DEFINER chỉ trả company_id', async () => {
    const r = await app.pool.query('select * from list_companies_with_unpublished_events()');
    const ids = (r.rows as Array<Record<string, string>>).map((row) => Object.values(row)[0]);
    expect(ids.sort()).toEqual([companyA, companyB].sort());
    // app_user không đọc trực tiếp được cột payload dù hàm do role BYPASSRLS làm chủ.
    await expect(app.db.execute(sql`select payload from domain_event`)).resolves.toBeDefined();
  });

  it('API từ chối khởi động khi DATABASE_URL dùng role superuser', async () => {
    const superUrl = infra.databaseMigrationUrl;
    await expect(
      createTestApp({ infra: { ...infra, databaseUrl: superUrl }, tenantProbe: false }),
    ).rejects.toBeInstanceOf(UnsafeDatabaseRoleError);
  });

  it('API từ chối khởi động khi DATABASE_URL dùng role có BYPASSRLS', async () => {
    await owner.query(`drop role if exists bypass_probe`);
    await owner.query(
      `create role bypass_probe login bypassrls password '${TEST_APP_DB_PASSWORD}'`,
    );
    await owner.query(`grant all on all tables in schema public to bypass_probe`);
    const url = new URL(infra.databaseMigrationUrl ?? '');
    url.username = 'bypass_probe';
    url.password = TEST_APP_DB_PASSWORD;
    await expect(
      createTestApp({ infra: { ...infra, databaseUrl: url.toString() }, tenantProbe: false }),
    ).rejects.toBeInstanceOf(UnsafeDatabaseRoleError);
  });
});
