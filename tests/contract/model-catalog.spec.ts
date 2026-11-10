import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, initDatabase } from '@claude-company/db';
import pg from 'pg';
import { ModelCatalogService } from '../../apps/api/src/platform/usage-budget/model-catalog.service';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';

describe('Contract: ModelCatalog (T069a)', () => {
  let infra: StartedInfra;
  let owner: pg.Pool;
  const catalog = new ModelCatalogService();

  beforeAll(async () => {
    infra = await startInfra({ postgres: true, redis: false });
    initDatabase(await prepareDatabase(infra));
    await seedDatabase(infra);
    owner = new pg.Pool({ connectionString: infra.databaseMigrationUrl, max: 1 });
  });

  afterAll(async () => {
    await owner?.end();
    await closeDatabase();
    await infra?.stop();
  });

  it('listModels trả bốn model đã seed kèm giá, đọc được bằng role app_user', async () => {
    const models = await catalog.listModels();
    expect(models.map((m) => m.modelId).sort()).toEqual([
      'claude-fable-5-1',
      'claude-haiku-5-5',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
    ]);
    for (const m of models) {
      expect(m.inputPerMtok).toBeGreaterThan(0);
      expect(m.outputPerMtok).toBeGreaterThan(m.inputPerMtok);
      expect(m.cacheReadPerMtok).toBeLessThan(m.inputPerMtok);
    }
  });

  it('hasModel đúng với model có trong danh mục và sai với model lạ', async () => {
    expect(await catalog.hasModel('claude-opus-5-5')).toBe(true);
    expect(await catalog.hasModel('gpt-khong-co')).toBe(false);
  });

  it('seed chạy lại không tạo trùng (idempotent)', async () => {
    await seedDatabase(infra);
    const { rows } = await owner.query('select count(*)::int as n from model_price');
    expect(rows[0].n).toBe(4);
  });

  it('dùng dòng giá hiệu lực mới nhất; dòng có hiệu lực trong tương lai chưa áp dụng', async () => {
    await owner.query(
      `insert into model_price(id, model_id, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, effective_from)
       values (gen_random_uuid(), 'claude-opus-5-5', 9, 45, 0.9, 11, now() - interval '1 minute'),
              (gen_random_uuid(), 'claude-opus-5-5', 99, 99, 9, 9, now() + interval '30 days')`,
    );
    const opus = (await catalog.listModels()).find((m) => m.modelId === 'claude-opus-5-5');
    expect(opus).toMatchObject({ inputPerMtok: 9, outputPerMtok: 45 });
  });
});
