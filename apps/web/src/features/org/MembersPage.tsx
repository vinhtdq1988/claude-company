import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import type { HumanMember, HumanRole } from '@claude-company/contracts';
import { ErrorNotice } from '../../components/ErrorNotice';
import { describeError, t } from '../../i18n';
import { api } from '../../lib/api';
import { queryClient, queryKeys } from '../../lib/query';
import { useMyMembership } from '../../lib/session';
import { useMembers } from './org-queries';

function AddMemberForm({ companyId }: { companyId: string }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<HumanRole>('manager');
  const [title, setTitle] = useState('');

  const add = useMutation({
    mutationFn: () =>
      api.post(`/companies/${companyId}/members`, {
        email: email.trim(),
        role,
        title: title.trim() || undefined,
      }),
    onSuccess: async () => {
      setEmail('');
      setTitle('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.members(companyId) });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate();
  };

  return (
    <form className="card card-wide" onSubmit={onSubmit} aria-label={t('members.add')}>
      <h3>{t('members.add')}</h3>
      <label>
        {t('members.email')}
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          name="member-email"
        />
      </label>
      <label>
        {t('members.role')}
        <select value={role} onChange={(e) => setRole(e.target.value as HumanRole)}>
          <option value="manager">{t('members.role.manager')}</option>
          <option value="ceo">{t('members.role.ceo')}</option>
        </select>
      </label>
      <label>
        {t('members.roleTitle')}
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      </label>
      {add.isError && <ErrorNotice error={add.error} />}
      <button type="submit" disabled={add.isPending || email.trim() === ''}>
        {t('org.editor.add')}
      </button>
    </form>
  );
}

/** Người thật của công ty. Chỉ CEO thấy biểu mẫu thêm và nút vô hiệu (server vẫn cưỡng chế bằng 403). */
export default function MembersPage() {
  const { companyId = '' } = useParams();
  const members = useMembers(companyId);
  const mine = useMyMembership(companyId);
  const isCeo = mine?.role === 'ceo';

  const deactivate = useMutation({
    mutationFn: (member: HumanMember) => api.delete(`/companies/${companyId}/members/${member.id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.members(companyId) }),
  });

  const onDeactivate = (member: HumanMember) => {
    if (window.confirm(t('members.deactivateConfirm'))) deactivate.mutate(member);
  };

  if (members.isPending) return <p className="loading">{t('app.loading')}</p>;
  if (members.isError) {
    return (
      <p role="alert" className="error">
        {describeError(members.error)}
      </p>
    );
  }

  return (
    <section className="members">
      <header className="page-header">
        <h2>{t('members.title')}</h2>
        <p className="muted">{t('members.intro')}</p>
      </header>
      {members.data.length === 0 ? (
        <p className="empty">{t('members.empty')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('employees.col.name')}</th>
              <th>{t('members.role')}</th>
              <th>{t('members.roleTitle')}</th>
              {isCeo && <th />}
            </tr>
          </thead>
          <tbody>
            {members.data.map((m) => (
              <tr key={m.id}>
                <td>{m.displayName}</td>
                <td>{t(`members.role.${m.role}`)}</td>
                <td>{m.title ?? '—'}</td>
                {isCeo && (
                  <td>
                    <button
                      type="button"
                      className="danger"
                      disabled={deactivate.isPending}
                      onClick={() => onDeactivate(m)}
                    >
                      {t('members.deactivate')}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {deactivate.isError && (
        <ErrorNotice error={deactivate.error} hint={t('members.cannotDeactivate')} />
      )}
      {isCeo && <AddMemberForm companyId={companyId} />}
    </section>
  );
}
