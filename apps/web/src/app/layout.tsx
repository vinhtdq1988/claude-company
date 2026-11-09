import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router';
import { describeError, t } from '../i18n';
import { api } from '../lib/api';
import { meQuery, queryClient, queryKeys } from '../lib/query';
import { realtime, type ConnectionStatus } from '../realtime/socket';
import { COMPANY_SCREENS } from './screens';

/** Hiển thị trạng thái kết nối realtime; "Trạng thái có thể đã cũ" khi mất đồng bộ (FR-037). */
function ConnectionBanner() {
  const [status, setStatus] = useState<ConnectionStatus>(realtime.connectionStatus);
  useEffect(() => realtime.onStatus(setStatus), []);
  if (status === 'stale')
    return (
      <div role="status" className="banner banner-warn">
        {t('realtime.stale')}
      </div>
    );
  if (status === 'connecting')
    return (
      <div role="status" className="banner">
        {t('realtime.reconnecting')}
      </div>
    );
  return null;
}

export function Layout() {
  const { companyId } = useParams();
  const navigate = useNavigate();
  const { data: me } = useQuery(meQuery);

  // Kết nối realtime theo công ty đang xem; màn hình cần snapshot gọi `realtime.connect` lại với seq của nó.
  useEffect(() => {
    if (!companyId || !me?.memberships.some((m) => m.companyId === companyId)) return;
    realtime.connect(companyId);
    return () => realtime.disconnect();
  }, [companyId, me]);

  const logout = useMutation({
    mutationFn: () => api.post<void>('/auth/logout'),
    onSettled: () => {
      api.setCsrfToken(null);
      queryClient.clear();
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      navigate('/login', { replace: true });
    },
  });

  return (
    <div className="shell">
      <header className="topbar">
        <strong>{t('app.name')}</strong>
        <span className="spacer" />
        <span>{me?.user.displayName}</span>
        <button type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>
          {t('app.logout')}
        </button>
      </header>
      {companyId && (
        <nav className="nav" aria-label="Điều hướng">
          {COMPANY_SCREENS.map((s) => (
            <NavLink key={s.path} to={`/c/${companyId}/${s.path}`}>
              {t(s.labelKey)}
            </NavLink>
          ))}
        </nav>
      )}
      <ConnectionBanner />
      {logout.isError && (
        <div role="alert" className="banner banner-error">
          {describeError(logout.error)}
        </div>
      )}
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
