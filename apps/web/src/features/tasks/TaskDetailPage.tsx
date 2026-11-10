import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { TaskDetail } from '@claude-company/contracts';
import { ErrorNotice } from '../../components/ErrorNotice';
import { describeError, t, type MessageKey } from '../../i18n';
import { ApiError } from '../../lib/api';
import { useMembers } from '../org/org-queries';
import { useAssigneeLookup } from './TaskBoardPage';
import {
  allowedActions,
  buildTrace,
  canDecide,
  canResume,
  checkCriteria,
  isKnownBlockedReason,
  progressOf,
} from './task-model';
import {
  decideTask,
  fetchArtifactText,
  invalidateTasks,
  postTaskMessage,
  transitionTask,
  useExecutedActions,
  useTask,
  useTaskMessages,
  useTaskRealtime,
} from './task-queries';

type Props = {
  companyId: string;
  taskId: string;
  onBack: () => void;
  onOpen: (id: string) => void;
};

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

/** Nội dung artifact mở xem được ngay trong trang (văn bản); server kiểm tra phạm vi của task chứa nó. */
function ArtifactViewer({ companyId, artifactId }: { companyId: string; artifactId: string }) {
  const content = useQuery({
    queryKey: ['company', companyId, 'artifacts', artifactId],
    queryFn: () => fetchArtifactText(companyId, artifactId),
  });
  if (content.isPending) return <p className="loading">{t('task.detail.artifacts.loading')}</p>;
  if (content.isError)
    return (
      <p role="alert" className="error">
        {describeError(content.error)}
      </p>
    );
  return <pre className="artifact-content">{content.data}</pre>;
}

/** Nút và lý do cho quyết định của Human Manager (approve/reject/rework); lý do bắt buộc với mọi quyết định (FR-019). */
function DecisionPanel({ companyId, task }: { companyId: string; task: TaskDetail }) {
  const [reason, setReason] = useState('');
  const [missingReason, setMissingReason] = useState(false);
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject' | 'rework') =>
      decideTask(companyId, task.id, { decision, reason: reason.trim() }),
    onSuccess: async () => {
      setReason('');
      await invalidateTasks(companyId);
    },
  });
  const submit = (decision: 'approve' | 'reject' | 'rework') => {
    if (!reason.trim()) {
      setMissingReason(true);
      return;
    }
    setMissingReason(false);
    decide.mutate(decision);
  };
  const incomplete =
    decide.error instanceof ApiError && decide.error.code === 'EVIDENCE_INCOMPLETE';
  const missing = incomplete
    ? (((decide.error as ApiError).details.missing as string[] | undefined) ?? [])
    : [];

  return (
    <form
      className="decision"
      aria-label={t('task.decision.title')}
      onSubmit={(e) => e.preventDefault()}
    >
      <h3>{t('task.decision.title')}</h3>
      <label>
        {t('task.decision.reason')}
        <textarea
          name="reason"
          rows={3}
          value={reason}
          aria-invalid={missingReason || undefined}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {missingReason && (
        <p role="alert" className="error">
          {t('task.decision.reasonRequired')}
        </p>
      )}
      {decide.isError && (
        <div role="alert" className="error">
          <p>{describeError(decide.error)}</p>
          {missing.length > 0 && (
            <>
              <p>{t('task.decision.incomplete')}</p>
              <ul>
                {missing.map((id) => (
                  <li key={id}>{task.acceptanceCriteria.find((c) => c.id === id)?.text ?? id}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <div className="editor-row">
        <button type="button" disabled={decide.isPending} onClick={() => submit('approve')}>
          {t('task.decision.approve')}
        </button>
        <button
          type="button"
          className="danger"
          disabled={decide.isPending}
          onClick={() => submit('reject')}
        >
          {t('task.decision.reject')}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={decide.isPending}
          onClick={() => submit('rework')}
        >
          {t('task.decision.rework')}
        </button>
      </div>
    </form>
  );
}

function Messages({ companyId, taskId }: { companyId: string; taskId: string }) {
  const messages = useTaskMessages(companyId, taskId);
  const [body, setBody] = useState('');
  const send = useMutation({
    mutationFn: () => postTaskMessage(companyId, taskId, body.trim()),
    onSuccess: async () => {
      setBody('');
      await invalidateTasks(companyId);
    },
  });
  return (
    <section aria-label={t('task.detail.messages')}>
      <h3>{t('task.detail.messages')}</h3>
      {messages.isPending && <p className="loading">{t('app.loading')}</p>}
      {messages.isSuccess && messages.data.length === 0 && (
        <p className="muted">{t('task.detail.messages.none')}</p>
      )}
      <ul className="message-list">
        {(messages.data ?? []).map((m) => (
          <li key={m.id}>
            <strong>
              {m.authorKind === 'ai'
                ? t('task.detail.messages.ai')
                : t('task.detail.messages.human')}
            </strong>{' '}
            <time dateTime={m.createdAt}>{formatTime(m.createdAt)}</time>
            <p className="prewrap">{m.body}</p>
          </li>
        ))}
      </ul>
      <form
        className="message-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) send.mutate();
        }}
      >
        <textarea
          aria-label={t('task.detail.messages.placeholder')}
          placeholder={t('task.detail.messages.placeholder')}
          rows={2}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <button type="submit" disabled={send.isPending || !body.trim()}>
          {t('task.detail.messages.send')}
        </button>
      </form>
      {send.isError && <ErrorNotice error={send.error} />}
    </section>
  );
}

/**
 * Chi tiết task (FR-014, FR-019–FR-022, SC-014): kế hoạch phân rã, task con, artifact mở xem được, evidence từng
 * criterion, trao đổi, nút approve/reject/rework bắt buộc lý do, `blocked_reason` cùng nút resume/cancel,
 * và chuỗi truy vết từ yêu cầu đến quyết định.
 */
export function TaskDetailPage({ companyId, taskId, onBack, onOpen }: Props) {
  const task = useTask(companyId, taskId);
  const actions = useExecutedActions(companyId, taskId);
  const members = useMembers(companyId);
  const describe = useAssigneeLookup(companyId);
  const live = useTaskRealtime(companyId);
  const [openArtifact, setOpenArtifact] = useState<string | null>(null);

  const act = useMutation({
    mutationFn: (action: 'assign' | 'cancel' | 'resume') =>
      transitionTask(companyId, taskId, action),
    onSuccess: () => invalidateTasks(companyId),
  });

  if (task.isPending) return <p className="loading">{t('app.loading')}</p>;
  if (task.isError) {
    const missing =
      task.error instanceof ApiError && (task.error.status === 404 || task.error.status === 403);
    return (
      <section>
        <button type="button" className="link" onClick={onBack}>
          {t('task.detail.back')}
        </button>
        <p role="alert" className="error">
          {missing ? t('task.detail.notFound') : describeError(task.error)}
        </p>
      </section>
    );
  }

  const d = task.data;
  const who = describe(d);
  const creator = members.data?.find((m) => m.id === d.createdByMemberId)?.displayName;
  const criteria = checkCriteria(d);
  const trace = buildTrace(d);
  const progress = progressOf(d, live[d.id]);
  const buttons = allowedActions(d).filter((a) => a !== 'resume' || canResume(d));
  const blockedKey = d.blockedReason
    ? isKnownBlockedReason(d.blockedReason)
      ? (`task.detail.blocked.${d.blockedReason}` as MessageKey)
      : 'task.detail.blocked.unknown'
    : null;

  const confirmCancel = () => {
    if (window.confirm(t('task.detail.action.cancelConfirm'))) act.mutate('cancel');
  };

  return (
    <section className="task-detail">
      <button type="button" className="link" onClick={onBack}>
        {t('task.detail.back')}
      </button>
      <header className="page-header page-header-row">
        <h2>{d.title}</h2>
        <span className="badge">{t(`tasks.status.${d.status}`)}</span>
        <span className={`badge priority-${d.priority}`}>{t(`tasks.priority.${d.priority}`)}</span>
        {d.isOverdue && <span className="badge badge-danger">{t('tasks.card.overdue')}</span>}
        <div className="editor-row">
          {buttons.map((action) => (
            <button
              key={action}
              type="button"
              className={action === 'cancel' ? 'danger' : undefined}
              disabled={act.isPending}
              onClick={() => (action === 'cancel' ? confirmCancel() : act.mutate(action))}
            >
              {t(`task.detail.action.${action}`)}
            </button>
          ))}
        </div>
      </header>
      {act.isError && <ErrorNotice error={act.error} />}

      {d.status === 'blocked' && blockedKey && (
        <div
          role="status"
          className="banner banner-warn"
          data-blocked-reason={d.blockedReason ?? undefined}
        >
          <strong>{t('task.detail.blocked')}:</strong> {t(blockedKey)}
        </div>
      )}

      <progress
        max={100}
        value={progress}
        aria-label={`${t('tasks.card.progress')} ${progress}%`}
      />

      <dl className="profile">
        <dt>{t('task.detail.objective')}</dt>
        <dd className="prewrap">{d.objective}</dd>
        <dt>{t('task.detail.expectedOutput')}</dt>
        <dd>{d.expectedOutput}</dd>
        <dt>{t('task.detail.assignee')}</dt>
        <dd>
          {who.assignee} ({t(`tasks.assigneeKind.${d.assigneeKind}`)}) · {who.unit}
        </dd>
        <dt>{t('task.detail.deadline')}</dt>
        <dd>{formatTime(d.deadline)}</dd>
        <dt>{t('task.form.priority')}</dt>
        <dd>{t(`tasks.priority.${d.priority}`)}</dd>
        <dt>{t('task.detail.rework')}</dt>
        <dd>{d.reworkCount}</dd>
        {(d.tokenCap !== null || d.costCap !== null) && (
          <>
            <dt>{t('task.detail.caps')}</dt>
            <dd>
              {d.tokenCap !== null && `${d.tokenCap} token`}
              {d.tokenCap !== null && d.costCap !== null && ' · '}
              {d.costCap !== null && `${d.costCap} USD`}
            </dd>
          </>
        )}
        {creator && (
          <>
            <dt>{t('task.detail.trace.created')}</dt>
            <dd>{creator}</dd>
          </>
        )}
      </dl>

      <section aria-label={t('task.detail.evidence')}>
        <h3>{t('task.detail.evidence')}</h3>
        <ul className="criteria-list">
          {criteria.map((c) => (
            <li key={c.criterionId} className={`criterion criterion-${c.verdict}`}>
              <span className="badge">
                {c.verdict === 'none'
                  ? t('task.detail.evidence.none')
                  : t(`task.detail.evidence.${c.verdict}`)}
              </span>{' '}
              {c.text}
              {c.explanation && <p className="muted prewrap">{c.explanation}</p>}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label={t('task.detail.plan')}>
        <h3>{t('task.detail.plan')}</h3>
        {d.decompositionPlan === null && <p className="muted">{t('task.detail.plan.none')}</p>}
        {d.decompositionPlan?.mode === 'confirm' && <p>{t('task.detail.plan.confirm')}</p>}
        {d.decompositionPlan?.mode === 'decompose' && <p>{t('task.detail.plan.decompose')}</p>}
        {d.subtasks.length > 0 && (
          <>
            <h4>{t('task.detail.subtasks')}</h4>
            <ul className="subtask-list">
              {d.subtasks.map((s) => (
                <li key={s.id}>
                  <button type="button" className="link" onClick={() => onOpen(s.id)}>
                    {s.title}
                  </button>{' '}
                  <span className="badge">{t(`tasks.status.${s.status}`)}</span>{' '}
                  <span className="muted">{describe(s).assignee}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {d.dependsOn.length > 0 && (
          <p className="muted">
            {t('task.detail.dependsOn')}: {d.dependsOn.length}
          </p>
        )}
      </section>

      <section aria-label={t('task.detail.artifacts')}>
        <h3>{t('task.detail.artifacts')}</h3>
        {d.artifacts.length === 0 && <p className="muted">{t('task.detail.artifacts.none')}</p>}
        <ul className="artifact-list">
          {d.artifacts.map((a) => (
            <li key={a.id}>
              <strong>{a.title}</strong>{' '}
              <span className="muted">
                {a.kind} · {a.mimeType} · {a.sizeBytes} B
              </span>{' '}
              <button
                type="button"
                className="link"
                onClick={() => setOpenArtifact(openArtifact === a.id ? null : a.id)}
              >
                {openArtifact === a.id
                  ? t('task.detail.artifacts.close')
                  : t('task.detail.artifacts.open')}
              </button>
              {openArtifact === a.id && <ArtifactViewer companyId={companyId} artifactId={a.id} />}
            </li>
          ))}
        </ul>
      </section>

      {canDecide(d) && <DecisionPanel companyId={companyId} task={d} />}

      <section aria-label={t('task.detail.reviews')}>
        <h3>{t('task.detail.reviews')}</h3>
        {d.reviews.length === 0 && <p className="muted">{t('task.detail.reviews.none')}</p>}
        <ul className="review-list">
          {d.reviews.map((r) => (
            <li key={r.id}>
              <span className="badge">{r.stage}</span> <strong>{r.decision}</strong>{' '}
              <time dateTime={r.decidedAt}>{formatTime(r.decidedAt)}</time>
              <p className="prewrap">{r.reason}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label={t('task.detail.executed')}>
        <h3>{t('task.detail.executed')}</h3>
        {actions.isSuccess && actions.data.length === 0 && (
          <p className="muted">{t('task.detail.executed.none')}</p>
        )}
        <ul>
          {(actions.data ?? []).map((a) => (
            <li key={a.toolInvocationId}>
              <code>{a.actionType}</code>{' '}
              <span className="badge">
                {a.adapterMode === 'dry_run'
                  ? t('task.detail.executed.dryRun')
                  : t('task.detail.executed.live')}
              </span>{' '}
              <span className="muted">{formatTime(a.executedAt)}</span>
            </li>
          ))}
        </ul>
      </section>

      <p>
        <Link to={`/c/${companyId}/history?task=${taskId}`}>{t('task.detail.history')}</Link>
      </p>

      <Messages companyId={companyId} taskId={taskId} />

      <section aria-label={t('task.detail.trace')}>
        <h3>{t('task.detail.trace')}</h3>
        <ol className="trace-list">
          {trace.map((step, i) => (
            <li key={`${step.kind}-${i}`}>
              <span className="badge">{t(`task.detail.trace.${step.kind}`)}</span>{' '}
              <time dateTime={step.at}>{formatTime(step.at)}</time>{' '}
              <span className="prewrap">{step.label}</span>
            </li>
          ))}
        </ol>
      </section>
    </section>
  );
}
