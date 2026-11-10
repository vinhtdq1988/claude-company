import { useParams } from 'react-router';
import { describeError, t } from '../../i18n';
import { MILESTONE_LABELS, buildAchievements } from './milestone-model';
import { useMilestones } from './milestone-queries';

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Màn hình Achievement (US8): các cột mốc cơ bản của công ty. Chỉ cấp từ sự kiện nghiệp vụ thật, không tính theo
 * token hay thời lượng chạy; không thay thế đánh giá năng suất (FR-045), nên màn hình nói rõ điều đó.
 */
export default function MilestonesPage() {
  const { companyId = '' } = useParams();
  const milestones = useMilestones(companyId);
  const items = buildAchievements(milestones.data ?? []);
  const earned = items.filter((i) => i.achievedAt !== null).length;

  return (
    <section>
      <header className="page-header-row">
        <h2>{t('milestone.title')}</h2>
        {milestones.isSuccess && (
          <span className="badge">
            {earned}/{items.length}
          </span>
        )}
      </header>
      <p className="muted">{t('milestone.hint')}</p>

      {milestones.isPending && <p className="loading">{t('app.loading')}</p>}
      {milestones.isError && (
        <p role="alert" className="error">
          {describeError(milestones.error)}
        </p>
      )}
      {milestones.isSuccess && (
        <ul className="achievements" aria-label={t('milestone.title')}>
          {items.map((item) => {
            const labels = MILESTONE_LABELS[item.key];
            return (
              <li
                key={item.key}
                className={item.achievedAt ? 'achievement achieved' : 'achievement locked'}
                data-milestone={item.key}
                data-achieved={item.achievedAt ? 'true' : 'false'}
              >
                <h3>{t(labels.title)}</h3>
                <p className="muted">{t(labels.how)}</p>
                {item.achievedAt ? (
                  <p>
                    <span className="badge">{t('milestone.achieved')}</span>{' '}
                    <time dateTime={item.achievedAt}>{formatTime(item.achievedAt)}</time>
                  </p>
                ) : (
                  <p className="muted">{t('milestone.locked')}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
