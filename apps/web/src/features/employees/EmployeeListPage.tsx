import { useState } from 'react';
import type {
  EmployeeFilter,
  EmployeeKind,
  EmployeeProfile,
  EmployeeStatus,
  HumanMember,
  OrgChart,
} from '@claude-company/contracts';
import { describeError, t } from '../../i18n';
import { findUnit, flattenUnits } from '../org/org-tree';
import { useMembers, useOrgChart } from '../org/org-queries';
import { useEmployees } from './employee-queries';

/** Tên manager trực tiếp để hiển thị trong bảng. */
export function managerName(
  employee: EmployeeProfile,
  members: HumanMember[],
  employees: EmployeeProfile[],
): string {
  const found =
    employee.manager.kind === 'human'
      ? members.find((m) => m.id === employee.manager.id)?.displayName
      : employees.find((e) => e.id === employee.manager.id)?.name;
  return found ?? '—';
}

type Props = {
  companyId: string;
  onOpen: (id: string) => void;
  onNew: () => void;
};

/** Danh sách AI Employee trong phạm vi của người xem, có bộ lọc theo Department, Team, loại và trạng thái. */
export function EmployeeListPage({ companyId, onOpen, onNew }: Props) {
  const [orgUnitId, setOrgUnitId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [kind, setKind] = useState<EmployeeKind | ''>('');
  const [status, setStatus] = useState<EmployeeStatus | ''>('');

  const filter: EmployeeFilter = {
    orgUnitId: orgUnitId || undefined,
    teamId: teamId || undefined,
    kind: kind || undefined,
    status: status || undefined,
  };
  const employees = useEmployees(companyId, filter);
  const everyone = useEmployees(companyId);
  const chart = useOrgChart(companyId);
  const members = useMembers(companyId);

  const units = flattenUnits(chart.data?.roots ?? []);
  const teams = units.flatMap((u) => u.teams);
  const unitName = (id: string | null, tree?: OrgChart) =>
    (tree && id ? findUnit(tree, id)?.name : undefined) ?? '—';

  return (
    <section className="employees">
      <header className="page-header page-header-row">
        <h2>{t('employees.title')}</h2>
        <button type="button" onClick={onNew}>
          {t('employees.new')}
        </button>
      </header>

      <form className="filters" aria-label={t('employees.filter.title')}>
        <label>
          {t('employees.filter.unit')}
          <select value={orgUnitId} onChange={(e) => setOrgUnitId(e.target.value)}>
            <option value="">{t('employees.filter.all')}</option>
            {units
              .filter((u) => u.kind === 'department')
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          {t('employees.filter.team')}
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">{t('employees.filter.all')}</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('employees.filter.kind')}
          <select value={kind} onChange={(e) => setKind(e.target.value as EmployeeKind | '')}>
            <option value="">{t('employees.filter.all')}</option>
            <option value="employee">{t('employees.kind.employee')}</option>
            <option value="manager">{t('employees.kind.manager')}</option>
          </select>
        </label>
        <label>
          {t('employees.filter.status')}
          <select value={status} onChange={(e) => setStatus(e.target.value as EmployeeStatus | '')}>
            <option value="">{t('employees.filter.all')}</option>
            <option value="active">{t('employees.status.active')}</option>
            <option value="suspended">{t('employees.status.suspended')}</option>
            <option value="archived">{t('employees.status.archived')}</option>
          </select>
        </label>
      </form>

      {employees.isPending && <p className="loading">{t('app.loading')}</p>}
      {employees.isError && (
        <p role="alert" className="error">
          {describeError(employees.error)}
        </p>
      )}
      {employees.data && employees.data.length === 0 && (
        <p className="empty">{t('employees.empty')}</p>
      )}
      {employees.data && employees.data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('employees.col.name')}</th>
              <th>{t('employees.col.position')}</th>
              <th>{t('employees.col.unit')}</th>
              <th>{t('employees.col.manager')}</th>
              <th>{t('employees.col.status')}</th>
            </tr>
          </thead>
          <tbody>
            {employees.data.map((e) => (
              <tr key={e.id}>
                <td>
                  <button type="button" className="link" onClick={() => onOpen(e.id)}>
                    {e.name}
                  </button>
                  {e.kind === 'manager' && (
                    <span className="badge badge-team">{t('employees.kind.manager')}</span>
                  )}
                </td>
                <td>{e.position}</td>
                <td>{unitName(e.homeOrgUnitId, chart.data)}</td>
                <td>{managerName(e, members.data ?? [], everyone.data ?? [])}</td>
                <td>{t(`employees.status.${e.status}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
