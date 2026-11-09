import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ErrorNotice } from '../../components/ErrorNotice';
import { describeError, t } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { findUnit, flattenUnits } from '../org/org-tree';
import { useMembers, useOrgChart } from '../org/org-queries';
import { EmployeeForm } from './EmployeeForm';
import { invalidateEmployees, useEmployee, useEmployees } from './employee-queries';
import { managerName } from './EmployeeListPage';

type Props = {
  companyId: string;
  employeeId: string;
  onBack: () => void;
};

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** Hồ sơ AI Employee: đủ thuộc tính FR-009, thao tác suspend/resume/archive và chỉnh sửa. */
export function EmployeeDetailPage({ companyId, employeeId, onBack }: Props) {
  const employee = useEmployee(companyId, employeeId);
  const everyone = useEmployees(companyId, { status: undefined });
  const chart = useOrgChart(companyId);
  const members = useMembers(companyId);
  const [editing, setEditing] = useState(false);

  const act = useMutation({
    mutationFn: async (action: 'suspend' | 'resume' | 'archive') => {
      const base = `/companies/${companyId}/employees/${employeeId}`;
      if (action === 'archive') await api.delete(base);
      else await api.post(`${base}/${action}`);
      return action;
    },
    onSuccess: async (action) => {
      await invalidateEmployees(companyId);
      if (action === 'archive') onBack();
    },
  });

  if (employee.isPending) return <p className="loading">{t('app.loading')}</p>;
  if (employee.isError) {
    const missing = employee.error instanceof ApiError && employee.error.status === 404;
    return (
      <section>
        <button type="button" className="link" onClick={onBack}>
          {t('employee.detail.back')}
        </button>
        <p role="alert" className="error">
          {missing ? t('employee.detail.notFound') : describeError(employee.error)}
        </p>
      </section>
    );
  }

  const e = employee.data;
  if (editing) {
    return (
      <section>
        <EmployeeForm
          companyId={companyId}
          employee={e}
          onDone={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      </section>
    );
  }

  const teamNames = flattenUnits(chart.data?.roots ?? [])
    .flatMap((u) => u.teams)
    .filter((team) => e.teamIds.includes(team.id))
    .map((team) => team.name);
  const unit = chart.data ? findUnit(chart.data, e.homeOrgUnitId)?.name : undefined;
  const archived = e.status === 'archived';

  const confirmArchive = () => {
    if (window.confirm(t('employee.detail.archiveConfirm'))) act.mutate('archive');
  };

  return (
    <section className="employee-detail">
      <button type="button" className="link" onClick={onBack}>
        {t('employee.detail.back')}
      </button>
      <header className="page-header page-header-row">
        <h2>{e.name}</h2>
        <span className="badge">{t(`employees.status.${e.status}`)}</span>
        {!archived && (
          <div className="editor-row">
            <button type="button" onClick={() => setEditing(true)}>
              {t('employee.detail.edit')}
            </button>
            {e.status === 'active' ? (
              <button type="button" disabled={act.isPending} onClick={() => act.mutate('suspend')}>
                {t('employee.detail.suspend')}
              </button>
            ) : (
              <button type="button" disabled={act.isPending} onClick={() => act.mutate('resume')}>
                {t('employee.detail.resume')}
              </button>
            )}
            <button
              type="button"
              className="danger"
              disabled={act.isPending}
              onClick={confirmArchive}
            >
              {t('employee.detail.archive')}
            </button>
          </div>
        )}
      </header>
      {act.isError && <ErrorNotice error={act.error} hint={t('employee.detail.cannotArchive')} />}

      <dl className="profile">
        <dt>{t('employee.form.position')}</dt>
        <dd>
          {e.position} · {t(`employees.kind.${e.kind}`)} · {t(`employees.seniority.${e.seniority}`)}
        </dd>
        <dt>{t('employee.form.unit')}</dt>
        <dd>{unit ?? '—'}</dd>
        <dt>{t('employee.detail.team')}</dt>
        <dd>{teamNames.length > 0 ? teamNames.join(', ') : t('employee.detail.none')}</dd>
        <dt>{t('employee.form.manager')}</dt>
        <dd>
          {managerName(e, members.data ?? [], everyone.data ?? [])} (
          {e.manager.kind === 'human'
            ? t('employee.form.manager.humans')
            : t('employee.form.manager.ais')}
          )
        </dd>
        <dt>{t('employee.form.personality')}</dt>
        <dd>{e.personality || '—'}</dd>
        <dt>{t('employee.form.skills')}</dt>
        <dd>{e.skills.length > 0 ? e.skills.join(', ') : '—'}</dd>
        <dt>{t('employee.form.model')}</dt>
        <dd>{e.modelId}</dd>
        <dt>{t('employee.form.runtime')}</dt>
        <dd>{t(`employees.runtime.${e.runtimeKind}`)}</dd>
        <dt>{t('employee.form.prompt')}</dt>
        <dd className="prewrap">{e.systemPrompt}</dd>
        <dt>{t('employee.detail.tools')}</dt>
        <dd>
          {e.toolGrants.length > 0
            ? e.toolGrants.map((g) => <code key={g}>{g}</code>)
            : t('employee.detail.none')}
        </dd>
        <dt>{t('employee.form.maxTasks')}</dt>
        <dd>{e.maxConcurrentTasks}</dd>
        <dt>{t('employee.detail.performance')}</dt>
        <dd>
          {t('employee.detail.completed')}: {e.performance.completedTasks} ·{' '}
          {t('employee.detail.onTime')}: {percent(e.performance.onTimeRate)} ·{' '}
          {t('employee.detail.rework')}: {percent(e.performance.reworkRate)}
        </dd>
      </dl>
    </section>
  );
}
