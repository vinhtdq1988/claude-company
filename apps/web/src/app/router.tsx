import { Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, Outlet, useParams, type RouteObject } from 'react-router';
import { t } from '../i18n';
import { meQuery } from '../lib/query';
import { Layout } from './layout';
import { resolvePage } from './resolve-page';
import { COMPANY_SCREENS, LOGIN_SCREEN, ONBOARDING_SCREEN, REGISTER_SCREEN } from './screens';

function Loading() {
  return <p className="loading">{t('app.loading')}</p>;
}

function PageOutlet({ module }: { module: string }) {
  const Page = resolvePage(module);
  return (
    <Suspense fallback={<Loading />}>
      <Page />
    </Suspense>
  );
}

/** Route cần đăng nhập: chưa có phiên thì chuyển tới /login. */
function RequireAuth() {
  const { data: me, isPending } = useQuery(meQuery);
  if (isPending) return <Loading />;
  if (!me) return <Navigate to={`/${LOGIN_SCREEN.path}`} replace />;
  return <Outlet />;
}

/** Route /c/:companyId/*: chỉ truy cập được khi là thành viên (server vẫn kiểm tra lại bằng 404). */
function RequireMembership() {
  const { companyId } = useParams();
  const { data: me } = useQuery(meQuery);
  if (!me?.memberships.some((m) => m.companyId === companyId)) {
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
}

/** Trang gốc: vào công ty đầu tiên, hoặc onboarding nếu chưa có công ty. */
function Home() {
  const { data: me } = useQuery(meQuery);
  const first = me?.memberships[0];
  return (
    <Navigate to={first ? `/c/${first.companyId}/org` : `/${ONBOARDING_SCREEN.path}`} replace />
  );
}

export const routes: RouteObject[] = [
  { path: LOGIN_SCREEN.path, element: <PageOutlet module={LOGIN_SCREEN.module} /> },
  { path: REGISTER_SCREEN.path, element: <PageOutlet module={REGISTER_SCREEN.module} /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <Home /> },
          {
            path: ONBOARDING_SCREEN.path,
            element: <PageOutlet module={ONBOARDING_SCREEN.module} />,
          },
          {
            path: 'c/:companyId',
            element: <RequireMembership />,
            children: COMPANY_SCREENS.map((s) => ({
              path: s.path,
              element: <PageOutlet module={s.module} />,
            })),
          },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
];

export const router = createBrowserRouter(routes);
