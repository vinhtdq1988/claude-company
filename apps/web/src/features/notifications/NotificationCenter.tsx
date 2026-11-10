import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { Notification, Page } from '@claude-company/contracts';
import { describeError, t } from '../../i18n';
import { api } from '../../lib/api';
import { queryClient, queryKeys } from '../../lib/query';
import { realtime } from '../../realtime/socket';

/** Màn hình đích của thông báo: task hoặc hộp phê duyệt (US4). */
export function notificationTarget(
  companyId: string,
  n: Pick<Notification, 'taskId' | 'approvalRequestId'>,
): string | null {
  if (n.approvalRequestId) return `/c/${companyId}/approvals`;
  if (n.taskId) return `/c/${companyId}/tasks?id=${n.taskId}`;
  return null;
}

const fetchNotifications = (companyId: string) =>
  api.get<Page<Notification>>(`/companies/${companyId}/notifications`, { query: { limit: 50 } });

/**
 * Chuông và hộp thông báo đã đọc/chưa đọc (FR-041), nhận realtime qua `notification.created`. Thông báo chỉ
 * in-app; mất kết nối realtime thì lần mở hộp kế tiếp vẫn tải lại từ REST nên không mất thông báo.
 */
export function NotificationCenter({ companyId }: { companyId: string }) {
  const [open, setOpen] = useState(false);
  const key = queryKeys.notifications(companyId);
  const list = useQuery({
    queryKey: key,
    queryFn: () => fetchNotifications(companyId),
    refetchInterval: 60_000,
  });

  useEffect(
    () =>
      realtime.onEnvelope((envelope) => {
        if (envelope.type === 'notification.created') {
          void queryClient.invalidateQueries({ queryKey: queryKeys.notifications(companyId) });
        }
      }),
    [companyId],
  );

  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const readOne = useMutation({
    mutationFn: (id: string) => api.post<void>(`/companies/${companyId}/notifications/${id}/read`),
    onSuccess: refresh,
  });
  const readAll = useMutation({
    mutationFn: () =>
      api.post<{ updated: number }>(`/companies/${companyId}/notifications/read-all`),
    onSuccess: refresh,
  });

  const items = list.data?.items ?? [];
  const unread = items.filter((n) => n.readAt === null).length;

  return (
    <div className="notifications">
      <button
        type="button"
        className="bell"
        aria-expanded={open}
        aria-controls="notification-panel"
        aria-label={`${t('notifications.open')}${unread > 0 ? ` (${unread} ${t('notifications.unread')})` : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">🔔</span>
        {unread > 0 && (
          <span className="badge badge-danger" data-testid="unread-count">
            {unread}
          </span>
        )}
      </button>
      {open && (
        <section
          id="notification-panel"
          className="notification-panel"
          aria-label={t('notifications.title')}
        >
          <header className="page-header-row">
            <h3>{t('notifications.title')}</h3>
            <button
              type="button"
              className="secondary"
              disabled={unread === 0 || readAll.isPending}
              onClick={() => readAll.mutate()}
            >
              {t('notifications.readAll')}
            </button>
          </header>
          {list.isError && (
            <p role="alert" className="error">
              {describeError(list.error)}
            </p>
          )}
          {list.isSuccess && items.length === 0 && (
            <p className="muted">{t('notifications.empty')}</p>
          )}
          <ul>
            {items.map((n) => {
              const target = notificationTarget(companyId, n);
              return (
                <li
                  key={n.id}
                  className={n.readAt === null ? 'notification unread' : 'notification'}
                >
                  <span className="badge">{t(`notifications.type.${n.type}`)}</span>{' '}
                  {target ? (
                    <Link
                      to={target}
                      onClick={() => {
                        setOpen(false);
                        if (n.readAt === null) readOne.mutate(n.id);
                      }}
                    >
                      {n.title}
                    </Link>
                  ) : (
                    <span>{n.title}</span>
                  )}
                  {n.body && <p className="muted prewrap">{n.body}</p>}
                  <time dateTime={n.createdAt} className="muted">
                    {new Date(n.createdAt).toLocaleString('vi-VN', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </time>
                  {n.readAt === null && (
                    <button type="button" className="link" onClick={() => readOne.mutate(n.id)}>
                      {t('notifications.markRead')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
