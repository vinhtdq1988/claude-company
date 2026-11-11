import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { TaskDetail, TaskPriority } from '@claude-company/contracts';
import { ErrorNotice } from '../../components/ErrorNotice';
import { t } from '../../i18n';
import { invalidateTasks, transitionTask } from '../tasks/task-queries';
import { patchDraftTask } from './assistant-queries';

const PRIORITIES: readonly TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

/** Giá trị `datetime-local` (giờ địa phương) từ ISO. */
const toLocalInput = (iso: string): string => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

type Props = { companyId: string; task: TaskDetail };

/**
 * Đề xuất của CEO AI Assistant cho task nháp (FR-047): CEO xem title, tiêu chí, deadline, priority, đầu ra mong đợi,
 * chỉnh qua `PATCH /tasks/{id}` rồi giao. Khi `proposalStatus = pending` khóa nút giao (server cũng chặn bằng
 * `409 PROPOSAL_PENDING`) và tự làm mới theo chu kỳ ngắn (ở `useTask`); `failed` cho phép sửa tay như task nháp thường.
 */
export function ProposalConfirm({ companyId, task }: Props) {
  const pending = task.proposalStatus === 'pending';
  const [title, setTitle] = useState(task.title);
  const [criteria, setCriteria] = useState(task.acceptanceCriteria.map((c) => c.text).join('\n'));
  const [expectedOutput, setExpectedOutput] = useState(task.expectedOutput);
  const [deadline, setDeadline] = useState(toLocalInput(task.deadline));
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [synced, setSynced] = useState(task.proposalStatus);

  // Đề xuất vừa chuyển từ pending sang ready/failed: nạp giá trị mới do trợ lý ghi.
  if (synced !== task.proposalStatus) {
    setSynced(task.proposalStatus);
    setTitle(task.title);
    setCriteria(task.acceptanceCriteria.map((c) => c.text).join('\n'));
    setExpectedOutput(task.expectedOutput);
    setDeadline(toLocalInput(task.deadline));
    setPriority(task.priority);
  }

  const lines = criteria
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const save = useMutation({
    mutationFn: () =>
      patchDraftTask(companyId, task.id, {
        title: title.trim(),
        acceptanceCriteria: lines,
        expectedOutput: expectedOutput.trim(),
        deadline: new Date(deadline).toISOString(),
        priority,
      }),
    onSuccess: () => invalidateTasks(companyId),
  });
  const assign = useMutation({
    mutationFn: async () => {
      await patchDraftTask(companyId, task.id, {
        title: title.trim(),
        acceptanceCriteria: lines,
        expectedOutput: expectedOutput.trim(),
        deadline: new Date(deadline).toISOString(),
        priority,
      });
      return transitionTask(companyId, task.id, 'assign');
    },
    onSuccess: () => invalidateTasks(companyId),
  });
  const valid = title.trim() && lines.length > 0 && expectedOutput.trim() && deadline;
  const busy = save.isPending || assign.isPending;

  return (
    <section className="proposal" aria-label={t('assistant.confirm.title')} data-proposal={task.proposalStatus}>
      <h3>{t('assistant.confirm.title')}</h3>
      {pending && (
        <p role="status" className="banner">
          {t('assistant.confirm.pending')}
        </p>
      )}
      {task.proposalStatus === 'failed' && (
        <p role="alert" className="banner banner-warn">
          {t('assistant.confirm.failed')}
        </p>
      )}
      {task.proposalStatus === 'ready' && <p className="muted">{t('assistant.confirm.ready')}</p>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <fieldset disabled={pending || busy}>
          <label>
            {t('assistant.confirm.titleField')}
            <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            {t('assistant.confirm.criteria')}
            <textarea rows={4} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
            <small className="muted">{t('assistant.confirm.criteriaHint')}</small>
          </label>
          <label>
            {t('assistant.confirm.output')}
            <input value={expectedOutput} onChange={(e) => setExpectedOutput(e.target.value)} />
          </label>
          <div className="form-grid">
            <label>
              {t('assistant.confirm.deadline')}
              <input
                type="datetime-local"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              />
            </label>
            <label>
              {t('assistant.confirm.priority')}
              <select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {t(`tasks.priority.${p}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>
        <div className="editor-row">
          <button type="submit" className="secondary" disabled={pending || busy || !valid}>
            {t('assistant.confirm.save')}
          </button>
          <button
            type="button"
            disabled={pending || busy || !valid}
            onClick={() => assign.mutate()}
          >
            {t('assistant.confirm.assign')}
          </button>
        </div>
      </form>
      {save.isError && <ErrorNotice error={save.error} />}
      {assign.isError && <ErrorNotice error={assign.error} />}
      {save.isSuccess && <p className="muted">{t('assistant.confirm.saved')}</p>}
    </section>
  );
}
