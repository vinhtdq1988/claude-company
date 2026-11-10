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

## Tool cho agent

`buildToolSpecs(toolGrants, runtimeKind)` sinh `ToolSpec` cho mọi `ActionType` trong `tool_grants` có cột Runtime khớp với `runtimeKind`; `network.fetch` không bao giờ được sinh. Input schema nằm trong `packages/contracts/src/tool-inputs.ts`, kể cả các action Human Approval: `email.send` `{to[], subject, body}`, `data.delete` `{target, reason}`, `deploy.staging`, `deploy.production` `{ref, notes?}`, `workspace.git.push` `{remote, branch}`. Cả năm schema nhận thêm `rationale?` (lý do agent đề xuất, tối đa 2.000 ký tự): ToolBroker tách trường này ra TRƯỚC khi đánh giá quyền, băm và ghi ledger, nên đổi lý do không đổi hành động được duyệt; lý do chỉ hiển thị cho người duyệt như dữ liệu thuần. Lệnh `git push` đi qua `workspace.shell` được chuẩn hóa về input của `workspace.git.push` trước khi tạo approval; không chuẩn hóa được → `restricted`.

## Chống lặp sau resume hoặc retry

- `dedupe` (`artifact.publish`, `task.message.post`, `task.decompose.propose`, `email.send`, `data.delete`, `deploy.staging`, `deploy.production`, `workspace.git.push`): `idempotency_key = sha256(task_id + rework_count + action_type + input_hash)`. Lần gọi lại cùng hành động nhận trạng thái từ ledger (`succeeded`, `pending_approval` hoặc đã bị từ chối). Bản ghi `failed` không chặn lần thử mới, key thêm hậu tố số lần thử.
- `rerun` (`workspace.read`, `workspace.search`, `workspace.write`, `workspace.shell`, `workspace.test.run`): `idempotency_key = run_id + step_seq`. Được phép chạy lại vì chỉ tác động worktree của run.

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
3. Human Approval: agent không bao giờ thực thi; hệ thống thực thi payload có `payload_hash` khớp sau khi duyệt, ở chế độ adapter hiện hành (dry-run vẫn cần duyệt – FR-025).
4. Approval không có thời hạn tự duyệt; chỉ nhắc (edge case).
5. Mọi đánh giá (kể cả `restricted`) được ghi `tool_invocation` để truy vết.
