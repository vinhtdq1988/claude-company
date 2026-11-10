import { useState } from 'react';
import { useParams } from 'react-router';
import { ErrorNotice } from '../../components/ErrorNotice';
import { t } from '../../i18n';
import { formatRate, formatTokens, formatUsd } from '../budget/budget-model';
import { useDashboard } from '../budget/budget-queries';
import { useOrgChart } from '../org/org-queries';
import { flattenUnits } from '../org/org-tree';

/** Company Dashboard (FR-040): số liệu do server tổng hợp trong phạm vi người xem, lọc được theo phòng ban. */
export default function DashboardPage() {
  const { companyId = '' } = useParams();
  const [orgUnitId, setOrgUnitId] = useState('');
  const chart = useOrgChart(companyId);
  const dashboard = useDashboard(companyId, orgUnitId || undefined);
  const units = flattenUnits(chart.data?.roots ?? []);

  const d = dashboard.data;
  const rate = d ? formatRate(d.onTimeCompletionRate) : null;

  return (
    <section className="dashboard">
      <header className="page-header">
        <h2>{t('dashboard.title')}</h2>
      </header>
      <div className="filters">
        <label>
          {t('dashboard.filter.unit')}
          <select value={orgUnitId} onChange={(e) => setOrgUnitId(e.target.value)}>
            <option value="">{t('dashboard.filter.all')}</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {dashboard.isPending && <p className="loading">{t('app.loading')}</p>}
      {dashboard.isError && <ErrorNotice error={dashboard.error} />}
      {d && (
        <>
          <ul className="stat-grid" data-testid="dashboard-stats">
            <li className="stat" data-testid="stat-totalEmployees">
              <span className="stat-label">{t('dashboard.totalEmployees')}</span>
              <strong>{d.totalEmployees}</strong>
            </li>
            <li className="stat" data-testid="stat-activeTasks">
              <span className="stat-label">{t('dashboard.activeTasks')}</span>
              <strong>{d.activeTasks}</strong>
            </li>
            <li className="stat" data-testid="stat-completedTasks">
              <span className="stat-label">{t('dashboard.completedTasks')}</span>
              <strong>{d.completedTasks}</strong>
            </li>
            <li className="stat" data-testid="stat-onTimeRate">
              <span className="stat-label">{t('dashboard.onTimeRate')}</span>
              <strong>{rate ?? t('dashboard.noData')}</strong>
            </li>
            <li className="stat" data-testid="stat-tokens">
              <span className="stat-label">
                {t('dashboard.tokens')} ({d.period})
              </span>
              <strong>{formatTokens(d.tokens)}</strong>
              <span className="stat-sub">
                {t('dashboard.allTime')}: {formatTokens(d.allTime.tokens)}
              </span>
            </li>
            <li className="stat" data-testid="stat-cost">
              <span className="stat-label">
                {t('dashboard.cost')} ({d.period})
              </span>
              <strong>{formatUsd(d.costUsd)}</strong>
              <span className="stat-sub">
                {t('dashboard.allTime')}: {formatUsd(d.allTime.costUsd)}
              </span>
            </li>
          </ul>
          <p className="hint">{t('dashboard.hint')}</p>
        </>
      )}
    </section>
  );
}
