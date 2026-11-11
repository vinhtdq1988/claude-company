# Contract: Danh mục ActionType và mức quyền

Nguồn: `packages/policy/src/catalog.ts`. Mọi tool cấp cho AI Employee phải ánh xạ tới một `ActionType` dưới đây; tool không ánh xạ được → `restricted` (FR-024, SC-004).

**Floor**: mức tối thiểu không thể hạ bằng cấu hình. `action_policy` của công ty chỉ được nâng mức (chặt hơn). Mức hiệu lực = max(floor, mọi policy áp dụng theo scope company → org_unit → team → employee), thứ tự chặt dần: `auto_execute < review_required < human_approval < restricted`. Trong v1.0, `action_policy` chỉ nhận dữ liệu seed, chưa có API ghi.

| ActionType | Mô tả | Mặc định | Floor | Hoàn tác được / tác động ngoài | Runtime |
|---|---|---|---|---|---|
| `workspace.read` | Đọc file/tài liệu trong workspace được cấp | auto_execute | auto_execute | Không tác động | cả hai |
| `workspace.search` | Tìm kiếm trong workspace | auto_execute | auto_execute | Không tác động | cả hai |
| `workspace.write` | Tạo/sửa file trong thư mục làm việc của run | review_required | review_required | Hoàn tác được: chỉ ghi vào bản sao theo run, không ghi vào nguồn | cả hai |
| `workspace.shell` | Chạy lệnh trong sandbox (vd. chạy test, build) | review_required | review_required | Chạy trong `sandbox-runner`, chỉ tác động thư mục của run | claude_agent_sdk |
| `workspace.test.run` | Chạy bộ test đã cấu hình | auto_execute | auto_execute | Chạy trong `sandbox-runner`, không tác động ngoài | cả hai |
| `artifact.publish` | Nộp artifact cho task | auto_execute | auto_execute | Nội bộ | cả hai |
| `task.message.post` | Gửi trao đổi trên task | auto_execute | auto_execute | Nội bộ | cả hai |
| `task.decompose.propose` | AI Manager đề xuất phân rã | auto_execute | auto_execute | Nội bộ, hệ thống kiểm tra | messages_api |
| `email.send` | Gửi email qua EmailAdapter | human_approval | **human_approval** | Tác động ngoài, không hoàn tác | cả hai |
| `data.delete` | Xóa dữ liệu qua DataDeleteAdapter | human_approval | **human_approval** | Không hoàn tác | cả hai |
| `deploy.staging` | Deploy staging qua DeployAdapter | human_approval | **human_approval** | Tác động ngoài | cả hai |
| `deploy.production` | Deploy production | human_approval | **human_approval** | Tác động ngoài | cả hai |
| `workspace.git.push` | Push lên remote | human_approval | **human_approval** | Tác động ngoài | claude_agent_sdk |
| `network.fetch` | Gọi mạng tùy ý | restricted | restricted | — | — |
| *(mọi thứ khác)* | | restricted | restricted | | |

## Hành động điều hành của CEO AI Assistant (FR-049)

Chỉ mẫu `ceo_assistant` được cấp các `ActionType` này (`tool_grants`); `buildToolSpecs` sinh tool cho các dòng có cột **Tool** là "có" và runtime `messages_api`. Phân loại bám FR-049; `floor` ngăn mọi cấu hình hạ mức. Mọi hành động điều hành chưa nằm trong bảng là `restricted`.

| ActionType | Mô tả | Mặc định | Floor | Tool | Idempotency | Ghi chú |
|---|---|---|---|---|---|---|
| `company.query` | Đọc trạng thái công ty theo `view`: `overview`, `org_chart`, `employees`, `tasks`, `blockers`, `usage`, `budget` | auto_execute | auto_execute | có | rerun | Chỉ đọc, trong phạm vi CEO; dùng cùng service với REST (số liệu khớp Dashboard, SC-017) |
| `task.create` | Tạo và giao task thay mặt CEO cho AI Employee/Team/Department | review_required | review_required | có | dedupe | `draft` hay `assigned` do nguồn tiêu chí (research R14 Decision 6); hoàn tác bằng hủy task |
| `org.unit.upsert` | Tạo/đổi tên/sắp xếp lại Division hoặc Department | review_required | review_required | có | dedupe | Không lưu trữ (xem `org.archive`) |
| `org.team.upsert` | Tạo/đổi tên/sắp xếp lại Team | review_required | review_required | có | dedupe | |
| `employee.create` | Tạo AI Employee từ mẫu vai trò với công cụ mặc định của mẫu | review_required | review_required | có | dedupe | Mẫu ≠ `ceo_assistant`; không nhận `toolGrants`, `modelId`, `managerId` |
| `employee.update` | Sửa `name`, `position`, `personality`, `skills`, `seniority`, `homeOrgUnitId`, `teamIds` | review_required | review_required | có | dedupe | Không nhắm vào chính trợ lý |
| `employee.suspend` · `employee.resume` | Tạm ngưng / kích hoạt lại nhân viên | review_required | review_required | có | dedupe | Không nhắm vào chính trợ lý |
| `org.archive` | Lưu trữ Division/Department/Team | human_approval | **human_approval** | có | dedupe | Chạy sau khi duyệt qua `InternalOpsAdapter`; vẫn bị chặn nếu còn nhân viên/task (`ORG_UNIT_NOT_EMPTY`…) |
| `employee.archive` | Lưu trữ AI Employee | human_approval | **human_approval** | có | dedupe | Không nhắm vào chính trợ lý |
| `task.cancel` | Hủy task (kể cả đang chạy) | human_approval | **human_approval** | có | dedupe | Không hủy task của chính trợ lý |
| `task.decide` | Approve/reject/rework kết quả task | restricted | restricted | không | — | Chỉ con người (FR-019, FR-049d) |
| `task.resume` | Tiếp tục hoặc hủy task `blocked`/lỗi theo quyết định escalation | restricted | restricted | không | — | Trợ lý chỉ *đề xuất* phương án trong báo cáo (FR-048d) |
| `approval.decide` | Quyết định một Approval Request | restricted | restricted | không | — | |
| `budget.update` | Đặt/nâng giới hạn token, ngân sách, đồng thời, model được phép | restricted | restricted | không | — | Trợ lý chỉ nêu cảnh báo và đề xuất (FR-048e) |
| `policy.update` | Đổi Action Policy | restricted | restricted | không | — | |
| `employee.grant_tools` | Cấp thêm công cụ/credential cho bất kỳ nhân viên nào, kể cả trợ lý | restricted | restricted | không | — | |
| `member.manage` | Gán/gỡ quyền quản lý, thêm/vô hiệu tài khoản người thật | restricted | restricted | không | — | |

Các dòng `restricted` được khai báo tường minh để `tool_invocation` ghi đúng tên hành động bị từ chối và để test SC-015 viết được từng ca; vì không có tool tương ứng, lời gọi tới tên đó (ví dụ do prompt injection) vào nhánh "tool không ánh xạ → `restricted`" ở bước 1 của ToolBroker và bị ghi ledger `denied`. `email.send` của trợ lý dùng dòng sẵn có ở bảng trên (Human Approval, adapter dry-run).

### Input schema của tool điều hành

Nằm trong `packages/contracts/src/tool-inputs.ts`, cùng cơ chế `rationale?` tách trước khi băm. Nguyên tắc: **không trường nào cho phép nâng quyền** (không `toolGrants`, `modelId`, `runtimeKind`, `systemPrompt`, `managerId`, `workspaceId`, giới hạn ngân sách, `level`, `actorId`/`memberId`).

- `company.query`: `{ view, orgUnitId?, status?, period? }`.
- `task.create`: `{ title, objective, assignee: { kind, id }, deadline, priority, expectedOutput, acceptanceCriteria: [{ text, source: "ceo_quote" | "proposed" }], tokenCap?, costCap?, dependsOn? }`; xem quy tắc nguồn tiêu chí ở research R14.
- `org.unit.upsert`: `{ id?, kind, parentId?, name, sortOrder? }`; `org.team.upsert`: `{ id?, orgUnitId, name, sortOrder? }`.
- `employee.create`: `{ roleTemplateKey, name, homeOrgUnitId, teamIds?, seniority?, personality?, skills? }`; `employee.update`: `{ employeeId, name?, position?, personality?, skills?, seniority?, homeOrgUnitId?, teamIds? }`; `employee.suspend|resume|archive`: `{ employeeId }`.
- `org.archive`: `{ targetKind: "org_unit" | "team", targetId }`; `task.cancel`: `{ taskId, reason }`.

### Cưỡng chế bổ sung cho CEO AI Assistant (bắt buộc có test trong `tests/security/`)

C1. Trước mọi tool điều hành, `company-ops` kiểm tra ngữ cảnh bằng dữ liệu hệ thống: nhân viên của run là `ceo_assistant` đang `active`, là assignee của `agent_run.task_id`, và `task.created_by_member_id` là CEO đang hoạt động; sai → `ASSISTANT_CONTEXT_INVALID`, ghi ledger `denied` (FR-050).
C2. Tool không nhận `memberId`/`actor` từ model. `RequestContext.actor.via` do handler đặt từ run; `TenantGuard` không bao giờ tạo `via`, nên không có đường HTTP nào giả mạo "thay mặt CEO".
C3. Tool nhắm vào nhân viên/task không được trùng chính trợ lý (`ASSISTANT_SELF_TARGET`) cho `employee.update|suspend|archive` và `task.cancel`.
C4. Đối tượng thuộc công ty khác hoặc không tồn tại trả `NOT_FOUND` (RLS); tên hành động ngoài bảng (Project, thông báo ngoài ứng dụng, Daily Report…) là `restricted`.
C5. Trợ lý không bao giờ là reviewer hoặc approver của kết quả (`kind = employee`; `task.decide`/`approval.decide` là `restricted`). Task của trợ lý đi đủ AI Manager xác nhận → review → Human Approval (FR-047).
C6. Số lời gọi tool ghi trong một run không vượt `ASSISTANT_MAX_OPS_PER_RUN`; vượt thì tool trả `run_locked` và task `blocked`.

## Tool cho agent

`buildToolSpecs(toolGrants, runtimeKind)` sinh `ToolSpec` cho mọi `ActionType` trong `tool_grants` có cột Runtime khớp với `runtimeKind`; `network.fetch` không bao giờ được sinh. Input schema nằm trong `packages/contracts/src/tool-inputs.ts`, kể cả các action Human Approval: `email.send` `{to[], subject, body}`, `data.delete` `{target, reason}`, `deploy.staging`, `deploy.production` `{ref, notes?}`, `workspace.git.push` `{remote, branch}`. Cả năm schema nhận thêm `rationale?` (lý do agent đề xuất, tối đa 2.000 ký tự): ToolBroker tách trường này ra TRƯỚC khi đánh giá quyền, băm và ghi ledger, nên đổi lý do không đổi hành động được duyệt; lý do chỉ hiển thị cho người duyệt như dữ liệu thuần. Lệnh `git push` đi qua `workspace.shell` được chuẩn hóa về input của `workspace.git.push` trước khi tạo approval; không chuẩn hóa được → `restricted`.

## Chống lặp sau resume hoặc retry

- `dedupe` (`artifact.publish`, `task.message.post`, `task.decompose.propose`, `email.send`, `data.delete`, `deploy.staging`, `deploy.production`, `workspace.git.push`, và mọi `ActionType` ghi của CEO AI Assistant: `task.create`, `org.unit.upsert`, `org.team.upsert`, `employee.create|update|suspend|resume|archive`, `org.archive`, `task.cancel`): `idempotency_key = sha256(task_id + rework_count + action_type + input_hash)`. Lần gọi lại cùng hành động nhận trạng thái từ ledger (`succeeded`, `pending_approval` hoặc đã bị từ chối). Bản ghi `failed` không chặn lần thử mới, key thêm hậu tố số lần thử.
- `rerun` (`workspace.read`, `workspace.search`, `workspace.write`, `workspace.shell`, `workspace.test.run`, `company.query`): `idempotency_key = run_id + step_seq`. Được phép chạy lại vì chỉ tác động worktree của run.

## Phân loại lại lệnh shell

`workspace.shell` được phân tích bằng parser AST trước khi đánh giá, theo **allowlist** tại `packages/policy/src/shell-allowlist.ts`. Không khớp allowlist nghĩa là chưa phân loại:

- Mọi lệnh trong chuỗi (`&&`, `;`, `|`, `$(...)`) đều khớp allowlist thì cả chuỗi mới là `workspace.shell`. Allowlist gồm lệnh đọc (`ls`, `cat`, `grep`, `find` không có `-delete`/`-exec`), lệnh build/test/lint đã khai báo (`pnpm test`, `npm test`, `npx vitest`, `pytest`, `tsc`, `eslint`) và `git` cục bộ (`status`, `diff`, `log`, `add`, `commit`).
- `git push` → `workspace.git.push`.
- Mọi lệnh khác → `restricted`, gồm: xóa (`rm`, `rmdir`, `git clean`, `git reset --hard`, `find -delete`, `truncate`, `dd`), CLI dữ liệu (`psql`, `redis-cli`), phát hành và triển khai (`npm publish`, `kubectl`, `docker push`, `terraform apply`), mạng (`ssh`, `scp`, `curl`, `wget`, `nc`, mail CLI), thực thi chuỗi (`python -c`, `node -e`, `sh -c`). Xóa dữ liệu phải đi qua tool `data.delete` (Human Approval).
- Không phân tích được (subshell lồng phức tạp, chuỗi base64 thực thi…) → `restricted`.
- `sandbox-runner` (không có mạng ra ngoài, không có đường tới hạ tầng nội bộ, env không có secret) là lớp chặn thứ hai.

## Quy tắc cưỡng chế (bắt buộc có test trong `tests/security/`)

1. `PermissionEngine.evaluate` không nhận text của prompt/task/tin nhắn; chỉ nhận `employeeId`, `actionType`, `input` đã chuẩn hóa (US4-AS4, SC-003).
2. Tool không nằm trong `ai_employee.tool_grants` → `restricted`, kể cả khi danh mục cho `auto_execute` (FR-027).
3. Human Approval: agent không bao giờ thực thi; hệ thống thực thi payload có `payload_hash` khớp sau khi duyệt, ở chế độ adapter hiện hành (dry-run vẫn cần duyệt – FR-025). Riêng `org.archive`, `employee.archive`, `task.cancel` (thao tác trên dữ liệu của chính ứng dụng) chạy qua `InternalOpsAdapter` với `adapter_mode = internal`: thực thi thật nhưng chỉ sau khi duyệt, chỉ với payload có `payload_hash` khớp và bằng ctx của người duyệt kèm `via`.
4. Approval không có thời hạn tự duyệt; chỉ nhắc (edge case).
5. Mọi đánh giá (kể cả `restricted`) được ghi `tool_invocation` để truy vết.
