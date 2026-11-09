import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { Company } from '@claude-company/contracts';
import { describeError, t } from '../../i18n';
import { api } from '../../lib/api';
import { queryClient, queryKeys } from '../../lib/query';
import { useOrgTemplates } from './org-queries';

/** Tạo công ty: đặt tên, chọn cơ cấu mẫu hoặc tự thiết kế từ trống (US1-AS1). */
export default function OnboardingPage() {
  const navigate = useNavigate();
  const templates = useOrgTemplates();
  const [name, setName] = useState('');
  // null = chưa chọn: mặc định theo cơ cấu mẫu đầu tiên, rỗng = tự thiết kế.
  const [choice, setChoice] = useState<string | null>(null);
  const templateKey = choice ?? templates.data?.[0]?.key ?? '';

  const create = useMutation({
    mutationFn: () =>
      api.post<Company>('/companies', {
        name: name.trim(),
        templateKey: templateKey || undefined,
      }),
    onSuccess: async (company) => {
      // Cập nhật membership trước khi vào /c/:companyId, nếu không route sẽ đẩy ngược về trang gốc.
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
      navigate(`/c/${company.id}/org`, { replace: true });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <section className="page-narrow">
      <form onSubmit={onSubmit} className="card card-wide" aria-labelledby="onboarding-title">
        <h2 id="onboarding-title">{t('onboarding.title')}</h2>
        <p className="muted">{t('onboarding.intro')}</p>
        <label>
          {t('onboarding.companyName')}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            autoComplete="organization"
          />
        </label>
        <fieldset className="choices">
          <legend>{t('onboarding.template')}</legend>
          {templates.data?.map((template) => (
            <label key={template.key} className="choice">
              <input
                type="radio"
                name="template"
                value={template.key}
                checked={templateKey === template.key}
                onChange={() => setChoice(template.key)}
              />
              {template.name}
            </label>
          ))}
          <label className="choice">
            <input
              type="radio"
              name="template"
              value=""
              checked={templateKey === ''}
              onChange={() => setChoice('')}
            />
            {t('onboarding.template.blank')}
          </label>
        </fieldset>
        {create.isError && (
          <p role="alert" className="error">
            {describeError(create.error)}
          </p>
        )}
        <button type="submit" disabled={create.isPending || name.trim() === ''}>
          {t('onboarding.submit')}
        </button>
      </form>
    </section>
  );
}
