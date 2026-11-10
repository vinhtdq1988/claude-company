import { Link } from 'react-router';
import type { OfficeEmployee } from '@claude-company/contracts';
import { describeError, t, type MessageKey } from '../i18n';
import { useProfileView } from './office-queries';

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
const formatNumber = (n: number) => n.toLocaleString('vi-VN');
const formatCost = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });

export const stateLabel = (state: OfficeEmployee['state']) =>
  t(`office.state.${state}` as MessageKey);

/**
 * Employee Profile (T163, FR-038). Phần đầu (tên, trạng thái, task, tiến độ) lấy ngay từ snapshot/store nên hiện tức
 * thì; phần còn lại tải từ `profile-view`. Mọi nội dung do AI sinh ra (tin nhắn, tiêu đề, lý do) là VĂN BẢN THUẦN:
 * React escape khi render, không dùng `dangerouslySetInnerHTML`.
 */
export function EmployeeProfilePanel({
  companyId,
  employee,
  onClose,
}: {
  companyId: string;
  /** Nhân viên theo store thời gian thực (nguồn trạng thái duy nhất). */
  employee: OfficeEmployee;
  onClose: () => void;
}) {
  const { data, isPending, error } = useProfileView(companyId, employee.id);

  return (
    <aside
      className="card profile-panel"
      aria-label={t('office.profile.title')}
      data-employee-id={employee.id}
    >
      <header className="page-header-row">
        <h2>{employee.name}</h2>
        <button type="button" onClick={onClose}>
          {t('office.profile.close')}
        </button>
      </header>

      <dl className="task-facts">
        <dt>{t('office.profile.status')}</dt>
        <dd data-testid="profile-state" data-state={employee.state}>
          <span className="badge">{stateLabel(employee.state)}</span>
          {data?.status.sourceEventSeq ? (
            <small className="muted">
              {' '}
              {t('office.profile.statusSource')}
              {data.status.sourceEventSeq}
            </small>
          ) : null}
        </dd>
        <dt>{t('office.profile.currentTask')}</dt>
        <dd data-testid="profile-task">
          {employee.currentTaskId ? (
            <>
              {data?.currentTask ? (
                <Link to={`/c/${companyId}/tasks?id=${data.currentTask.id}`}>
                  {data.currentTask.title}
                </Link>
              ) : (
                employee.currentTaskId
              )}
              {employee.progress !== null && (
                <progress
                  value={employee.progress}
                  max={100}
                  aria-label={t('office.profile.progress')}
                />
              )}
              {employee.progress !== null && <span> {Math.round(employee.progress)}%</span>}
            </>
          ) : (
            t('office.profile.noTask')
          )}
        </dd>
        <dt>{t('office.profile.currentTool')}</dt>
        <dd data-testid="profile-tool">{employee.currentTool ?? '—'}</dd>
      </dl>

      {isPending && <p className="loading">{t('office.profile.loading')}</p>}
      {error && (
        <p role="alert" className="banner banner-error">
          {t('office.profile.error')} {describeError(error)}
        </p>
      )}

      {data && (
        <>
          <p className="muted">
            {data.employee.position} · {t('office.profile.position')}
          </p>

          <section>
            <h3>{t('office.profile.messages')}</h3>
            {data.recentMessages.length === 0 ? (
              <p className="muted">{t('office.profile.none')}</p>
            ) : (
              <ul className="plain-list">
                {data.recentMessages.map((m) => (
                  <li key={m.id}>
                    <small className="muted">
                      {formatTime(m.createdAt)} · {m.taskTitle}
                    </small>
                    <div className="prewrap">{m.body}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3>{t('office.profile.results')}</h3>
            {data.latestResults.length === 0 ? (
              <p className="muted">{t('office.profile.none')}</p>
            ) : (
              <ul className="plain-list">
                {data.latestResults.map((r) => (
                  <li key={r.artifactId}>
                    <Link to={`/c/${companyId}/tasks?id=${r.taskId}`}>{r.title}</Link>
                    <small className="muted">
                      {' '}
                      · {r.taskTitle} · {formatTime(r.createdAt)}
                    </small>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3>{t('office.profile.reviews')}</h3>
            {data.reviewHistory.length === 0 ? (
              <p className="muted">{t('office.profile.none')}</p>
            ) : (
              <ul className="plain-list">
                {data.reviewHistory.map((r) => (
                  <li key={r.id}>
                    <strong>{t(`office.profile.review.${r.stage}` as MessageKey)}</strong>:{' '}
                    {r.decision} · {r.taskTitle}
                    <div className="prewrap">{r.reason}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3>{t('office.profile.usage')}</h3>
            <dl className="task-facts">
              <dt>{t('office.profile.usageMonth')}</dt>
              <dd>
                {formatNumber(data.usage.month.tokens)} {t('office.profile.tokens')} ·{' '}
                {formatCost(data.usage.month.costUsd)}
              </dd>
              <dt>{t('office.profile.usageTotal')}</dt>
              <dd>
                {formatNumber(data.usage.total.tokens)} {t('office.profile.tokens')} ·{' '}
                {formatCost(data.usage.total.costUsd)}
              </dd>
            </dl>
          </section>

          <section>
            <h3>{t('office.profile.blockers')}</h3>
            {data.blockers.length === 0 ? (
              <p className="muted">{t('office.profile.none')}</p>
            ) : (
              <ul className="plain-list" data-testid="profile-blockers">
                {data.blockers.map((b) => (
                  <li key={`${b.kind}-${b.taskId}`}>
                    <strong>{t(`office.profile.blocker.${b.kind}` as MessageKey)}</strong>:{' '}
                    <Link to={`/c/${companyId}/tasks?id=${b.taskId}`}>{b.taskTitle}</Link>
                    <div className="prewrap muted">{b.reason}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </aside>
  );
}
