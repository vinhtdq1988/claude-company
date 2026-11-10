import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { ApprovalRequest, ApprovalStatus } from '@claude-company/contracts';
import { describeError, t } from '../../i18n';
import { ApiError } from '../../lib/api';
import {
  actionLabelKey,
  canDecideApproval,
  formatPayload,
  normalizeReason,
  sortApprovals,
  STATUS_LABEL_KEYS,
} from './approval-model';
import {
  decideApproval,
  invalidateApprovals,
  useApprovalRealtime,
  useApprovals,
} from './approval-queries';

const STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'rejected', 'cancelled'];

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

/**
 * Một yêu cầu phê duyệt. Mọi nội dung do AI sinh ra (tóm tắt, lý do, payload) hiển thị như VĂN BẢN THUẦN, không
 * render HTML (FR-026). Cả duyệt lẫn từ chối đều bắt buộc lý do (FR-019); `payloadHash` gửi kèm là hash của đúng bản
 * đang hiển thị nên nếu nội dung đổi, server trả 409 và danh sách được tải lại.
 */
function ApprovalCard({ companyId, approval }: { companyId: string; approval: ApprovalRequest }) {
  const [reason, setReason] = useState('');
  const [missingReason, setMissingReason] = useState(false);
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      decideApproval(companyId, approval.id, {
        decision,
        reason: normalizeReason(reason) ?? '',
        payloadHash: approval.payloadHash,
      }),
    onSettled: () => invalidateApprovals(companyId),
  });

  const submit = (decision: 'approve' | 'reject') => {
    if (!normalizeReason(reason)) {
      setMissingReason(true);
      return;
    }
    setMissingReason(false);
    decide.mutate(decision);
  };

  const labelKey = actionLabelKey(approval.actionType);
  const changed =
    decide.error instanceof ApiError && decide.error.code === 'APPROVAL_PAYLOAD_CHANGED';

  return (
    <article
      className="card card-wide approval"
      data-approval-id={approval.id}
      data-status={approval.status}
    >
      <header className="page-header-row">
        <h3>{labelKey ? t(labelKey) : approval.actionType}</h3>
        <span className="badge">{t(STATUS_LABEL_KEYS[approval.status])}</span>
      </header>
      <dl className="task-facts">
        <dt>{t('approvals.field.summary')}</dt>
        <dd className="prewrap">{approval.summary}</dd>
        <dt>{t('approvals.field.rationale')}</dt>
        <dd className="prewrap">{approval.rationale || '—'}</dd>
        <dt>{t('approvals.field.employee')}</dt>
        <dd>{approval.employeeName ?? approval.employeeId}</dd>
        <dt>{t('approvals.field.task')}</dt>
        <dd>
          <Link to={`/c/${companyId}/tasks?id=${approval.taskId}`}>
            {approval.taskTitle ?? t('approvals.openTask')}
          </Link>
        </dd>
        <dt>{t('approvals.field.requestedAt')}</dt>
        <dd>
          <time dateTime={approval.createdAt}>{formatTime(approval.createdAt)}</time>
        </dd>
      </dl>

      <h4>{t('approvals.field.payload')}</h4>
      <pre className="artifact-content" data-testid="approval-payload">
        {formatPayload(approval.payload)}
      </pre>

      {canDecideApproval(approval) ? (
        <form
          className="decision"
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          <label>
            {t('approvals.field.reason')}
            <textarea
              name="reason"
              rows={3}
              value={reason}
              placeholder={t('approvals.reason.placeholder')}
              required
              aria-required="true"
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {missingReason && (
            <p role="alert" className="error">
              {t('approvals.reason.required')}
            </p>
          )}
          {decide.isError && (
            <p role="alert" className="error">
              {changed ? t('approvals.changed') : describeError(decide.error)}
            </p>
          )}
          <div className="editor-row">
            <button type="button" disabled={decide.isPending} onClick={() => submit('approve')}>
              {t('approvals.approve')}
            </button>
            <button
              type="button"
              className="danger"
              disabled={decide.isPending}
              onClick={() => submit('reject')}
            >
              {t('approvals.reject')}
            </button>
          </div>
        </form>
      ) : (
        approval.decidedAt && (
          <dl className="task-facts">
            <dt>{t('approvals.field.decidedAt')}</dt>
            <dd>
              <time dateTime={approval.decidedAt}>{formatTime(approval.decidedAt)}</time>
            </dd>
            <dt>{t('approvals.field.decisionReason')}</dt>
            <dd className="prewrap">{approval.decisionReason ?? '—'}</dd>
          </dl>
        )
      )}
    </article>
  );
}

/** Màn hình `/c/:companyId/approvals`: hộp phê duyệt Human Approval (T143, FR-026). */
export default function ApprovalsPage() {
  const { companyId = '' } = useParams();
  const [status, setStatus] = useState<ApprovalStatus>('pending');
  const approvals = useApprovals(companyId, status);
  useApprovalRealtime(companyId);

  const items = sortApprovals(approvals.data?.items ?? []);

  return (
    <section className="approvals">
      <header className="page-header">
        <h2>{t('approvals.title')}</h2>
        <p>{t('approvals.subtitle')}</p>
        <p className="banner banner-warn">{t('approvals.dryRunNotice')}</p>
      </header>

      <div className="filters">
        <label>
          {t('approvals.filter.status')}
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as ApprovalStatus)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(STATUS_LABEL_KEYS[s])}
              </option>
            ))}
          </select>
        </label>
      </div>

      {approvals.isPending && <p className="loading">{t('app.loading')}</p>}
      {approvals.isError && (
        <p role="alert" className="error">
          {describeError(approvals.error)}
        </p>
      )}
      {approvals.isSuccess && items.length === 0 && (
        <p className="empty">
          {status === 'pending' ? t('approvals.empty.pending') : t('approvals.empty.other')}
        </p>
      )}
      {items.map((approval) => (
        <ApprovalCard key={approval.id} companyId={companyId} approval={approval} />
      ))}
    </section>
  );
}
