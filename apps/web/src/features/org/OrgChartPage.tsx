import { useState } from 'react';
import { useParams } from 'react-router';
import type { HumanMember, OrgChartNode } from '@claude-company/contracts';
import { describeError, t } from '../../i18n';
import { OrgUnitEditor } from './OrgUnitEditor';
import { useCompany, useMembers, useOrgChart } from './org-queries';
import { findTeam, findUnit, type Selection } from './org-tree';

function managerLabel(members: HumanMember[], memberId: string | null): string {
  if (!memberId) return t('org.manager.none');
  return members.find((m) => m.id === memberId)?.displayName ?? t('org.manager.none');
}

type TreeProps = {
  nodes: OrgChartNode[];
  members: HumanMember[];
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
};

/** Cây division/department/team kèm manager và số nhân viên (FR-004). */
function OrgTree({ nodes, members, selection, onSelect }: TreeProps) {
  return (
    <ul className="org-list">
      {nodes.map((node) => {
        const selected = selection?.kind === 'org_unit' && selection.id === node.id;
        return (
          <li key={node.id}>
            <button
              type="button"
              className={`org-item${selected ? ' selected' : ''}`}
              aria-pressed={selected}
              onClick={() => onSelect({ kind: 'org_unit', id: node.id })}
            >
              <span className="badge">{t(`org.kind.${node.kind}`)}</span>
              <strong>{node.name}</strong>
              <span className="muted">
                {t('org.manager')}: {managerLabel(members, node.managerMemberId)} ·{' '}
                {node.employeeCount} {t('org.employeeCount')}
              </span>
            </button>
            {(node.teams.length > 0 || node.children.length > 0) && (
              <ul className="org-list">
                {node.teams.map((team) => {
                  const teamSelected = selection?.kind === 'team' && selection.id === team.id;
                  return (
                    <li key={team.id}>
                      <button
                        type="button"
                        className={`org-item org-team${teamSelected ? ' selected' : ''}`}
                        aria-pressed={teamSelected}
                        onClick={() => onSelect({ kind: 'team', id: team.id })}
                      >
                        <span className="badge badge-team">{t('org.teams')}</span>
                        <strong>{team.name}</strong>
                        <span className="muted">
                          {t('org.manager')}: {managerLabel(members, team.managerMemberId)} ·{' '}
                          {team.employeeCount} {t('org.employeeCount')}
                        </span>
                      </button>
                    </li>
                  );
                })}
                {node.children.length > 0 && (
                  <li>
                    <OrgTree
                      nodes={node.children}
                      members={members}
                      selection={selection}
                      onSelect={onSelect}
                    />
                  </li>
                )}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Sơ đồ tổ chức hiện tại của công ty; chọn một mục để chỉnh sửa ở khung bên cạnh. */
export default function OrgChartPage() {
  const { companyId = '' } = useParams();
  const chart = useOrgChart(companyId);
  const members = useMembers(companyId);
  const company = useCompany(companyId);
  const [selection, setSelection] = useState<Selection | null>(null);

  if (chart.isPending) return <p className="loading">{t('app.loading')}</p>;
  if (chart.isError) {
    return (
      <p role="alert" className="error">
        {describeError(chart.error)}
      </p>
    );
  }

  const memberList = members.data ?? [];
  // Mục đã bị xóa hoặc ra ngoài phạm vi sau khi tải lại thì bỏ chọn.
  const stillThere =
    selection &&
    (selection.kind === 'org_unit'
      ? findUnit(chart.data, selection.id)
      : findTeam(chart.data, selection.id));
  const activeSelection = stillThere ? selection : null;

  return (
    <section className="org">
      <header className="page-header">
        <h2>{t('org.title')}</h2>
        {company.data && <p className="muted">{company.data.name}</p>}
      </header>
      <div className="org-layout">
        <div className="org-tree" aria-label={t('org.title')}>
          {chart.data.roots.length === 0 ? (
            <p className="empty">{t('org.empty')}</p>
          ) : (
            <OrgTree
              nodes={chart.data.roots}
              members={memberList}
              selection={activeSelection}
              onSelect={setSelection}
            />
          )}
        </div>
        <OrgUnitEditor
          companyId={companyId}
          chart={chart.data}
          members={memberList}
          selection={activeSelection}
          onSelect={setSelection}
        />
      </div>
    </section>
  );
}
