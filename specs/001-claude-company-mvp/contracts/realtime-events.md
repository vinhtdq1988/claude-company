# Contract: Realtime events (Socket.IO)

- Namespace: `/realtime`. Handshake dùng cookie session; không hợp lệ → ngắt kết nối.
- Client gửi `subscribe { companyId }`; server kiểm tra membership rồi join `company:{companyId}`; tự động join `user:{memberId}` cho notification.
- Mọi sự kiện có envelope:

```ts
type RealtimeEnvelope<T> = {
  seq: number;          // tăng dần, liên tục theo company (từ domain_event.seq)
  companyId: string;
  type: string;
  occurredAt: string;   // ISO 8601
  payload: T;
};
```

## Đồng bộ và độ tin cậy (FR-037)

1. Client gọi `GET /office/snapshot` → nhận `seq = S`.
2. Kết nối socket, gửi `subscribe { companyId, sinceSeq: S }`; server phát lại sự kiện `> S` còn trong buffer (giữ ≥ 10 phút) hoặc trả `resync_required`.
3. Nhận sự kiện có `seq > last + 1` trên room công ty hoặc mất kết nối → UI hiển thị "Trạng thái có thể đã cũ", tải lại snapshot, tiếp tục từ bước 2.
4. Server không bao giờ phát trạng thái không có `domain_event` nguồn.
5. Mỗi `domain_event.seq` phát ít nhất một envelope trên room `company:{id}`. Event không có payload công khai hoặc không đổi trạng thái phát `sync.seq_advanced {}`. Nhiều envelope của cùng một event dùng chung `seq`. Room `user:{id}` không kiểm tra `seq` liên tục.

## Sự kiện phát tới room `company:{id}`

Server lọc theo `ManagedScope` của từng socket trước khi phát (FR-005, FR-028), kể cả khi phát lại theo `sinceSeq`; client không tham gia cưỡng chế. Sự kiện ngoài phạm vi được thay bằng `sync.seq_advanced {}` cùng `seq` để không tạo khoảng trống. `office.layout_changed` và `milestone.achieved` phát cho mọi thành viên; các sự kiện khác xét theo `employeeId` hoặc `assigneeKind`/`assigneeId`. Scope của socket được tính lại khi có sự kiện `org_unit.*`, `team.*`, `management.assigned`, `employee.*`. Payload chứa dữ liệu nhạy cảm (nội dung task, payload approval) không đi qua kênh công ty – client tải qua REST có kiểm tra quyền.

| type | payload |
|---|---|
| `office.employee_status_changed` | `{ employeeId, state, previousState, currentTaskId?, currentTool?, progress?, sourceEventType }` |
| `office.layout_changed` | `{ reason: "org_unit_created"|"org_unit_updated"|"org_unit_archived"|"employee_added"|"employee_updated"|"employee_moved"|"employee_removed" }` → client tải lại snapshot (T155 mở rộng danh sách lý do để hồ sơ và vị trí nhân viên mới cũng cập nhật được) |
| `task.status_changed` | `{ taskId, from, to, assigneeKind, assigneeId, isOverdue }` |
| `task.progress` | `{ taskId, employeeId, progress }` |
| `run.step_appended` | `{ runId, taskId, employeeId, seq, kind }` |
| `usage.updated` | `{ employeeId, taskId, tokensDelta, costDelta }` |
| `milestone.achieved` | `{ key }` |
| `sync.seq_advanced` | `{}`: chỉ giữ `seq` liên tục, client không đổi trạng thái |

## Sự kiện phát tới room `user:{memberId}`

| type | payload |
|---|---|
| `notification.created` | `{ notificationId, type, title, taskId?, approvalRequestId? }` |
| `approval.requested` | `{ approvalRequestId, taskId, employeeId, actionType }` |
| `approval.decided` | `{ approvalRequestId, decision }` |

`approval.requested` và `approval.decided` chỉ tới `user:{approverMemberId}`. `approval.cancelled` (task rời `in_progress` hoặc bị hủy) và `approval.reassigned` (người duyệt bị vô hiệu) là `domain_event` không có envelope riêng: chúng chỉ giữ `seq` qua `sync.seq_advanced`, client làm mới hộp phê duyệt khi nhận `task.status_changed`. Tương tự, `budget.policy_changed` `{ scopeKind, scopeId }` (lưu chính sách ngân sách, T168) không có envelope riêng, chỉ giữ `seq` qua `sync.seq_advanced`; `TaskFlowListener` dùng nó để lập lịch lại task đang chờ slot.

## Ánh xạ domain event → trạng thái nhân viên (Office Simulation Engine)

Reducer thuần, có unit test cho từng dòng (SC-006). Nhân viên có nhiều task: mỗi task một track; trạng thái hiển thị theo hạng `error_blocked` > `waiting_approval` > `working`/`thinking`/`communicating` > `completed`, cùng hạng thì lấy sự kiện gần nhất. `employee.suspended` thắng mọi track (`break`). `progress` đổi (từ `task.progress`) cũng phát `office.employee_status_changed` (cùng `state`).

| Domain event | Trạng thái mới |
|---|---|
| `run.started` (purpose execute) | `working` |
| `run.model_call_started` | `thinking` |
| `run.tool_call_started` | `working` (ghi `currentTool`) |
| `run.started` (purpose decompose/review/synthesize) hoặc AI gửi `task_message` trong run đang chạy của mình (payload `task.message_posted` có `runId`) | `communicating` (tin nhắn ngoài run thì không đổi: không có sự kiện nào kết thúc trạng thái đó) |
| `approval.requested` | `waiting_approval` |
| `approval.decided` (chưa đổi); `run.resumed` sau đó | `working` |
| `run.succeeded` (purpose execute; task sau đó sang `in_review`) | `completed` (giữ 60 giây rồi `idle` qua sự kiện `office.completed_display_elapsed` `{employeeId, taskId, sinceSeq}` do job `office.completed-elapsed` ghi `domain_event`; chỉ xóa đúng lần `sinceSeq`). `run.succeeded` của decompose/review/synthesize không để lại trạng thái |
| `run.failed` / `run.timed_out` / `task.status_changed` sang `blocked` (assignee là AI Employee) | `error_blocked` cho tới khi task rời `blocked` (hoặc bị hủy/hoàn tất) hoặc run mới bắt đầu trên task đó. `run.cancelled` không xóa dấu hiệu lỗi |
| `employee.suspended` | `break` |
| `employee.resumed`, không còn run hoạt động | `idle` (lỗi `EMPLOYEE_SUSPENDED` do chính việc tạm ngưng được xóa; lỗi khác vẫn giữ) |
| (Phase 4) `meeting.*` | `meeting` – chưa phát trong v1.0 |
