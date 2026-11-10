import { useParams, useSearchParams } from 'react-router';
import { RunDetailPage } from './RunDetailPage';
import { RunHistoryPage } from './RunHistoryPage';

/**
 * Màn hình `/c/:companyId/history` (Execution History). Router chỉ có một route nên danh sách và chi tiết chuyển qua
 * query `?run=<runId>`; bộ lọc dùng `?task=` và `?employee=` để liên kết từ chi tiết task hoạt động và nút Back
 * của trình duyệt quay lại đúng danh sách đã lọc.
 */
export default function HistoryPage() {
  const { companyId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const runId = params.get('run');

  if (runId) {
    return (
      <RunDetailPage
        companyId={companyId}
        runId={runId}
        onBack={() => {
          const next = new URLSearchParams(params);
          next.delete('run');
          setParams(next);
        }}
      />
    );
  }
  return (
    <RunHistoryPage
      companyId={companyId}
      taskId={params.get('task')}
      employeeId={params.get('employee')}
      onFilter={(filter) => {
        const next = new URLSearchParams();
        if (filter.task) next.set('task', filter.task);
        if (filter.employee) next.set('employee', filter.employee);
        setParams(next);
      }}
      onOpen={(id) => {
        const next = new URLSearchParams(params);
        next.set('run', id);
        setParams(next);
      }}
    />
  );
}
