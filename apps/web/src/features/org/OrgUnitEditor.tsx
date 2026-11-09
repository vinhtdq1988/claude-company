import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { HumanMember, OrgChart, OrgUnitKind } from '@claude-company/contracts';
import { ErrorNotice } from '../../components/ErrorNotice';
import { t } from '../../i18n';
import { api } from '../../lib/api';
import { queryClient, queryKeys } from '../../lib/query';
import { TeamMembersPanel } from './TeamMembersPanel';
import {
  findTeam,
  findUnit,
  flattenUnits,
  moveWithin,
  sortOrderChanges,
  unitSiblings,
  type Selection,
} from './org-tree';

type EditorProps = {
  companyId: string;
  chart: OrgChart;
  members: HumanMember[];
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
};

/** Mutation ghi cơ cấu: thành công thì tải lại sơ đồ. */
function useOrgMutation<TVars>(
  companyId: string,
  mutationFn: (vars: TVars) => Promise<unknown>,
  onSuccess?: () => void,
) {
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.orgChart(companyId) });
      onSuccess?.();
    },
  });
}

function AddUnitForm({ companyId, chart }: Pick<EditorProps, 'companyId' | 'chart'>) {
  const [kind, setKind] = useState<OrgUnitKind>('department');
  const [parentId, setParentId] = useState('');
  const [name, setName] = useState('');
  const divisions = flattenUnits(chart.roots).filter((n) => n.kind === 'division');

  const add = useOrgMutation(
    companyId,
    () =>
      api.post(`/companies/${companyId}/org-units`, {
        kind,
        parentId: parentId || null,
        name: name.trim(),
      }),
    () => setName(''),
  );

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate(undefined);
  };

  return (
    <form onSubmit={onSubmit} className="editor-form" aria-label={t('org.editor.addUnit')}>
      <h4>{t('org.editor.addUnit')}</h4>
      <label>
        {t('org.editor.kind')}
        <select value={kind} onChange={(e) => setKind(e.target.value as OrgUnitKind)}>
          <option value="department">{t('org.kind.department')}</option>
          <option value="division">{t('org.kind.division')}</option>
        </select>
      </label>
      <label>
        {t('org.editor.parent')}
        <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
          <option value="">{t('org.editor.parent.none')}</option>
          {divisions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('org.editor.name')}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
          name="unit-name"
        />
      </label>
      {add.isError && <ErrorNotice error={add.error} />}
      <button type="submit" disabled={add.isPending || name.trim() === ''}>
        {t('org.editor.add')}
      </button>
    </form>
  );
}

function AddTeamForm({ companyId, chart }: Pick<EditorProps, 'companyId' | 'chart'>) {
  const departments = flattenUnits(chart.roots).filter((n) => n.kind === 'department');
  const [chosen, setChosen] = useState('');
  const [name, setName] = useState('');
  const orgUnitId = chosen || departments[0]?.id || '';

  const add = useOrgMutation(
    companyId,
    () => api.post(`/companies/${companyId}/teams`, { orgUnitId, name: name.trim() }),
    () => setName(''),
  );

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate(undefined);
  };

  return (
    <form onSubmit={onSubmit} className="editor-form" aria-label={t('org.editor.addTeam')}>
      <h4>{t('org.editor.addTeam')}</h4>
      <label>
        {t('org.editor.department')}
        <select value={orgUnitId} onChange={(e) => setChosen(e.target.value)}>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('org.editor.name')}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
          name="team-name"
        />
      </label>
      {add.isError && <ErrorNotice error={add.error} />}
      <button type="submit" disabled={add.isPending || name.trim() === '' || orgUnitId === ''}>
        {t('org.editor.add')}
      </button>
    </form>
  );
}

type PanelProps = Pick<EditorProps, 'companyId' | 'chart' | 'members' | 'onSelect'> & {
  selection: Selection;
};

/** Chỉnh sửa mục đang chọn: đổi tên, sắp xếp, gán manager, lưu trữ. Dùng `key` theo id để reset form. */
function SelectedPanel({ companyId, chart, members, selection, onSelect }: PanelProps) {
  const isUnit = selection.kind === 'org_unit';
  const unit = isUnit ? findUnit(chart, selection.id) : undefined;
  const teamEntry = isUnit ? undefined : findTeam(chart, selection.id);
  const current = unit ?? teamEntry?.team;
  const [name, setName] = useState(current?.name ?? '');
  const base = `/companies/${companyId}/${isUnit ? 'org-units' : 'teams'}`;

  const rename = useOrgMutation(companyId, () =>
    api.patch(`${base}/${selection.id}`, { name: name.trim() }),
  );
  const move = useOrgMutation(companyId, async (direction: -1 | 1) => {
    const siblings: Array<{ id: string; sortOrder: number }> = isUnit
      ? unitSiblings(chart, selection.id)
      : (teamEntry?.unit.teams ?? []);
    const moved = moveWithin(siblings, selection.id, direction);
    if (!moved) return;
    for (const change of sortOrderChanges(moved)) {
      await api.patch(`${base}/${change.id}`, { sortOrder: change.sortOrder });
    }
  });
  const assign = useOrgMutation(companyId, (managerMemberId: string) =>
    api.put(`/companies/${companyId}/management-assignments`, {
      targetKind: selection.kind,
      targetId: selection.id,
      managerMemberId,
    }),
  );
  const archive = useOrgMutation(
    companyId,
    () => api.delete(`${base}/${selection.id}`),
    () => onSelect(null),
  );

  if (!current) return <p className="empty">{t('org.selectHint')}</p>;

  const onRename = (event: FormEvent) => {
    event.preventDefault();
    rename.mutate(undefined);
  };
  const onArchive = () => {
    if (window.confirm(t('org.editor.archiveConfirm'))) archive.mutate(undefined);
  };
  const error = rename.error ?? move.error ?? assign.error ?? archive.error;

  return (
    <div className="editor-panel">
      <h4>
        {t('org.selected')}: {current.name}
      </h4>
      <form onSubmit={onRename} className="editor-form">
        <label>
          {t('org.editor.name')}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            name="rename"
          />
        </label>
        <button
          type="submit"
          disabled={rename.isPending || name.trim() === '' || name.trim() === current.name}
        >
          {t('org.editor.rename')}
        </button>
      </form>
      <div className="editor-row">
        <button type="button" onClick={() => move.mutate(-1)} disabled={move.isPending}>
          {t('org.editor.moveUp')}
        </button>
        <button type="button" onClick={() => move.mutate(1)} disabled={move.isPending}>
          {t('org.editor.moveDown')}
        </button>
      </div>
      <label className="editor-form">
        {t('org.editor.assignManager')}
        <select
          value={(unit ?? teamEntry?.team)?.managerMemberId ?? ''}
          onChange={(e) => e.target.value && assign.mutate(e.target.value)}
          disabled={assign.isPending}
        >
          <option value="">{t('org.manager.none')}</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
              {m.title ? ` – ${m.title}` : ''}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="danger" onClick={onArchive} disabled={archive.isPending}>
        {t('org.editor.archive')}
      </button>
      {error && <ErrorNotice error={error} hint={t('org.editor.cannotArchive')} />}
    </div>
  );
}

/** Khung chỉnh sửa cơ cấu: thêm, đổi tên, sắp xếp, xóa đơn vị/team và gán manager (FR-002, FR-005). */
export function OrgUnitEditor(props: EditorProps) {
  const { companyId, chart, members, selection, onSelect } = props;
  return (
    <aside className="org-editor" aria-label={t('org.editor.title')}>
      <h3>{t('org.editor.title')}</h3>
      {selection ? (
        <>
          <SelectedPanel
            key={`${selection.kind}:${selection.id}`}
            companyId={companyId}
            chart={chart}
            members={members}
            selection={selection}
            onSelect={onSelect}
          />
          {selection.kind === 'team' && (
            <TeamMembersPanel
              key={`members:${selection.id}`}
              companyId={companyId}
              chart={chart}
              humanMembers={members}
              teamId={selection.id}
            />
          )}
        </>
      ) : (
        <p className="muted">{t('org.selectHint')}</p>
      )}
      <AddUnitForm companyId={companyId} chart={chart} />
      <AddTeamForm companyId={companyId} chart={chart} />
    </aside>
  );
}
