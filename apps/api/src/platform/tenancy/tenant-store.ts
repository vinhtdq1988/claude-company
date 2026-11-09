import { AsyncLocalStorage } from 'node:async_hooks';
import { withTenant, type Tx } from '@claude-company/db';

type TenantStore = { companyId: string; tx: Tx };

const als = new AsyncLocalStorage<TenantStore>();

/** Chạy `fn` với transaction tenant của request hiện tại có thể truy cập qua `currentTenantTx()`. */
export function runWithTenantTx<T>(companyId: string, tx: Tx, fn: () => Promise<T>): Promise<T> {
  return als.run({ companyId, tx }, fn);
}

export function currentTenantTx(companyId?: string): Tx | undefined {
  const store = als.getStore();
  if (!store) return undefined;
  return companyId === undefined || store.companyId === companyId ? store.tx : undefined;
}

/**
 * Engine dùng hàm này để truy vấn dưới RLS: tái sử dụng transaction của request nếu cùng company
 * (để thay đổi nghiệp vụ và domain_event cùng commit), ngược lại mở `withTenant` mới (worker, sweeper).
 */
export async function inTenant<T>(
  ctx: { companyId: string },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const existing = currentTenantTx(ctx.companyId);
  if (existing) return fn(existing);
  return withTenant(ctx.companyId, fn);
}
