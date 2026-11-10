import { Link } from 'react-router';
import { t } from '../../i18n';
import { MILESTONE_LABELS } from './milestone-model';
import { useMilestoneRealtime } from './milestone-queries';

/** Thông báo nổi khi vừa đạt một Achievement (`milestone.achieved`), hiện trên mọi màn hình của công ty. */
export function MilestoneToast({ companyId }: { companyId: string }) {
  const { latest, dismiss } = useMilestoneRealtime(companyId);
  if (!latest) return null;
  return (
    <div role="status" className="banner milestone-toast" data-milestone={latest}>
      <strong>{t('milestone.new')}</strong> {t(MILESTONE_LABELS[latest].title)}{' '}
      <Link to={`/c/${companyId}/achievements`} onClick={dismiss}>
        {t('milestone.view')}
      </Link>{' '}
      <button type="button" onClick={dismiss}>
        {t('milestone.dismiss')}
      </button>
    </div>
  );
}
