import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { HumanMember, MemberRef, OrgChart } from '@claude-company/contracts';
import { ErrorNotice } from '../../components/ErrorNotice';
import { t } from '../../i18n';
import { api } from '../../lib/api';
import { invalidateEmployees, useEmployees } from '../employees/employee-queries';
import { findTeam } from './org-tree';

type Props = {
  companyId: string;
  chart: OrgChart;
  humanMembers: HumanMember[];
  teamId: string;
};

const keyOf = (m: MemberRef) => `${m.kind}:${m.id}`;

/**
 * Gán AI Employee và người thật vào Team (FR-007: một nhân viên thuộc nhiều Team).
 * Thành viên hiện tại lấy từ sơ đồ tổ chức; lưu thay toàn bộ danh sách, nên người đã có được giữ nguyên.
 */
export function TeamMembersPanel({ companyId, chart, humanMembers, teamId }: Props) {
  const employees = useEmployees(companyId);
  const current = findTeam(chart, teamId)?.team.members ?? [];
  const [selected, setSelected] = useState(() => new Set(current.map(keyOf)));
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () => {
      const members: MemberRef[] = [...selected].map((key) => {
        const [kind, id] = key.split(':') as [MemberRef['kind'], string];
        return { kind, id };
      });
      return api.put(`/companies/${companyId}/teams/${teamId}/members`, { members });
    },
    onSuccess: async () => {
      setSaved(true);
      await invalidateEmployees(companyId);
    },
  });

  const toggle = (member: MemberRef) => {
    setSaved(false);
    setSelected((prev) => {
      const next = new Set(prev);
      const key = keyOf(member);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  const ai = (employees.data ?? []).filter((e) => e.status !== 'archived');
  const empty = ai.length === 0 && humanMembers.length === 0;

  return (
    <form className="editor-form" onSubmit={onSubmit} aria-label={t('org.team.members.title')}>
      <h4>{t('org.team.members.title')}</h4>
      {empty && <p className="muted">{t('org.team.members.none')}</p>}
      {ai.length > 0 && (
        <fieldset className="choices">
          <legend>{t('org.team.members.ai')}</legend>
          {ai.map((e) => (
            <label key={e.id} className="choice">
              <input
                type="checkbox"
                checked={selected.has(keyOf({ kind: 'ai', id: e.id }))}
                onChange={() => toggle({ kind: 'ai', id: e.id })}
              />
              <span>{e.name}</span>
            </label>
          ))}
        </fieldset>
      )}
      {humanMembers.length > 0 && (
        <fieldset className="choices">
          <legend>{t('org.team.members.human')}</legend>
          {humanMembers.map((m) => (
            <label key={m.id} className="choice">
              <input
                type="checkbox"
                checked={selected.has(keyOf({ kind: 'human', id: m.id }))}
                onChange={() => toggle({ kind: 'human', id: m.id })}
              />
              <span>{m.displayName}</span>
            </label>
          ))}
        </fieldset>
      )}
      {save.isError && <ErrorNotice error={save.error} />}
      {saved && <p className="muted">{t('org.team.members.saved')}</p>}
      <button type="submit" disabled={save.isPending}>
        {t('org.team.members.save')}
      </button>
    </form>
  );
}
