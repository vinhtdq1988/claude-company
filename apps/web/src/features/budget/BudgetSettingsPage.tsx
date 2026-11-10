import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { BudgetPolicy, BudgetScopeKind, PutBudgetPolicyBody } from '@claude-company/contracts';
import { ErrorNotice } from '../../components/ErrorNotice';
import { t } from '../../i18n';
import { useMyMembership } from '../../lib/session';
import { useEmployees, useModels } from '../employees/employee-queries';
import { useCompany, useOrgChart } from '../org/org-queries';
import { invalidateTasks, transitionTask, useTasks } from '../tasks/task-queries';
import {
  budgetBlockedTasks,
  buildScopeOptions,
  formatTokens,
  formatUsd,
  parseFormState,
  scopeKey,
  toFormState,
  usageLevel,
  usageRatio,
  type PolicyField,
  type PolicyFormState,
  type ScopeOption,
} from './budget-model';
import { invalidateBudget, saveBudgetPolicy, useBudgetPolicy, useUsage } from './budget-queries';

const FIELD_ERROR = { required: 'budget.error.required', invalid: 'budget.error.invalid' } as const;

/** Mức dùng tháng này so với giới hạn của phạm vi (đơn vị, nhân viên, công ty có API usage theo bộ lọc). */
function UsageBars({
  companyId,
  scope,
  policy,
}: {
  companyId: string;
  scope: ScopeOption;
  policy: BudgetPolicy;
}) {
  const filter =
    scope.kind === 'org_unit'
      ? { orgUnitId: scope.id }
      : scope.kind === 'ai_employee'
        ? { employeeId: scope.id }
        : {};
  const usage = useUsage(companyId, filter, scope.kind !== 'team');
  if (scope.kind === 'team' || !usage.data) return null;
  const rows = [
    {
      key: 'tokens',
      label: t('budget.tokenLimit'),
      used: usage.data.tokens,
      limit: policy.monthlyTokenLimit,
      format: formatTokens,
    },
    {
      key: 'cost',
      label: t('budget.costLimit'),
      used: usage.data.costUsd,
      limit: policy.monthlyCostLimit,
      format: formatUsd,
    },
  ];
  return (
    <section data-testid="budget-usage">
      <h3>
        {t('budget.usedThisMonth')} ({usage.data.period})
      </h3>
      {rows.map((row) => {
        const ratio = usageRatio(row.used, row.limit);
        const level = usageLevel(ratio, policy.warnThreshold);
        return (
          <div key={row.key} className={`usage-row usage-${level}`}>
            <span>{row.label}</span>
            <progress max={1} value={Math.min(ratio ?? 0, 1)} />
            <span>
              {row.format(row.used)} /{' '}
              {row.limit === null ? t('budget.unlimited') : row.format(row.limit)}{' '}
              <span className="badge">{t(`budget.level.${level}`)}</span>
            </span>
          </div>
        );
      })}
    </section>
  );
}

function PolicyForm({
  companyId,
  scope,
  policy,
}: {
  companyId: string;
  scope: ScopeOption;
  policy: BudgetPolicy;
}) {
  const models = useModels();
  const [form, setForm] = useState<PolicyFormState>(() => toFormState(policy));
  const [errors, setErrors] = useState<Partial<Record<PolicyField, 'required' | 'invalid'>>>({});

  // Đổi phạm vi hoặc dữ liệu từ server (sau khi lưu) thì nạp lại biểu mẫu.
  useEffect(() => setForm(toFormState(policy)), [policy]);

  const save = useMutation({
    mutationFn: (body: PutBudgetPolicyBody) =>
      saveBudgetPolicy(companyId, scope.kind, scope.id, body),
    onSuccess: () => invalidateBudget(companyId),
  });

  function parseBody() {
    const parsed = parseFormState(form, scope.kind);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return null;
    }
    setErrors({});
    return parsed.body;
  }

  const update = (patch: Partial<PolicyFormState>) => setForm((f) => ({ ...f, ...patch }));
  const toggleModel = (modelId: string) =>
    update({
      allowedModels: form.allowedModels.includes(modelId)
        ? form.allowedModels.filter((m) => m !== modelId)
        : [...form.allowedModels, modelId],
    });
  const fieldError = (field: PolicyField) =>
    errors[field] ? (
      <span role="alert" className="error">
        {t(FIELD_ERROR[errors[field]])}
      </span>
    ) : null;

  return (
    <form
      className="employee-form"
      onSubmit={(e) => {
        e.preventDefault();
        const body = parseBody();
        if (body) save.mutate(body);
      }}
    >
      {policy.isDefault && <p className="hint">{t('budget.default')}</p>}
      {scope.kind === 'company' && <p className="hint">{t('budget.companyRequired')}</p>}
      <div className="form-grid">
        <label>
          {t('budget.tokenLimit')}
          <input
            inputMode="numeric"
            value={form.monthlyTokenLimit}
            placeholder={t('budget.unlimited')}
            onChange={(e) => update({ monthlyTokenLimit: e.target.value })}
          />
          {fieldError('monthlyTokenLimit')}
        </label>
        <label>
          {t('budget.costLimit')}
          <input
            inputMode="decimal"
            value={form.monthlyCostLimit}
            placeholder={t('budget.unlimited')}
            onChange={(e) => update({ monthlyCostLimit: e.target.value })}
          />
          {fieldError('monthlyCostLimit')}
        </label>
        <label>
          {t('budget.maxTasks')}
          <input
            inputMode="numeric"
            value={form.maxConcurrentTasks}
            disabled={scope.kind === 'ai_employee'}
            placeholder={t('budget.unlimited')}
            onChange={(e) => update({ maxConcurrentTasks: e.target.value })}
          />
          {scope.kind === 'ai_employee' && (
            <span className="hint">{t('budget.maxTasks.employeeHint')}</span>
          )}
          {fieldError('maxConcurrentTasks')}
        </label>
        <label>
          {t('budget.warnPercent')}
          <input
            inputMode="decimal"
            value={form.warnPercent}
            onChange={(e) => update({ warnPercent: e.target.value })}
          />
          {fieldError('warnPercent')}
        </label>
      </div>
      <fieldset>
        <legend>{t('budget.allowedModels')}</legend>
        <div className="editor-row">
          {(models.data ?? []).map((m) => (
            <label key={m.modelId} className="choice">
              <input
                type="checkbox"
                checked={form.allowedModels.includes(m.modelId)}
                onChange={() => toggleModel(m.modelId)}
              />
              {m.modelId}
            </label>
          ))}
        </div>
        <p className="hint">{t('budget.allowedModels.hint')}</p>
      </fieldset>
      {save.isError && <ErrorNotice error={save.error} />}
      {save.isSuccess && <p role="status">{t('budget.saved')}</p>}
      <div className="editor-row">
        <button type="submit" disabled={save.isPending}>
          {t('budget.save')}
        </button>
      </div>
    </form>
  );
}

/** Task bị chặn vì hết ngân sách: tăng hạn mức rồi `resume` (người quản lý quyết định, không tự tiếp tục). */
function BlockedTasks({ companyId }: { companyId: string }) {
  const tasks = useTasks(companyId, { status: 'blocked' });
  const blocked = budgetBlockedTasks(tasks.data ?? []);
  const resume = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await transitionTask(companyId, id, 'resume');
    },
    onSettled: () => invalidateTasks(companyId),
  });

  return (
    <section data-testid="budget-blocked">
      <h3>{t('budget.blocked.title')}</h3>
      <p className="hint">{t('budget.blocked.hint')}</p>
      {blocked.length === 0 ? (
        <p>{t('budget.blocked.none')}</p>
      ) : (
        <>
          <ul className="plain-list">
            {blocked.map((task) => (
              <li key={task.id} className="editor-row">
                <Link to={`../tasks?id=${task.id}`}>{task.title}</Link>
                <button
                  type="button"
                  disabled={resume.isPending}
                  onClick={() => resume.mutate([task.id])}
                >
                  {t('budget.blocked.resume')}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={resume.isPending}
            onClick={() => resume.mutate(blocked.map((x) => x.id))}
          >
            {t('budget.blocked.resumeAll')}
          </button>
        </>
      )}
      {resume.isError && <ErrorNotice error={resume.error} />}
    </section>
  );
}

/**
 * Màn hình giới hạn theo phạm vi (FR-031): chọn công ty, đơn vị, team hoặc nhân viên rồi đặt token, chi phí, số task
 * đồng thời, ngưỡng cảnh báo và model được phép. Server cưỡng chế phạm vi quản lý (403 nếu ngoài phạm vi).
 */
export default function BudgetSettingsPage() {
  const { companyId = '' } = useParams();
  const isCeo = useMyMembership(companyId)?.role === 'ceo';
  const company = useCompany(companyId);
  const chart = useOrgChart(companyId);
  const employees = useEmployees(companyId);

  const options = useMemo(
    () =>
      buildScopeOptions({
        companyId,
        companyName: company.data?.name ?? t('budget.scope.company'),
        chart: chart.data,
        employees: employees.data ?? [],
        isCeo,
      }),
    [companyId, company.data, chart.data, employees.data, isCeo],
  );
  const [selected, setSelected] = useState('');
  const scope = options.find((o) => scopeKey(o) === selected) ?? options[0];
  const policy = useBudgetPolicy(
    companyId,
    (scope?.kind ?? 'company') as BudgetScopeKind,
    scope?.id ?? '',
  );

  return (
    <section className="budget-settings">
      <header className="page-header">
        <h2>{t('budget.title')}</h2>
      </header>
      <div className="filters">
        <label>
          {t('budget.scope')}
          <select
            value={scope ? scopeKey(scope) : ''}
            onChange={(e) => setSelected(e.target.value)}
          >
            {options.map((o) => (
              <option key={scopeKey(o)} value={scopeKey(o)}>
                {`${'— '.repeat(o.depth)}${t(`budget.scope.${o.kind}`)}: ${o.label}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      {scope && policy.isPending && <p className="loading">{t('app.loading')}</p>}
      {policy.isError && <ErrorNotice error={policy.error} />}
      {scope && policy.data && (
        <>
          <PolicyForm
            key={scopeKey(scope)}
            companyId={companyId}
            scope={scope}
            policy={policy.data}
          />
          <UsageBars companyId={companyId} scope={scope} policy={policy.data} />
        </>
      )}
      <BlockedTasks companyId={companyId} />
    </section>
  );
}
