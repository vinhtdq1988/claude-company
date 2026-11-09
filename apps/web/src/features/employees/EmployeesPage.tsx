import { useParams, useSearchParams } from 'react-router';
import { EmployeeDetailPage } from './EmployeeDetailPage';
import { EmployeeForm } from './EmployeeForm';
import { EmployeeListPage } from './EmployeeListPage';

/**
 * Màn hình `/c/:companyId/employees`. Router chỉ có một route nên danh sách, biểu mẫu tuyển dụng
 * và hồ sơ chuyển qua query `?new=1` và `?id=<employeeId>`, để quay lại bằng nút Back của trình duyệt.
 */
export default function EmployeesPage() {
  const { companyId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const id = params.get('id');
  const creating = params.get('new') === '1';

  const toList = () => setParams({});
  if (creating) {
    return (
      <section>
        <EmployeeForm
          companyId={companyId}
          onCancel={toList}
          onDone={(saved) => (saved ? setParams({ id: saved.id }) : toList())}
        />
      </section>
    );
  }
  if (id) return <EmployeeDetailPage companyId={companyId} employeeId={id} onBack={toList} />;
  return (
    <EmployeeListPage
      companyId={companyId}
      onOpen={(employeeId) => setParams({ id: employeeId })}
      onNew={() => setParams({ new: '1' })}
    />
  );
}
