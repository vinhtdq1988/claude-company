# Contract: REST API (`apps/api`)

Base path: `/api/v1`. JSON. Schema chi tiết là Zod trong `packages/contracts` (nguồn sự thật; OpenAPI sinh tự động từ đó).

## Quy ước chung

- **Xác thực**: cookie session `cc_sid` (HttpOnly). Mọi endpoint trừ `/auth/register`, `/auth/login` trả `401` nếu chưa đăng nhập (FR-030).
- **CSRF**: request ghi (POST/PUT/PATCH/DELETE) gửi header `X-CSRF-Token`, trừ `/auth/register` và `/auth/login` vì lúc đó chưa có session để cấp token.
- **Tenant**: mọi đường dẫn tài nguyên nằm dưới `/companies/{companyId}`. Không phải thành viên → `404` (không tiết lộ tồn tại). Thành viên nhưng ngoài phạm vi quản lý → `403` (FR-028, SC-012).
- **Lỗi**: `{ "error": { "code": "TASK_INVALID_TRANSITION", "message": "...", "details": {} } }`. Mã lỗi nghiệp vụ dùng `409` (xung đột trạng thái/ràng buộc) hoặc `422` (validation).
- **Phân trang**: `?cursor=&limit=` (mặc định 50, tối đa 200) → `{ items, nextCursor }`.

## Auth

| Method | Path | Mô tả |
|---|---|---|
| POST | `/auth/register` | `{email, password, displayName}` → tạo user + session |
| POST | `/auth/login` | `{email, password}` |
| POST | `/auth/logout` | |
| GET | `/auth/me` | user + danh sách membership (company, role) + `csrfToken` |

## Organization

| Method | Path | Mô tả / Lỗi chính |
|---|---|---|
| POST | `/companies` | `{name, templateKey?}` → company; người tạo thành CEO; `templateKey="software_company"` sinh Development/BA/QA (US1-AS1) |
| GET | `/companies/{cid}` | |
| GET | `/org-templates` | danh sách template |
| GET | `/companies/{cid}/org-chart` | cây division/department/team + manager + số nhân viên (FR-004) |
| POST | `/companies/{cid}/org-units` | `{kind, parentId?, name}` |
| PATCH | `/companies/{cid}/org-units/{id}` | `{name?, parentId?, sortOrder?}` |
| DELETE | `/companies/{cid}/org-units/{id}` | archive; `409 ORG_UNIT_NOT_EMPTY` kèm danh sách nhân viên/task (US1-AS4) |
| POST/PATCH/DELETE | `/companies/{cid}/teams[/{id}]` | tương tự; `409 TEAM_NOT_EMPTY` |
| PUT | `/companies/{cid}/teams/{id}/members` | `{members:[{kind,id}]}` |
| PUT | `/companies/{cid}/management-assignments` | `{targetKind, targetId, managerMemberId}` (FR-005); `targetKind` là `org_unit` hoặc `team`. Manager của AI Employee đặt qua `PATCH /employees/{id}` |
| GET | `/companies/{cid}/members` | human_member |
| POST | `/companies/{cid}/members` | CEO: `{email, role, title?}`, email phải là tài khoản đã đăng ký |
| DELETE | `/companies/{cid}/members/{id}` | CEO: vô hiệu; `422 MANAGEMENT_CHAIN_INVALID` nếu là người thật cuối của một chuỗi quản lý AI |

## Employees

| Method | Path | Mô tả / Lỗi chính |
|---|---|---|
| GET | `/role-templates` | mẫu AI Developer, AI BA, AI QA, AI Manager |
| GET | `/companies/{cid}/employees` | lọc `orgUnitId, teamId, kind, status` |
| POST | `/companies/{cid}/employees` | body `EmployeeProfileInput`; `422 MANAGER_REQUIRED` (US2-AS2); `422 MANAGEMENT_CHAIN_INVALID`; `422 MODEL_NOT_ALLOWED` (US6-AS5) |
| GET | `/companies/{cid}/employees/{id}` | `EmployeeProfile` |
| PATCH | `/companies/{cid}/employees/{id}` | đổi model chỉ ảnh hưởng nhân viên này (US2-AS3) |
| POST | `/companies/{cid}/employees/{id}/suspend` · `/resume` | |
| DELETE | `/companies/{cid}/employees/{id}` | archive; `409 EMPLOYEE_HAS_OPEN_TASKS` kèm danh sách (US2-AS4) |
| GET | `/companies/{cid}/employees/{id}/profile-view` | dữ liệu Employee Profile cho Virtual Office (FR-038): status, currentTask+progress, currentTool, recentMessages, latestResults, reviewHistory, usage (tokens/cost tháng này + tổng), blockers |
| GET | `/companies/{cid}/workspaces` · POST | đăng ký workspace (CEO) |

## Tasks

| Method | Path | Mô tả / Lỗi chính |
|---|---|---|
| GET | `/companies/{cid}/tasks` | Task Board: lọc `status, assigneeKind, assigneeId, orgUnitId, priority, overdue, deadlineBefore` (FR-021) |
| POST | `/companies/{cid}/tasks` | `{title, objective, assignee:{kind,id}, deadline, priority, acceptanceCriteria[], expectedOutput, tokenCap?, costCap?, dependsOn?[]}`; `422 TASK_FIELDS_REQUIRED`; `403 ASSIGNEE_OUT_OF_SCOPE` (US3-AS6). Tạo ở `draft`, `?assign=true` chuyển `assigned` |
| GET | `/companies/{cid}/tasks/{id}` | chi tiết + subtasks + dependencies + decomposition plan + artifacts + evidence + reviews |
| POST | `/companies/{cid}/tasks/{id}/transitions` | `{action: "assign"|"cancel"|"resume", reason?}` – các chuyển trạng thái do người dùng kích hoạt; chuyển không hợp lệ → `409 TASK_INVALID_TRANSITION`; `resume` task cha có task con bị hủy → `409 SUBTASK_CANCELLED`; `resume` khi assignee còn `suspended` → `409 EMPLOYEE_SUSPENDED` |
| GET | `/companies/{cid}/tasks/{id}/executed-actions` | `[{toolInvocationId, actionType, adapterMode, status, executedAt}]`: hành động nhạy cảm đã thực thi của task, UI gắn nhãn "dry-run" theo `adapterMode` |
| POST | `/companies/{cid}/tasks/{id}/decisions` | Human Manager: `{decision: "approve"|"reject"|"rework", reason}`, `reason` bắt buộc với mọi quyết định, thiếu → `422`; chỉ ở `awaiting_human_approval`; `409 EVIDENCE_INCOMPLETE` (US3-AS5) |
| GET | `/companies/{cid}/tasks/{id}/messages` · POST | trao đổi gắn task (FR-022); tin nhắn người gửi tới AI được đưa vào run kế tiếp như dữ liệu |
| GET | `/companies/{cid}/artifacts/{id}/content` | stream nội dung (kiểm tra scope task) |

## Approvals (Human Approval)

| Method | Path | Mô tả |
|---|---|---|
| GET | `/companies/{cid}/approvals?status=pending` | hộp phê duyệt: action, summary, rationale, payload, employee, task (FR-026) |
| POST | `/companies/{cid}/approvals/{id}/decision` | `{decision:"approve"|"reject", reason, payloadHash}` – `payloadHash` phải khớp bản người duyệt đã xem, sai → `409 APPROVAL_PAYLOAD_CHANGED`; thiếu reason → `422` |

## Execution history

| Method | Path | Mô tả |
|---|---|---|
| GET | `/companies/{cid}/runs?taskId=&employeeId=` | danh sách agent_run trong scope (US7-AS4) |
| GET | `/companies/{cid}/runs/{id}` | steps, tool invocations (mức quyền, kết quả), lỗi, thời gian, usage (US7-AS1) |

## Budget & Dashboard

| Method | Path | Mô tả |
|---|---|---|
| GET/PUT | `/companies/{cid}/budget-policies/{scopeKind}/{scopeId}` | giới hạn token/cost/concurrency/allowedModels (FR-031); `scopeKind = ai_employee` không nhận concurrency (đặt qua `PATCH /employees/{id}`), gửi kèm → `422` |
| GET | `/companies/{cid}/usage?groupBy=employee|task|org_unit&period=YYYY-MM` | chỉ dữ liệu trong phạm vi người xem |
| GET | `/companies/{cid}/dashboard?orgUnitId=` | totalEmployees, activeTasks, completedTasks, onTimeCompletionRate, tokens, costUsd (FR-040); chỉ tổng hợp trong phạm vi người xem, `orgUnitId` ngoài phạm vi → `403` |
| GET | `/models` | danh sách model cấu hình + giá |

## Office, Notifications, Milestones

| Method | Path | Mô tả |
|---|---|---|
| GET | `/companies/{cid}/office/snapshot` | Chỉ gồm nhân viên trong phạm vi người xem. `OfficeSnapshot { seq, zones[], employees[{id, name, avatarKey, zoneId, deskIndex, state, currentTaskId, progress}] }` |
| GET | `/companies/{cid}/notifications?unread=true` | |
| POST | `/companies/{cid}/notifications/{id}/read` · `/read-all` | |
| GET | `/companies/{cid}/milestones` | |
