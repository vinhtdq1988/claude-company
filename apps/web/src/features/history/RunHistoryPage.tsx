import { useMemo } from 'react';
import type { AgentRunSummary } from '@claude-company/contracts';
import { describeError, t } from '../../i18n';
import { useEmployees } from '../employees/employee-queries';
import { useTasks } from '../tasks/task-queries';
import {
  PURPOSE_LABEL_KEYS,
  RUN_STATUS_LABEL_KEYS,
  failureOf,
  formatDuration,
  sortRuns,
} from './history-model';
import { useRunRealtime, useRuns } from './history-queries';

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

/** Run lỗi có huy hiệu đỏ để lỗi nổi bật ngay ở danh sách (SC-011). */
export const statusBadgeClass = (run: Pick<AgentRunSummary, 'status' | 'errorCode'>) =>
  failureOf({ ...run, errorMessage: null }) ? 'badge badge-danger' : 'badge';

type Props = {
  companyId: string;
  taskId: string | null;
  employeeId: string | null;
  onFilter: (filter: { task?: string; employee?: string }) => void;
  onOpen: (runId: string) => void;
};

/** Danh sách lịch sử thực thi (US7), lọc theo task hoặc nhân viên; server chỉ trả run trong phạm vi người xem. */
export function RunHistoryPage({ companyId, taskId, employeeId, onFilter, onOpen }: Props) {
  useRunRealtime(companyId);
  const runs = useRuns(companyId, {
    taskId: taskId ?? undefined,
    employeeId: employeeId ?? undefined,
  });
  const employees = useEmployees(companyId);
  const tasks = useTasks(companyId);

  const employeeName = useMemo(
    () => new Map((employees.data ?? []).map((e) => [e.id, e.name])),
    [employees.data],
  );
  const taskTitle = useMemo(
    () => new Map((tasks.data ?? []).map((task) => [task.id, task.title])),
    [tasks.data],
  );
  const items = sortRuns(runs.data?.items ?? []);

  return (
    <section>
      <header className="page-header-row">
        <h2>{t('history.title')}</h2>
      </header>

      <form
        className="filters"
        aria-label={t('history.filter')}
        onSubmit={(event) => event.preventDefault()}
      >
        <label>
          {t('history.filter.employee')}
          <select
            name="employee"
            value={employeeId ?? ''}
            onChange={(event) =>
              onFilter({
                task: taskId ?? undefined,
                employee: event.target.value || undefined,
              })
            }
          >
            <option value="">{t('history.filter.all')}</option>
            {(employees.data ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        {taskId && (
          <p className="muted">
            {t('history.filter.task')}: {taskTitle.get(taskId) ?? taskId}{' '}
            <button type="button" onClick={() => onFilter({ employee: employeeId ?? undefined })}>
              {t('history.filter.clear')}
            </button>
          </p>
        )}
      </form>

      {runs.isPending && <p className="loading">{t('app.loading')}</p>}
      {runs.isError && (
        <p role="alert" className="error">
          {describeError(runs.error)}
        </p>
      )}
      {runs.isSuccess && items.length === 0 && <p className="muted">{t('history.empty')}</p>}
      {items.length > 0 && (
        <table className="data-table" aria-label={t('history.title')}>
          <thead>
            <tr>
              <th>{t('history.col.time')}</th>
              <th>{t('history.col.task')}</th>
              <th>{t('history.col.employee')}</th>
              <th>{t('history.col.purpose')}</th>
              <th>{t('history.col.attempt')}</th>
              <th>{t('history.col.status')}</th>
              <th>{t('history.col.duration')}</th>
              <th>{t('history.col.error')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((run) => {
              const failure = failureOf(run);
              return (
                <tr key={run.id} data-run-id={run.id} data-status={run.status}>
                  <td>
                    <button type="button" className="link" onClick={() => onOpen(run.id)}>
                      <time dateTime={run.createdAt}>{formatTime(run.createdAt)}</time>
                    </button>
                  </td>
                  <td>{taskTitle.get(run.taskId) ?? run.taskId}</td>
                  <td>{employeeName.get(run.employeeId) ?? run.employeeId}</td>
                  <td>{t(PURPOSE_LABEL_KEYS[run.purpose])}</td>
                  <td>{run.attempt}</td>
                  <td>
                    <span className={statusBadgeClass(run)}>
                      {t(RUN_STATUS_LABEL_KEYS[run.status])}
                    </span>
                  </td>
                  <td>{formatDuration(run.startedAt, run.finishedAt) ?? '—'}</td>
                  <td>{failure ? <code>{failure.code}</code> : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
