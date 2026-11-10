import { useParams, useSearchParams } from 'react-router';
import { TaskBoardPage } from './TaskBoardPage';
import { TaskDetailPage } from './TaskDetailPage';
import { TaskForm } from './TaskForm';

/**
 * Màn hình `/c/:companyId/tasks` (Task Center). Router chỉ có một route nên Task Board, biểu mẫu tạo task và
 * chi tiết task chuyển qua query `?new=1` và `?id=<taskId>`, để nút Back của trình duyệt và liên kết từ thông
 * báo (`?id=`) đều hoạt động.
 */
export default function TaskCenterPage() {
  const { companyId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const id = params.get('id');
  const creating = params.get('new') === '1';

  const toBoard = () => setParams({});
  if (creating) {
    return (
      <section>
        <TaskForm
          companyId={companyId}
          onCancel={toBoard}
          onDone={(created) => setParams({ id: created.id })}
        />
      </section>
    );
  }
  if (id) {
    return (
      <TaskDetailPage
        companyId={companyId}
        taskId={id}
        onBack={toBoard}
        onOpen={(taskId) => setParams({ id: taskId })}
      />
    );
  }
  return (
    <TaskBoardPage
      companyId={companyId}
      onOpen={(taskId) => setParams({ id: taskId })}
      onNew={() => setParams({ new: '1' })}
    />
  );
}
