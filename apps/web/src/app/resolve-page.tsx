import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { t } from '../i18n';

type Loader = () => Promise<{ default: ComponentType }>;

// Nạp lười mọi *Page.tsx; thêm file mới là tự có route, không phải sửa router.
const pages = import.meta.glob<{ default: ComponentType }>('../{features,office}/**/*Page.tsx');

export function NotImplementedPage() {
  return (
    <section className="empty">
      <h2>{t('app.notImplemented')}</h2>
      <p>{t('app.notImplementedHint')}</p>
    </section>
  );
}

const cache = new Map<string, LazyExoticComponent<ComponentType>>();

/** Tìm component cho `module` (đường dẫn dưới src/, không đuôi); thiếu file thì trả trang "Chưa triển khai". */
export function resolvePage(module: string): LazyExoticComponent<ComponentType> {
  const hit = cache.get(module);
  if (hit) return hit;
  const loader: Loader | undefined = pages[`../${module}.tsx`];
  const component = lazy(loader ?? (async () => ({ default: NotImplementedPage })));
  cache.set(module, component);
  return component;
}
