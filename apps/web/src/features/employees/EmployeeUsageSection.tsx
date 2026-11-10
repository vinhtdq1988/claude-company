import { Link } from 'react-router';
import { t } from '../../i18n';
import { formatTokens, formatUsd } from '../budget/budget-model';
import { useUsage } from '../budget/budget-queries';
import { useTasks } from '../tasks/task-queries';

/**
 * Token và chi phí của một AI Employee (US6-AS4): tháng này, tổng mọi kỳ và chi tiết theo task. Số liệu lấy từ cùng
 * `usage_ledger` với Dashboard nên tổng theo task khớp tổng của nhân viên.
 */
export function EmployeeUsageSection({
  companyId,
  employeeId,
}: {
  companyId: string;
  employeeId: string;
}) {
  const month = useUsage(companyId, { employeeId });
  const total = useUsage(companyId, { employeeId, period: 'all' });
  const byTask = useUsage(companyId, { employeeId, period: 'all', groupBy: 'task' });
  const tasks = useTasks(companyId, {});
  const titles = new Map((tasks.data ?? []).map((task) => [task.id, task.title]));

  return (
    <section data-testid="employee-usage">
      <h3>{t('employee.usage.title')}</h3>
      <dl className="task-facts">
        <dt>
          {t('employee.usage.month')}
          {month.data ? ` (${month.data.period})` : ''}
        </dt>
        <dd data-testid="usage-month">
          {month.data
            ? `${formatTokens(month.data.tokens)} token · ${formatUsd(month.data.costUsd)}`
            : '—'}
        </dd>
        <dt>{t('employee.usage.total')}</dt>
        <dd data-testid="usage-total">
          {total.data
            ? `${formatTokens(total.data.tokens)} token · ${formatUsd(total.data.costUsd)}`
            : '—'}
        </dd>
      </dl>
      <h4>{t('employee.usage.byTask')}</h4>
      {byTask.data && byTask.data.groups.length === 0 ? (
        <p>{t('employee.usage.none')}</p>
      ) : (
        <table className="usage-table">
          <thead>
            <tr>
              <th>{t('employee.usage.task')}</th>
              <th>token</th>
              <th>USD</th>
            </tr>
          </thead>
          <tbody>
            {(byTask.data?.groups ?? []).map((g) => (
              <tr key={g.key}>
                <td>
                  <Link to={`../tasks?id=${g.key}`}>{titles.get(g.key) ?? g.key}</Link>
                </td>
                <td>{formatTokens(g.tokens)}</td>
                <td>{formatUsd(g.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
