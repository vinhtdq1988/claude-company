import { describeError } from '../i18n';
import { ApiError } from '../lib/api';
import { blockerLines } from '../features/org/org-tree';

/**
 * Lỗi từ API. Khi bị chặn bởi ràng buộc nghiệp vụ (409/422) kèm danh sách cản trở trong `details`
 * (đơn vị còn nhân viên, nhân viên còn task, người thật cuối chuỗi quản lý…), hiển thị danh sách đó
 * để người dùng biết cần xử lý gì; `hint` là câu dẫn cho danh sách.
 */
export function ErrorNotice({ error, hint }: { error: unknown; hint?: string }) {
  const lines =
    error instanceof ApiError && (error.status === 409 || error.status === 422)
      ? blockerLines(error.details)
      : [];
  return (
    <div role="alert" className="error">
      <p>{describeError(error)}</p>
      {lines.length > 0 && (
        <>
          {hint && <p>{hint}</p>}
          <ul>
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
