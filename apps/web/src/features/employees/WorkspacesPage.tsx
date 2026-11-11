import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import type { WorkspaceKind } from '@claude-company/contracts';
import { ErrorNotice } from '../../components/ErrorNotice';
import { describeError, t } from '../../i18n';
import { api } from '../../lib/api';
import { queryClient, queryKeys } from '../../lib/query';
import { useMyMembership } from '../../lib/session';
import { useWorkspaces, useWorkspaceSettings } from './employee-queries';

function AddWorkspaceForm({ companyId }: { companyId: string }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<WorkspaceKind>('git_repo');
  const [mountPath, setMountPath] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('');

  const add = useMutation({
    mutationFn: () =>
      api.post(`/companies/${companyId}/workspaces`, {
        name: name.trim(),
        kind,
        mountPath: mountPath.trim(),
        defaultBranch:
          kind === 'git_repo' && defaultBranch.trim() ? defaultBranch.trim() : undefined,
      }),
    onSuccess: async () => {
      setName('');
      setMountPath('');
      setDefaultBranch('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces(companyId) });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate();
  };

  return (
    <form className="card card-wide" onSubmit={onSubmit} aria-label={t('workspaces.add')}>
      <h3>{t('workspaces.add')}</h3>
      <label>
        {t('workspaces.name')}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
          name="workspace-name"
        />
      </label>
      <label>
        {t('workspaces.kind')}
        <select value={kind} onChange={(e) => setKind(e.target.value as WorkspaceKind)}>
          <option value="git_repo">{t('workspaces.kind.git_repo')}</option>
          <option value="docs_folder">{t('workspaces.kind.docs_folder')}</option>
        </select>
      </label>
      <label>
        {t('workspaces.mountPath')}
        <input
          value={mountPath}
          onChange={(e) => setMountPath(e.target.value)}
          required
          maxLength={512}
          name="workspace-path"
        />
      </label>
      {kind === 'git_repo' && (
        <label>
          {t('workspaces.defaultBranch')}
          <input
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
            placeholder="main"
            maxLength={128}
          />
        </label>
      )}
      {add.isError && <ErrorNotice error={add.error} />}
      <button
        type="submit"
        disabled={add.isPending || name.trim() === '' || mountPath.trim() === ''}
      >
        {t('org.editor.add')}
      </button>
    </form>
  );
}

function RootSettings({ companyId, isCeo }: { companyId: string; isCeo: boolean }) {
  const settings = useWorkspaceSettings(companyId);
  const [rootPath, setRootPath] = useState('');

  const save = useMutation({
    mutationFn: (next: string | null) =>
      api.put(`/companies/${companyId}/workspaces/settings`, { rootPath: next }),
    onSuccess: async () => {
      setRootPath('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces(companyId) });
    },
  });

  if (!settings.data) return null;
  const { rootPath: custom, effectiveRoot } = settings.data;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(rootPath.trim());
  };

  return (
    <form className="card card-wide" onSubmit={onSubmit} aria-label={t('workspaces.root.title')}>
      <h3>{t('workspaces.root.title')}</h3>
      <p className="muted">{t('workspaces.root.intro')}</p>
      <p>
        {t('workspaces.root.current')}: <code>{effectiveRoot}</code> (
        {custom ? t('workspaces.root.custom') : t('workspaces.root.default')})
      </p>
      {isCeo && (
        <>
          <label>
            {t('workspaces.root.input')}
            <input
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              maxLength={512}
              name="workspace-root"
            />
          </label>
          {save.isError && <ErrorNotice error={save.error} />}
          <button type="submit" disabled={save.isPending || rootPath.trim() === ''}>
            {t('workspaces.root.save')}
          </button>
          {custom && (
            <button type="button" disabled={save.isPending} onClick={() => save.mutate(null)}>
              {t('workspaces.root.reset')}
            </button>
          )}
        </>
      )}
    </form>
  );
}

/** Workspace đã đăng ký. Chỉ CEO thấy biểu mẫu đăng ký (server vẫn cưỡng chế bằng 403). */
export default function WorkspacesPage() {
  const { companyId = '' } = useParams();
  const workspaces = useWorkspaces(companyId);
  const isCeo = useMyMembership(companyId)?.role === 'ceo';

  if (workspaces.isPending) return <p className="loading">{t('app.loading')}</p>;
  if (workspaces.isError) {
    return (
      <p role="alert" className="error">
        {describeError(workspaces.error)}
      </p>
    );
  }

  return (
    <section className="workspaces">
      <header className="page-header">
        <h2>{t('workspaces.title')}</h2>
        <p className="muted">{t('workspaces.intro')}</p>
      </header>
      <RootSettings companyId={companyId} isCeo={isCeo} />
      {workspaces.data.length === 0 ? (
        <p className="empty">{t('workspaces.empty')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('workspaces.name')}</th>
              <th>{t('workspaces.kind')}</th>
              <th>{t('workspaces.mountPath')}</th>
              <th>{t('workspaces.defaultBranch')}</th>
            </tr>
          </thead>
          <tbody>
            {workspaces.data.map((w) => (
              <tr key={w.id}>
                <td>{w.name}</td>
                <td>{t(`workspaces.kind.${w.kind}`)}</td>
                <td>
                  <code>{w.mountPath}</code>
                </td>
                <td>{w.defaultBranch ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {isCeo && <AddWorkspaceForm companyId={companyId} />}
    </section>
  );
}
