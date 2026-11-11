import { useState } from 'react';
import type { OrgChart, Task, TaskPriority, TaskStatus } from '@claude-company/contracts';
import { ErrorNotice } from '../../components/ErrorNotice';
import { t } from '../../i18n';
import { useEmployees } from '../employees/employee-queries';
import { useOrgChart } from '../org/org-queries';
import { findUnit, flattenUnits } from '../org/org-tree';
import { BOARD_COLUMNS, PRIORITIES, groupByStatus, progressOf } from './task-model';
import { useTaskRealtime, useTasks, type TaskBoardFilter } from './task-queries';

type Props = {
  companyId: string;
  onOpen: (id: string) => void;
  onNew: () => void;
};

const formatDeadline = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

/** Tên người nhận và department của task, tra qua danh sách nhân viên và sơ đồ tổ chức. */
export function useAssigneeLookup(companyId: string) {
  const employees = useEmployees(companyId);
  const chart = useOrgChart(companyId);
  const units = flattenUnits(chart.data?.roots ?? []);
  const unitName = (id: string | null, tree?: OrgChart) =>
    (tree && id ? findUnit(tree, id)?.name : undefined) ?? '—';
  return (task: Pick<Task, 'assigneeKind' | 'assigneeId'>): { assignee: string; unit: string } => {
    if (task.assigneeKind === 'ai_employee') {
      const employee = employees.data?.find((e) => e.id === task.assigneeId);
      return {
        assignee: employee?.name ?? '—',
        unit: employee ? unitName(employee.homeOrgUnitId, chart.data) : '—',
      };
    }
    if (task.assigneeKind === 'team') {
      const owner = units.find((u) => u.teams.some((team) => team.id === task.assigneeId));
      const team = owner?.teams.find((x) => x.id === task.assigneeId);
      return { assignee: team?.name ?? '—', unit: owner?.name ?? '—' };
    }
    const name = unitName(task.assigneeId, chart.data);
    return { assignee: name, unit: name };
  };
}

/**
 * Task Board — màn hình chính của Task Center (FR-021): task theo trạng thái với tiến độ, mức ưu tiên, hạn chót,
 * người nhận, department và bộ lọc. Cập nhật theo sự kiện realtime.
 */
export function TaskBoardPage({ companyId, onOpen, onNew }: Props) {
  const [status, setStatus] = useState<TaskStatus | ''>('');
  const [orgUnitId, setOrgUnitId] = useState('');
  const [priority, setPriority] = useState<TaskPriority | ''>('');
  const [assigneeId, setAssigneeId] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [deadlineBefore, setDeadlineBefore] = useState('');
  const [showCancelled, setShowCancelled] = useState(false);

  const filter: TaskBoardFilter = {
    status: status || undefined,
    orgUnitId: orgUnitId || undefined,
    priority: priority || undefined,
    ...(assigneeId ? { assigneeKind: 'ai_employee' as const, assigneeId } : {}),
    overdue: overdue || undefined,
    deadlineBefore: deadlineBefore
      ? new Date(`${deadlineBefore}T23:59:59`).toISOString()
      : undefined,
  };
  const tasks = useTasks(companyId, filter);
  const employees = useEmployees(companyId);
  const chart = useOrgChart(companyId);
  const live = useTaskRealtime(companyId);
  const describe = useAssigneeLookup(companyId);

  const departments = flattenUnits(chart.data?.roots ?? []).filter((u) => u.kind === 'department');
  const columns = groupByStatus(tasks.data ?? [], showCancelled || status === 'cancelled');

  return (
    <section className="tasks">
      <header className="page-header page-header-row">
        <h2>{t('tasks.title')}</h2>
        <button type="button" onClick={onNew}>
          {t('tasks.new')}
        </button>
      </header>

      <form
        className="filters"
        aria-label={t('tasks.filter.title')}
        onSubmit={(e) => e.preventDefault()}
      >
        <label>
          {t('tasks.filter.status')}
          <select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus | '')}>
            <option value="">{t('tasks.filter.all')}</option>
            {BOARD_COLUMNS.map((s) => (
              <option key={s} value={s}>
                {t(`tasks.status.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('tasks.filter.unit')}
          <select value={orgUnitId} onChange={(e) => setOrgUnitId(e.target.value)}>
            <option value="">{t('tasks.filter.all')}</option>
            {departments.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('tasks.filter.priority')}
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as TaskPriority | '')}
          >
            <option value="">{t('tasks.filter.all')}</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t(`tasks.priority.${p}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('tasks.filter.assignee')}
          <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">{t('tasks.filter.all')}</option>
            {(employees.data ?? [])
              .filter((e) => e.status !== 'archived')
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          {t('tasks.filter.deadlineBefore')}
          <input
            type="date"
            value={deadlineBefore}
            onChange={(e) => setDeadlineBefore(e.target.value)}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} />
          {t('tasks.filter.overdue')}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={showCancelled}
            onChange={(e) => setShowCancelled(e.target.checked)}
          />
          {t('tasks.filter.showCancelled')}
        </label>
      </form>

      {tasks.isPending && <p className="loading">{t('app.loading')}</p>}
      {tasks.isError && <ErrorNotice error={tasks.error} />}
      {tasks.isSuccess && tasks.data.length === 0 && <p className="empty">{t('tasks.empty')}</p>}

      {tasks.isSuccess && tasks.data.length > 0 && (
        <div className="board" role="group" aria-label={t('tasks.board.label')}>
          {columns.map(([columnStatus, items]) => (
            <section
              key={columnStatus}
              className={`board-col board-col-${columnStatus}`}
              aria-label={t(`tasks.status.${columnStatus}`)}
            >
              <h3>
                {t(`tasks.status.${columnStatus}`)} <span className="badge">{items.length}</span>
              </h3>
              {items.length === 0 && <p className="muted">{t('tasks.board.columnEmpty')}</p>}
              <ul className="board-list">
                {items.map((task) => {
                  const who = describe(task);
                  const progress = progressOf(task, live[task.id]);
                  return (
                    <li key={task.id} className="task-card">
                      <button
                        type="button"
                        className="link task-title"
                        onClick={() => onOpen(task.id)}
                      >
                        {task.title}
                      </button>
                      <div className="task-meta">
                        <span className={`badge priority-${task.priority}`}>
                          {t(`tasks.priority.${task.priority}`)}
                        </span>
                        {task.isOverdue && (
                          <span className="badge badge-danger">{t('tasks.card.overdue')}</span>
                        )}
                        {task.assignedByEmployee && (
                          <span className="badge">{t('assistant.createdBy')}</span>
                        )}
                      </div>
                      <dl className="task-facts">
                        <dt>{t('tasks.card.deadline')}</dt>
                        <dd>{formatDeadline(task.deadline)}</dd>
                        <dt>{t('tasks.card.assignee')}</dt>
                        <dd>
                          {who.assignee} ({t(`tasks.assigneeKind.${task.assigneeKind}`)})
                        </dd>
                        <dt>{t('tasks.card.unit')}</dt>
                        <dd>{who.unit}</dd>
                      </dl>
                      <progress
                        max={100}
                        value={progress}
                        aria-label={`${t('tasks.card.progress')} ${progress}%`}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
