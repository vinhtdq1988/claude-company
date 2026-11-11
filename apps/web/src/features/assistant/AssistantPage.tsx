import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { TaskPriority } from '@claude-company/contracts';
import { ErrorNotice } from '../../components/ErrorNotice';
import { describeError, t } from '../../i18n';
import { ApiError } from '../../lib/api';
import { useRoleTemplates } from '../employees/employee-queries';
import {
  createAssistant,
  sendAssistantRequest,
  useAssistantRequests,
  useCeoAssistant,
} from './assistant-queries';

const PRIORITIES: readonly TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

/**
 * Màn hình CEO AI Assistant (US9, chỉ CEO): tạo trợ lý từ mẫu, gửi yêu cầu điều hành bằng ngôn ngữ tự nhiên và theo dõi
 * các yêu cầu đã gửi cùng trạng thái đề xuất. Trợ lý không thay thế AI Manager hay Human Approval (FR-046).
 */
export default function AssistantPage() {
  const { companyId = '' } = useParams();
  const state = useCeoAssistant(companyId);
  const templates = useRoleTemplates();
  const assistant = state.data?.assistant ?? null;
  const requests = useAssistantRequests(companyId, assistant?.id);

  const [goal, setGoal] = useState('');
  const [priority, setPriority] = useState<TaskPriority | ''>('');
  const [deadline, setDeadline] = useState('');

  const create = useMutation({
    mutationFn: () => {
      const template = templates.data?.find((x) => x.key === 'ceo_assistant');
      if (!template) throw new Error('Không tìm thấy mẫu ceo_assistant');
      return createAssistant(companyId, template);
    },
  });
  const send = useMutation({
    mutationFn: () =>
      sendAssistantRequest(companyId, {
        goal: goal.trim(),
        ...(priority ? { priority } : {}),
        ...(deadline ? { deadline: new Date(deadline).toISOString() } : {}),
      }),
    onSuccess: () => {
      setGoal('');
      setPriority('');
      setDeadline('');
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (goal.trim()) send.mutate();
  };

  // 409 CEO_ASSISTANT_REQUIRED: trợ lý chưa có, đang tạm ngưng hoặc đã lưu trữ.
  const required = send.error instanceof ApiError && send.error.code === 'CEO_ASSISTANT_REQUIRED';
  const forbidden = state.error instanceof ApiError && state.error.status === 403;

  return (
    <section className="assistant">
      <header className="page-header-row">
        <h2>{t('assistant.title')}</h2>
        {assistant && <span className="badge">{t(`employees.status.${assistant.status}`)}</span>}
      </header>
      <p className="muted">{t('assistant.hint')}</p>

      {state.isPending && <p className="loading">{t('app.loading')}</p>}
      {state.isError && (
        <p role="alert" className="error">
          {forbidden ? t('assistant.forbidden') : describeError(state.error)}
        </p>
      )}

      {state.isSuccess && !assistant && (
        <div className="banner" role="status">
          <p>{t('assistant.none')}</p>
          <button
            type="button"
            disabled={!state.data.canCreate || create.isPending || !templates.data}
            onClick={() => create.mutate()}
          >
            {create.isPending ? t('assistant.create.pending') : t('assistant.create')}
          </button>
          {create.isError && <ErrorNotice error={create.error} />}
        </div>
      )}

      {assistant && (
        <>
          <dl className="profile">
            <dt>{t('assistant.name')}</dt>
            <dd>
              <Link to={`/c/${companyId}/employees?id=${assistant.id}`}>{assistant.name}</Link>
            </dd>
            <dt>{t('assistant.model')}</dt>
            <dd>
              <code>{assistant.modelId}</code>
            </dd>
          </dl>
          {assistant.status !== 'active' && (
            <p role="alert" className="banner banner-warn">
              {t('assistant.notActive')}
            </p>
          )}

          <form className="assistant-request" onSubmit={onSubmit} aria-label={t('assistant.request.title')}>
            <h3>{t('assistant.request.title')}</h3>
            <label>
              {t('assistant.request.goal')}
              <textarea
                rows={4}
                value={goal}
                maxLength={20000}
                placeholder={t('assistant.request.placeholder')}
                onChange={(e) => setGoal(e.target.value)}
                required
              />
            </label>
            <div className="form-grid">
              <label>
                {t('assistant.request.priority')}
                <select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority | '')}>
                  <option value="">{t('assistant.request.auto')}</option>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {t(`tasks.priority.${p}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('assistant.request.deadline')}
                <input
                  type="datetime-local"
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                />
              </label>
            </div>
            <button type="submit" disabled={send.isPending || !goal.trim()}>
              {t('assistant.request.send')}
            </button>
            {send.isError && (
              <p role="alert" className="error">
                {required ? t('assistant.required') : describeError(send.error)}
              </p>
            )}
            {send.isSuccess && (
              <p role="status" className="muted">
                {t('assistant.request.sent')}
              </p>
            )}
          </form>

          <section aria-label={t('assistant.requests')}>
            <h3>{t('assistant.requests')}</h3>
            {requests.isSuccess && requests.data.length === 0 && (
              <p className="muted">{t('assistant.requests.none')}</p>
            )}
            <ul className="assistant-requests">
              {(requests.data ?? []).map((task) => (
                <li key={task.id} data-proposal={task.proposalStatus ?? 'none'}>
                  <Link to={`/c/${companyId}/tasks?id=${task.id}`}>{task.title}</Link>{' '}
                  <span className="badge">{t(`tasks.status.${task.status}`)}</span>{' '}
                  {task.proposalStatus && (
                    <span className="badge">{t(`assistant.proposal.${task.proposalStatus}`)}</span>
                  )}{' '}
                  <time className="muted" dateTime={task.createdAt}>
                    {formatTime(task.createdAt)}
                  </time>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </section>
  );
}
