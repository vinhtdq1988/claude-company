import { Link } from 'react-router';
import { describeError, t } from '../../i18n';
import { formatPayload } from '../approvals/approval-model';
import { useEmployees } from '../employees/employee-queries';
import {
  INVOCATION_STATUS_LABEL_KEYS,
  PURPOSE_LABEL_KEYS,
  RUN_STATUS_LABEL_KEYS,
  STEP_KIND_LABEL_KEYS,
  failureOf,
  formatCost,
  formatDuration,
} from './history-model';
import { useRun, useRunRealtime } from './history-queries';
import { formatTime, statusBadgeClass } from './RunHistoryPage';

type Props = { companyId: string; runId: string; onBack: () => void };

/**
 * Chi tiết một run: nguyên nhân lỗi nổi bật ở đầu trang (SC-011), rồi các bước, lời gọi tool kèm mức quyền và kết
 * quả, thời gian và chi phí. Mọi nội dung do AI hoặc tool sinh ra hiển thị như VĂN BẢN THUẦN (`<pre>`), không render HTML.
 */
export function RunDetailPage({ companyId, runId, onBack }: Props) {
  useRunRealtime(companyId);
  const run = useRun(companyId, runId);
  const employees = useEmployees(companyId);

  if (run.isPending) return <p className="loading">{t('app.loading')}</p>;
  if (run.isError) {
    return (
      <section>
        <button type="button" onClick={onBack}>
          {t('history.back')}
        </button>
        <p role="alert" className="error">
          {describeError(run.error)}
        </p>
      </section>
    );
  }

  const data = run.data;
  const failure = failureOf(data);
  const employee = employees.data?.find((e) => e.id === data.employeeId);

  return (
    <section data-run-id={data.id} data-status={data.status}>
      <header className="page-header-row">
        <button type="button" onClick={onBack}>
          {t('history.back')}
        </button>
        <h2>{t('history.detail.title')}</h2>
        <span className={statusBadgeClass(data)}>{t(RUN_STATUS_LABEL_KEYS[data.status])}</span>
      </header>

      {failure && (
        <div role="alert" className="banner banner-error run-failure" data-testid="run-failure">
          <strong>{t('history.failure.title')}</strong>
          <p>
            <code>{failure.code}</code>{' '}
            {failure.messageKey ? t(failure.messageKey) : failure.fallback}
          </p>
          {failure.detail && <pre className="artifact-content">{failure.detail}</pre>}
        </div>
      )}

      <dl className="task-facts">
        <dt>{t('history.col.task')}</dt>
        <dd>
          <Link to={`/c/${companyId}/tasks?id=${data.taskId}`}>{t('history.openTask')}</Link>
        </dd>
        <dt>{t('history.col.employee')}</dt>
        <dd>{employee?.name ?? data.employeeId}</dd>
        <dt>{t('history.col.purpose')}</dt>
        <dd>{t(PURPOSE_LABEL_KEYS[data.purpose])}</dd>
        <dt>{t('history.col.attempt')}</dt>
        <dd>{data.attempt}</dd>
        <dt>{t('history.field.model')}</dt>
        <dd>
          {data.modelId} <span className="muted">({data.runtimeKind})</span>
        </dd>
        <dt>{t('history.field.startedAt')}</dt>
        <dd>{data.startedAt ? formatTime(data.startedAt) : '—'}</dd>
        <dt>{t('history.field.finishedAt')}</dt>
        <dd>{data.finishedAt ? formatTime(data.finishedAt) : '—'}</dd>
        <dt>{t('history.col.duration')}</dt>
        <dd>{formatDuration(data.startedAt, data.finishedAt) ?? '—'}</dd>
        <dt>{t('history.field.tokens')}</dt>
        <dd>{data.usage.tokens.toLocaleString('vi-VN')}</dd>
        <dt>{t('history.field.cost')}</dt>
        <dd>{formatCost(data.usage.costUsd)}</dd>
        <dt>{t('history.field.trace')}</dt>
        <dd>
          <code>{data.traceId}</code>
        </dd>
      </dl>

      <h3>{t('history.steps')}</h3>
      {data.steps.length === 0 ? (
        <p className="muted">{t('history.steps.none')}</p>
      ) : (
        <ol className="run-steps">
          {data.steps.map((step) => (
            <li key={step.id} data-kind={step.kind}>
              <span className="badge badge-team">{t(STEP_KIND_LABEL_KEYS[step.kind])}</span>{' '}
              <span className="prewrap">{step.summary}</span>{' '}
              <time className="muted" dateTime={step.startedAt}>
                {formatTime(step.startedAt)}
              </time>
              {step.payload !== null && step.payload !== undefined && (
                <details>
                  <summary>{t('history.payload')}</summary>
                  <pre className="artifact-content">{formatPayload(step.payload)}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}

      <h3>{t('history.tools')}</h3>
      {data.toolInvocations.length === 0 ? (
        <p className="muted">{t('history.tools.none')}</p>
      ) : (
        <table className="data-table" aria-label={t('history.tools')}>
          <thead>
            <tr>
              <th>{t('history.tools.action')}</th>
              <th>{t('history.tools.level')}</th>
              <th>{t('history.col.status')}</th>
              <th>{t('history.tools.mode')}</th>
              <th>{t('history.tools.result')}</th>
            </tr>
          </thead>
          <tbody>
            {data.toolInvocations.map((inv) => (
              <tr key={inv.id} data-status={inv.status}>
                <td>
                  <code>{inv.actionType}</code>
                </td>
                <td>{inv.permissionLevel}</td>
                <td>
                  <span
                    className={
                      inv.status === 'failed' || inv.status === 'denied' || inv.status === 'unknown'
                        ? 'badge badge-danger'
                        : 'badge'
                    }
                  >
                    {t(INVOCATION_STATUS_LABEL_KEYS[inv.status])}
                  </span>
                </td>
                <td>{inv.adapterMode ?? '—'}</td>
                <td>
                  <details>
                    <summary>{t('history.payload')}</summary>
                    <pre className="artifact-content">
                      {formatPayload({ input: inv.input, result: inv.result })}
                    </pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
