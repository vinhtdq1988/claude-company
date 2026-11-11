import { Link } from 'react-router';
import type { TaskOperation } from '@claude-company/contracts';
import { describeError, t, type MessageKey } from '../../i18n';
import { useTaskOperations } from './assistant-queries';

/** Trạng thái chưa xong: nổi bật để CEO chọn `resume` (bỏ qua phần đã xong nhờ ledger) hoặc `cancel`. */
const UNFINISHED: ReadonlySet<string> = new Set(['failed', 'unknown', 'executing', 'pending']);

const STATUS_KEYS: Readonly<Record<string, MessageKey>> = {
  succeeded: 'assistant.ops.status.succeeded',
  failed: 'assistant.ops.status.failed',
  unknown: 'assistant.ops.status.unknown',
  executing: 'assistant.ops.status.executing',
  pending: 'assistant.ops.status.pending',
  pending_approval: 'assistant.ops.status.pending_approval',
  denied: 'assistant.ops.status.denied',
};

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

type Props = { companyId: string; taskId: string };

/** Một dòng thao tác; chỉ `adapterMode = dry_run` mới hiện nhãn "dry-run" (thao tác nội bộ chạy thật sau khi duyệt). */
export function OperationRow({ companyId, op }: { companyId: string; op: TaskOperation }) {
  const unfinished = UNFINISHED.has(op.status);
  return (
    <li
      data-status={op.status}
      data-unfinished={unfinished ? 'true' : 'false'}
      className={unfinished ? 'operation operation-unfinished' : 'operation'}
    >
      <code>{op.actionType}</code>{' '}
      <span className="badge">{op.permissionLevel}</span>{' '}
      <span className={unfinished || op.status === 'denied' ? 'badge badge-danger' : 'badge'}>
        {t(STATUS_KEYS[op.status] ?? 'assistant.ops.status.unknown')}
      </span>{' '}
      {op.adapterMode === 'dry_run' && <span className="badge">{t('task.detail.executed.dryRun')}</span>}
      {op.adapterMode === 'internal' && (
        <span className="badge">{t('task.detail.executed.internal')}</span>
      )}
      <p className="prewrap">{op.summary}</p>
      {op.targetId && (
        <p className="muted">
          {op.targetKind}: <code>{op.targetId}</code>
        </p>
      )}
      {op.approvalRequestId && (
        <p>
          <Link to={`/c/${companyId}/approvals?id=${op.approvalRequestId}`}>
            {t('assistant.ops.approval')}
          </Link>
        </p>
      )}
      {op.executedAt && (
        <time className="muted" dateTime={op.executedAt}>
          {formatTime(op.executedAt)}
        </time>
      )}
      {unfinished && <p className="muted">{t('assistant.ops.unfinished')}</p>}
    </li>
  );
}

/**
 * Thao tác điều hành của CEO AI Assistant trên task (`GET /tasks/{id}/operations`): hành động, mức quyền, trạng thái,
 * đối tượng và liên kết Approval Request. Thao tác chưa xong được nổi bật để CEO chọn `resume` hoặc `cancel`.
 */
export function OperationsList({ companyId, taskId }: Props) {
  const operations = useTaskOperations(companyId, taskId);
  if (operations.isPending) return <p className="loading">{t('app.loading')}</p>;
  if (operations.isError) {
    return (
      <p role="alert" className="error">
        {describeError(operations.error)}
      </p>
    );
  }
  if (operations.data.length === 0) return null;
  return (
    <section aria-label={t('assistant.ops.title')}>
      <h3>{t('assistant.ops.title')}</h3>
      <p className="muted">{t('assistant.ops.byAssistant')}</p>
      <ul className="operations">
        {operations.data.map((op) => (
          <OperationRow key={op.toolInvocationId} companyId={companyId} op={op} />
        ))}
      </ul>
    </section>
  );
}
