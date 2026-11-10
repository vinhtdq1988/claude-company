import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { AssigneeKind, Task, TaskPriority } from '@claude-company/contracts';
import { ErrorNotice } from '../../components/ErrorNotice';
import { t } from '../../i18n';
import { useEmployees } from '../employees/employee-queries';
import { useOrgChart } from '../org/org-queries';
import { flattenUnits } from '../org/org-tree';
import {
  PRIORITIES,
  emptyTaskForm,
  toCreateBody,
  validateTaskForm,
  type TaskFormField,
  type TaskFormState,
} from './task-model';
import { createTask, invalidateTasks } from './task-queries';

type Props = {
  companyId: string;
  onCancel: () => void;
  onDone: (created: Task) => void;
};

const ASSIGNEE_KINDS: readonly AssigneeKind[] = ['ai_employee', 'team', 'org_unit'];

/** Biểu mẫu tạo task đủ trường FR-014; giao cho AI Employee, Team hoặc Department. */
export function TaskForm({ companyId, onCancel, onDone }: Props) {
  const [form, setForm] = useState<TaskFormState>(emptyTaskForm);
  const [invalid, setInvalid] = useState<TaskFormField[]>([]);
  const employees = useEmployees(companyId);
  const chart = useOrgChart(companyId);

  const units = flattenUnits(chart.data?.roots ?? []);
  const options: Array<{ id: string; label: string }> =
    form.assigneeKind === 'ai_employee'
      ? (employees.data ?? [])
          .filter((e) => e.status === 'active')
          .map((e) => ({ id: e.id, label: `${e.name} · ${e.position}` }))
      : form.assigneeKind === 'team'
        ? units.flatMap((u) =>
            u.teams.map((team) => ({ id: team.id, label: `${team.name} (${u.name})` })),
          )
        : units.filter((u) => u.kind === 'department').map((u) => ({ id: u.id, label: u.name }));

  const update = (patch: Partial<TaskFormState>) => setForm((f) => ({ ...f, ...patch }));

  const save = useMutation({
    mutationFn: (assign: boolean) => createTask(companyId, toCreateBody(form), assign),
    onSuccess: async (created) => {
      await invalidateTasks(companyId);
      onDone(created);
    },
  });

  const submit = (assign: boolean) => {
    const problems = validateTaskForm(form);
    setInvalid(problems);
    if (problems.length === 0) save.mutate(assign);
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit(false);
  };
  const bad = (field: TaskFormField) => (invalid.includes(field) ? true : undefined);

  return (
    <form
      className="employee-form task-form"
      onSubmit={onSubmit}
      aria-label={t('task.form.titleNew')}
      noValidate
    >
      <h3>{t('task.form.titleNew')}</h3>

      <label>
        {t('task.form.title')}
        <input
          name="title"
          value={form.title}
          maxLength={200}
          aria-invalid={bad('title')}
          onChange={(e) => update({ title: e.target.value })}
        />
      </label>
      <label>
        {t('task.form.objective')}
        <textarea
          name="objective"
          rows={3}
          value={form.objective}
          aria-invalid={bad('objective')}
          onChange={(e) => update({ objective: e.target.value })}
        />
      </label>

      <div className="form-grid">
        <label>
          {t('task.form.assigneeKind')}
          <select
            value={form.assigneeKind}
            onChange={(e) =>
              update({ assigneeKind: e.target.value as AssigneeKind, assigneeId: '' })
            }
          >
            {ASSIGNEE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`tasks.assigneeKind.${kind}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('task.form.assignee')}
          <select
            name="assignee"
            value={form.assigneeId}
            aria-invalid={bad('assigneeId')}
            onChange={(e) => update({ assigneeId: e.target.value })}
          >
            <option value="">{t('task.form.assignee.pick')}</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('task.form.deadline')}
          <input
            type="datetime-local"
            name="deadline"
            value={form.deadline}
            aria-invalid={bad('deadline')}
            onChange={(e) => update({ deadline: e.target.value })}
          />
        </label>
        <label>
          {t('task.form.priority')}
          <select
            value={form.priority}
            onChange={(e) => update({ priority: e.target.value as TaskPriority })}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t(`tasks.priority.${p}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label>
        {t('task.form.criteria')}
        <textarea
          name="criteria"
          rows={4}
          value={form.acceptanceCriteria}
          aria-invalid={bad('acceptanceCriteria')}
          onChange={(e) => update({ acceptanceCriteria: e.target.value })}
        />
      </label>
      <label>
        {t('task.form.expectedOutput')}
        <input
          name="expectedOutput"
          value={form.expectedOutput}
          aria-invalid={bad('expectedOutput')}
          onChange={(e) => update({ expectedOutput: e.target.value })}
        />
      </label>

      <div className="form-grid">
        <label>
          {t('task.form.tokenCap')}
          <input
            name="tokenCap"
            inputMode="numeric"
            value={form.tokenCap}
            aria-invalid={bad('tokenCap')}
            onChange={(e) => update({ tokenCap: e.target.value })}
          />
        </label>
        <label>
          {t('task.form.costCap')}
          <input
            name="costCap"
            inputMode="decimal"
            value={form.costCap}
            aria-invalid={bad('costCap')}
            onChange={(e) => update({ costCap: e.target.value })}
          />
        </label>
      </div>

      {invalid.length > 0 && (
        <p role="alert" className="error">
          {t('task.form.invalid')}
        </p>
      )}
      {save.isError && <ErrorNotice error={save.error} />}

      <div className="editor-row">
        <button type="submit" disabled={save.isPending}>
          {t('task.form.submit')}
        </button>
        <button type="button" disabled={save.isPending} onClick={() => submit(true)}>
          {t('task.form.submitAssign')}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t('task.form.cancel')}
        </button>
      </div>
    </form>
  );
}
