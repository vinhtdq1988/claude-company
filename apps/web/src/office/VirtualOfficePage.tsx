import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { describeError, t } from '../i18n';
import { queryClient, queryKeys } from '../lib/query';
import { realtime, type ConnectionStatus } from '../realtime/socket';
import { EmployeeProfilePanel, stateLabel } from './EmployeeProfilePanel';
import { fetchOfficeSnapshot } from './office-queries';
import { OfficeRenderer } from './renderer-pixi/OfficeRenderer';
import { OfficeStore } from './state/office-store';

/**
 * Trang Virtual Office (T162). Luồng đồng bộ theo contracts/realtime-events.md:
 * snapshot (`seq = S`) → `realtime.resubscribe(S)` → áp sự kiện theo `seq`; mất kết nối hoặc `seq > last + 1` → nhãn
 * "Trạng thái có thể đã cũ", tải lại snapshot và tiếp tục. Trạng thái nhân vật chỉ đến từ server qua store.
 */
export default function VirtualOfficePage() {
  const { companyId = '' } = useParams();
  const store = useMemo(() => new OfficeStore(), []);
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<OfficeRenderer | null>(null);
  const [state, setState] = useState(store.getState());
  const [connection, setConnection] = useState<ConnectionStatus>(realtime.connectionStatus);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  // Gộp các lần yêu cầu tải lại chồng nhau thành một vòng kế tiếp.
  const loading = useRef(false);
  const again = useRef(false);
  const reload = useCallback(async () => {
    if (loading.current) {
      again.current = true;
      return;
    }
    loading.current = true;
    try {
      do {
        again.current = false;
        try {
          const snapshot = await fetchOfficeSnapshot(companyId);
          store.loadSnapshot(snapshot);
          setLoadError(null);
          realtime.resubscribe(snapshot.seq);
        } catch (error) {
          setLoadError(error);
          store.markStale();
        }
      } while (again.current);
    } finally {
      loading.current = false;
    }
  }, [companyId, store]);

  useEffect(() => {
    const offStore = store.subscribe(setState);
    const offStatus = realtime.onStatus(setConnection);
    const offEnvelope = realtime.onEnvelope((envelope) => {
      const result = store.apply(envelope);
      if (result === 'gap' || result === 'reload') void reload();
    });
    realtime.onResyncNeeded(() => {
      store.markStale();
      void reload();
    });
    void reload();
    return () => {
      offStore();
      offStatus();
      offEnvelope();
      realtime.onResyncNeeded(() => undefined);
    };
  }, [reload, store]);

  // Kết nối trở lại sau khi mất đồng bộ: tải snapshot mới trước khi bỏ nhãn "đã cũ".
  useEffect(() => {
    if (connection === 'live' && state.stale && !loading.current) void reload();
  }, [connection, state.stale, reload]);

  const stale = state.stale || connection !== 'live';
  const snapshot = useMemo(() => store.toSnapshot(), [store, state]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    const renderer = new OfficeRenderer();
    renderer.onSelectEmployee(setSelectedId);
    rendererRef.current = renderer;
    void renderer.mount(host).then(() => {
      if (cancelled) renderer.destroy();
      else renderer.update(store.toSnapshot(), { stale: store.getState().stale });
    });
    return () => {
      cancelled = true;
      rendererRef.current = null;
      // Nếu mount chưa xong, `then` ở trên sẽ hủy; nếu đã xong thì hủy ngay.
      if (host.querySelector('canvas')) renderer.destroy();
    };
  }, [store]);

  useEffect(() => {
    if (state.loaded) rendererRef.current?.update(snapshot, { stale });
  }, [snapshot, stale, state.loaded]);

  const selected = selectedId ? state.employees[selectedId] : undefined;
  // Mỗi lần trạng thái/task/tiến độ của nhân viên đang xem đổi, Profile tải lại để khớp (nguồn: sự kiện thật).
  const selectedKey = selected
    ? `${selected.state}|${selected.currentTaskId}|${selected.currentTool}|${selected.progress}`
    : '';
  useEffect(() => {
    if (!selectedId || !selectedKey) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.profileView(companyId, selectedId) });
  }, [companyId, selectedId, selectedKey]);

  const employees = snapshot.employees;
  return (
    <section className="office" data-seq={state.seq}>
      <header className="page-header-row">
        <h1>{t('office.title')}</h1>
        {stale && state.loaded && (
          <span role="status" className="badge badge-warn" data-testid="office-stale">
            {t('realtime.stale')}
          </span>
        )}
      </header>
      {Boolean(loadError) && (
        <p role="alert" className="banner banner-error">
          {t('office.loadError')} {describeError(loadError)}
        </p>
      )}
      <div className="office-layout">
        <div
          ref={hostRef}
          className="office-canvas"
          role="img"
          aria-label={t('office.canvasLabel')}
          data-stale={stale ? 'true' : 'false'}
        />
        <div className="office-side">
          <h2>{t('office.roster')}</h2>
          {state.loaded && employees.length === 0 ? (
            <p className="empty">{t('office.empty')}</p>
          ) : (
            <ul className="office-roster" data-testid="office-roster">
              {employees.map((e) => (
                <li key={e.id} data-employee-id={e.id} data-state={e.state}>
                  <button
                    type="button"
                    className="link-button"
                    aria-label={`${t('office.open')}: ${e.name}`}
                    onClick={() => setSelectedId(e.id)}
                  >
                    {e.name}
                  </button>
                  <span className="badge" data-testid="roster-state">
                    {stateLabel(e.state)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {selected && (
            <EmployeeProfilePanel
              companyId={companyId}
              employee={selected}
              onClose={() => setSelectedId(null)}
            />
          )}
        </div>
      </div>
    </section>
  );
}
