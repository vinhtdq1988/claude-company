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
| `office.layout_changed` | `{ reason: "org_unit_created"|"org_unit_archived"|"employee_moved" }` → client tải lại snapshot |
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

## Ánh xạ domain event → trạng thái nhân viên (Office Simulation Engine)

Reducer thuần, có unit test cho từng dòng (SC-006). Nhân viên có nhiều task: trạng thái theo run đang hoạt động gần nhất; ưu tiên `error_blocked` > `waiting_approval` > `working`/`thinking`.

| Domain event | Trạng thái mới |
|---|---|
| `run.started` (purpose execute) | `working` |
| `run.model_call_started` | `thinking` |
| `run.tool_call_started` | `working` (ghi `currentTool`) |
| `run.started` (purpose decompose/review/synthesize) hoặc AI Manager gửi `task_message` | `communicating` |
| `approval.requested` | `waiting_approval` |
| `approval.decided` → run resume | `working` |
| `run.succeeded` + task sang `in_review`/`completed` | `completed` (giữ 60 giây rồi `idle` qua sự kiện `office.completed_display_elapsed` do server phát có ghi `domain_event`) |
| `run.failed` / `run.timed_out` / `task.blocked` | `error_blocked` |
| `employee.suspended` | `break` |
| `employee.resumed`, không còn run hoạt động | `idle` |
| (Phase 4) `meeting.*` | `meeting` – chưa phát trong v1.0 |
