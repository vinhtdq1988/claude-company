import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  CEO_ASSISTANT_TEMPLATE_KEY,
  type EmployeeKind,
  type EmployeeProfile,
  type RuntimeKind,
  type Seniority,
} from '@claude-company/contracts';
import { ErrorNotice } from '../../components/ErrorNotice';
import { t, type MessageKey } from '../../i18n';
import { api } from '../../lib/api';
import { flattenUnits } from '../org/org-tree';
import { useMembers, useOrgChart } from '../org/org-queries';
import {
  invalidateEmployees,
  useEmployees,
  useModels,
  useRoleTemplates,
  useWorkspaces,
} from './employee-queries';
import {
  applyTemplate,
  AVATAR_KEYS,
  changeKind,
  changeRuntime,
  emptyForm,
  formFromProfile,
  isAssistantForm,
  RUNTIMES,
  SENIORITIES,
  toggleTool,
  toolOptions,
  toRequestBody,
  type EmployeeFormState,
} from './employee-form-model';

type Props = {
  companyId: string;
  /** Có `employee` là chỉnh sửa, không có là tuyển mới. */
  employee?: EmployeeProfile;
  onDone: (saved?: EmployeeProfile) => void;
  onCancel: () => void;
};

/** Biểu mẫu tuyển và cấu hình AI Employee, đủ các trường hồ sơ FR-009 (US2). */
export function EmployeeForm({ companyId, employee, onDone, onCancel }: Props) {
  const chart = useOrgChart(companyId);
  const members = useMembers(companyId);
  const employees = useEmployees(companyId);
  const models = useModels();
  const templates = useRoleTemplates();
  const workspaces = useWorkspaces(companyId);

  const departments = flattenUnits(chart.data?.roots ?? []).filter((n) => n.kind === 'department');
  const aiManagers = (employees.data ?? []).filter(
    (e) => e.kind === 'manager' && e.status !== 'archived' && e.id !== employee?.id,
  );

  const [form, setForm] = useState<EmployeeFormState>(() =>
    employee ? formFromProfile(employee) : emptyForm(),
  );
  const update = (patch: Partial<EmployeeFormState>) => setForm((f) => ({ ...f, ...patch }));

  // Giá trị mặc định chỉ điền khi dữ liệu danh mục tải xong và người dùng chưa chọn.
  const modelId = form.modelId || models.data?.[0]?.modelId || '';
  const homeOrgUnitId = form.homeOrgUnitId || departments[0]?.id || '';
  const current = { ...form, modelId, homeOrgUnitId };

  const save = useMutation({
    mutationFn: async () => {
      const body = toRequestBody(current);
      const base = `/companies/${companyId}/employees`;
      if (!employee) return api.post<EmployeeProfile>(base, body);
      // PATCH không nhận manager rỗng; bỏ trường để giữ manager hiện tại.
      const { manager, ...rest } = body;
      return api.patch<EmployeeProfile>(`${base}/${employee.id}`, manager ? body : rest);
    },
    onSuccess: async (saved) => {
      await invalidateEmployees(companyId);
      onDone(saved);
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  const onTemplate = (key: string) => {
    const template = templates.data?.find((x) => x.key === key);
    setForm((f) => applyTemplate({ ...f, modelId, homeOrgUnitId }, template));
  };

  // Mẫu ceo_assistant: ẩn đơn vị nhà, manager cố định là CEO, runtime và công cụ chỉ đọc (FR-046, FR-049).
  const assistant = isAssistantForm(current) || employee?.roleTemplateKey === CEO_ASSISTANT_TEMPLATE_KEY;
  const tools = toolOptions(current.runtimeKind, assistant);
  const title = employee ? t('employee.form.titleEdit') : t('employee.form.titleNew');

  return (
    <form className="employee-form" onSubmit={onSubmit} aria-label={title}>
      <h3>{title}</h3>

      {!employee && (
        <label>
          {t('employee.form.template')}
          <select value={form.roleTemplateKey} onChange={(e) => onTemplate(e.target.value)}>
            <option value="">{t('employee.form.template.custom')}</option>
            {(templates.data ?? []).map((tpl) => (
              <option key={tpl.key} value={tpl.key}>
                {tpl.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="form-grid">
        <label>
          {t('employee.form.name')}
          <input
            value={form.name}
            onChange={(e) => update({ name: e.target.value })}
            required
            maxLength={80}
            name="name"
          />
        </label>
        <label>
          {t('employee.form.position')}
          <input
            value={form.position}
            onChange={(e) => update({ position: e.target.value })}
            required
            maxLength={120}
            name="position"
          />
        </label>
        {!assistant && (
          <label>
            {t('employee.form.unit')}
            <select
              value={homeOrgUnitId}
              onChange={(e) => update({ homeOrgUnitId: e.target.value })}
              required
            >
              {departments.length === 0 && <option value="">{t('employee.form.unit.pick')}</option>}
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          {t('employee.form.kind')}
          <select
            value={form.kind}
            disabled={assistant}
            onChange={(e) => setForm((f) => changeKind(f, e.target.value as EmployeeKind))}
          >
            <option value="employee">{t('employees.kind.employee')}</option>
            <option value="manager">{t('employees.kind.manager')}</option>
          </select>
        </label>
        <label>
          {t('employee.form.seniority')}
          <select
            value={form.seniority}
            onChange={(e) => update({ seniority: e.target.value as Seniority })}
          >
            {SENIORITIES.map((s) => (
              <option key={s} value={s}>
                {t(`employees.seniority.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('employee.form.avatar')}
          <select value={form.avatarKey} onChange={(e) => update({ avatarKey: e.target.value })}>
            {AVATAR_KEYS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label>
        {t('employee.form.personality')}
        <textarea
          value={form.personality}
          onChange={(e) => update({ personality: e.target.value })}
          rows={2}
          maxLength={2000}
        />
      </label>
      <label>
        {t('employee.form.skills')}
        <input value={form.skills} onChange={(e) => update({ skills: e.target.value })} />
      </label>

      <div className="form-grid">
        <label>
          {t('employee.form.model')}
          <select value={modelId} onChange={(e) => update({ modelId: e.target.value })} required>
            {(models.data ?? []).map((m) => (
              <option key={m.modelId} value={m.modelId}>
                {m.modelId}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('employee.form.runtime')}
          <select
            value={form.runtimeKind}
            disabled={form.kind === 'manager' || assistant}
            onChange={(e) => setForm((f) => changeRuntime(f, e.target.value as RuntimeKind))}
          >
            {RUNTIMES.map((r) => (
              <option key={r} value={r}>
                {t(`employees.runtime.${r}` as MessageKey)}
              </option>
            ))}
          </select>
          {form.kind === 'manager' && !assistant && (
            <small className="muted">{t('employee.form.runtimeLocked')}</small>
          )}
        </label>
        <label>
          {t('employee.form.workspace')}
          <select
            value={form.workspaceId}
            onChange={(e) => update({ workspaceId: e.target.value })}
          >
            <option value="">{t('employee.form.workspace.none')}</option>
            {(workspaces.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('employee.form.maxTasks')}
          <input
            type="number"
            min={1}
            max={20}
            value={form.maxConcurrentTasks}
            onChange={(e) => update({ maxConcurrentTasks: e.target.value })}
            required
          />
        </label>
      </div>

      <label>
        {t('employee.form.prompt')}
        <textarea
          value={form.systemPrompt}
          onChange={(e) => update({ systemPrompt: e.target.value })}
          rows={4}
          required
          maxLength={20000}
        />
      </label>

      <fieldset className="choices">
        <legend>{t('employee.form.tools')}</legend>
        {tools.map((tool) => (
          <label key={tool.actionType} className="choice">
            <input
              type="checkbox"
              checked={form.toolGrants.includes(tool.actionType)}
              disabled={assistant}
              onChange={() => setForm((f) => toggleTool(f, tool.actionType))}
            />
            <span>
              <code>{tool.actionType}</code> – {tool.description}
            </span>
          </label>
        ))}
        <small className="muted">
          {assistant ? t('employee.form.assistantHint') : t('employee.form.toolsHint')}
        </small>
      </fieldset>

      <label>
        {t('employee.form.manager')}
        <select
          value={form.manager}
          disabled={assistant}
          onChange={(e) => update({ manager: e.target.value })}
        >
          <option value="">{t('employee.form.manager.pick')}</option>
          <optgroup label={t('employee.form.manager.humans')}>
            {(members.data ?? []).map((m) => (
              <option key={m.id} value={`human:${m.id}`}>
                {m.displayName}
                {m.title ? ` – ${m.title}` : ''}
              </option>
            ))}
          </optgroup>
          {aiManagers.length > 0 && (
            <optgroup label={t('employee.form.manager.ais')}>
              {aiManagers.map((m) => (
                <option key={m.id} value={`ai:${m.id}`}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>

      {save.isError && <ErrorNotice error={save.error} />}
      <div className="editor-row">
        <button type="submit" disabled={save.isPending}>
          {employee ? t('employee.form.submitEdit') : t('employee.form.submitNew')}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t('app.cancel')}
        </button>
      </div>
    </form>
  );
}
