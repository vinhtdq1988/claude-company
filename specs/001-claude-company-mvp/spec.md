# Feature Specification: Claude Company v1.0 (MVP) – Công ty AI ảo vận hành thật

**Feature Branch**: `001-claude-company-mvp`

**Created**: 2026-11-09

**Status**: Draft

**Phase (Lộ trình MVP)**: Phase 1 (Company, Department, Employee, Organization) + Phase 2 (AI Employee, AI Manager, Task Assignment, CEO AI Assistant) + Phase 3 (Virtual Office, Animation, Realtime). Phase 4–6 nằm ngoài phạm vi v1.0 (xem mục Assumptions). Ngoại lệ có chủ đích: review theo từng task (FR-018, FR-019, FR-022, do Nguyên tắc II bắt buộc ngay từ Phase 2) và cột mốc Achievement cơ bản (FR-045, Nguyên tắc VIII cho phép gamification ở mức tối thiểu). Company/Department/Team Chat và XP/Level vẫn ngoài phạm vi.

**Input**: User description: "Triển khai dự án v1.0"

## Clarifications

### Session 2026-11-09

- Q: Trong v1.0, AI Employee được cấp những nhóm công cụ thật nào để thực thi task? → A: Công cụ workspace (đọc/ghi tài liệu, mã nguồn, chạy test) cộng với các hành động nhạy cảm kiểm thử được (gửi email, xóa dữ liệu, deploy) qua adapter cấu hình được, mặc định sandbox/dry-run, luôn đi qua Human Approval.
- Q: Thông báo cho người quản lý (task hoàn thành, lỗi, cần phê duyệt) được gửi qua kênh nào trong v1.0? → A: Chỉ thông báo trong ứng dụng (realtime + hộp thông báo có trạng thái đã đọc/chưa đọc); email, push và webhook ngoài phạm vi v1.0.
- Q: Task đi qua những trạng thái (vòng đời) nào, và chuyển trạng thái theo thứ tự nào, từ lúc tạo đến Completed? → A: Draft → Assigned → In Progress → In Review (AI Manager kiểm tra) → Awaiting Human Approval → Completed; từ In Review hoặc Awaiting Human Approval có thể quay lại In Progress (Rework); thêm Blocked/Error và Cancelled; Overdue là cờ kèm theo, không phải trạng thái riêng.
- Q: Ngân sách và giới hạn token của một phạm vi được tính theo chu kỳ nào? → A: Theo tháng lịch (tự đặt lại đầu tháng) cho mỗi phạm vi, cộng với trần tùy chọn trên từng task.
- Q: Khi một hành động thuộc mức quyền Review Required, ai là người xem xét và hành động có bị tạm dừng cho đến khi xem xét xong không? → A: Hành động được thực hiện ngay; kết quả bắt buộc được AI Manager hoặc reviewer độc lập xem xét ở bước In Review; hành động thuộc mức này phải hoàn tác được hoặc không có tác động ra ngoài.
- Q: Task giao trực tiếp cho một AI Employee có đi qua AI Manager không, và ai review artifact tổng hợp của task cha? → A: Có. Mọi task đều qua bước AI Manager xác nhận phân công hoặc chia việc trước khi chạy (Nguyên tắc II). Artifact tổng hợp chỉ do một AI Manager khác tác nhân đã tổng hợp review; không có thì task Blocked.
- Q: "Tiếp tục" sau khi Human Manager reject nghĩa là gì? → A: Task về In Progress với một run mới nhận lý do từ chối; kết quả đã bị từ chối không được phê duyệt lại.
- Q: v1.0 có hỗ trợ chuyển giao task của nhân viên sắp lưu trữ không? → A: Không. Người quản lý hủy task hoặc chờ task hoàn tất.

## User Scenarios & Testing *(mandatory)*

<!--
  Mỗi user story là một lát cắt có thể kiểm thử độc lập. Thứ tự ưu tiên phản ánh thứ tự phase
  trong Product Concept (mục 11) và Nguyên tắc VIII của Constitution.
-->

### User Story 1 - Dựng công ty ảo và cơ cấu tổ chức (Priority: P1)

Một người thật (CEO/Manager) tạo công ty của mình, dựng cơ cấu tổ chức gồm Division, Department, Team (có thể bắt đầu từ cơ cấu mẫu của một công ty phần mềm với ba phòng ban Development, BA, QA, hoặc tự thiết kế), rồi xem sơ đồ tổ chức và chỉ định người thật quản lý từng phòng ban/team.

**Why this priority**: Đây là nền móng (Phase 1). Không có công ty và cơ cấu tổ chức thì không có nơi để tuyển nhân viên, giao việc hay phân quyền. Mọi story còn lại phụ thuộc vào story này.

**Independent Test**: Có thể kiểm thử đầy đủ bằng cách tạo một công ty mới, áp dụng cơ cấu mẫu (Development, BA, QA), đổi tên một phòng ban, thêm một Team, rồi mở sơ đồ tổ chức và thấy đúng cấu trúc đã dựng cùng người quản lý của từng đơn vị.

**Acceptance Scenarios**:

1. **Given** người dùng đã đăng nhập và chưa có công ty, **When** họ tạo một công ty và chọn cơ cấu mẫu công ty phần mềm, **Then** hệ thống tạo công ty với ba phòng ban Development, BA, QA và hiển thị đúng trong sơ đồ tổ chức.
2. **Given** công ty đã có cơ cấu mẫu, **When** người dùng thêm, đổi tên hoặc xóa một Department/Team/Division, **Then** thay đổi được phản ánh ngay trong sơ đồ tổ chức; cơ cấu mẫu không hề ràng buộc việc tùy chỉnh.
3. **Given** một phòng ban chưa có người quản lý, **When** CEO gán một người thật làm manager của phòng ban đó, **Then** phạm vi xem, giao việc và review của người đó được giới hạn đúng trong phòng ban được gán.
4. **Given** một phòng ban đang có nhân viên hoặc task đang chạy, **When** người dùng cố xóa phòng ban, **Then** hệ thống chặn thao tác và nêu rõ cần xử lý nhân viên/task trước.

---

### User Story 2 - Tuyển và cấu hình AI Employee (Priority: P1)

Người dùng tạo AI Employee theo mẫu vai trò (ví dụ AI Developer, AI Business Analyst, AI QA Engineer, AI Manager) hoặc tùy chỉnh hoàn toàn: đặt tên/avatar, chức danh, phòng ban, tính cách, kỹ năng và cấp bậc, model AI, chỉ dẫn vai trò, công cụ được phép dùng và người quản lý trực tiếp. Cơ cấu MVP gồm khoảng 5–10 AI Employee.

**Why this priority**: AI Employee là giá trị cốt lõi của sản phẩm (Phase 2). Nếu không có nhân viên AI được cấu hình đúng thì không có công việc nào được thực hiện.

**Independent Test**: Có thể kiểm thử bằng cách tạo ít nhất một AI Employee từ mẫu và một từ cấu hình tùy chỉnh, kiểm tra hồ sơ hiển thị đủ các thuộc tính, và xác nhận mỗi nhân viên có một manager trực tiếp.

**Acceptance Scenarios**:

1. **Given** công ty có phòng ban Development, **When** người dùng tạo AI Employee từ mẫu "AI Developer", **Then** hồ sơ được điền sẵn các thuộc tính hợp lý (kỹ năng, công cụ, chỉ dẫn vai trò) và người dùng chỉnh sửa được trước khi lưu.
2. **Given** người dùng đang tạo một AI Employee, **When** họ không chọn manager trực tiếp, **Then** hệ thống không cho lưu và yêu cầu chọn một manager (người thật hoặc AI).
3. **Given** một AI Employee đã tồn tại, **When** người dùng đổi model AI của nhân viên đó, **Then** chỉ nhân viên đó bị ảnh hưởng, các nhân viên khác và dữ liệu lịch sử giữ nguyên.
4. **Given** một AI Employee đang có task chưa hoàn tất, **When** người dùng cố xóa nhân viên, **Then** hệ thống chặn và yêu cầu hủy task hoặc chờ task hoàn tất trước khi xóa; v1.0 chưa hỗ trợ chuyển giao task.
5. **Given** một AI Employee thuộc nhiều Team, **When** số task đồng thời của nhân viên đạt giới hạn, **Then** task mới không được giao thêm mà được xếp hàng hoặc báo cho người quản lý.

---

### User Story 3 - Giao việc và nhận kết quả thực thi thật (Priority: P1)

Human Manager tạo task với mục tiêu, deadline, priority, tiêu chí nghiệm thu và đầu ra mong đợi, rồi giao cho một AI Employee, một Team hoặc một Department. Với mục tiêu giao cho Team/Department, AI Manager phân tích, chia nhỏ và giao cho nhân viên phù hợp. Với task giao trực tiếp cho AI Employee, AI Manager xác nhận phân công hoặc chia nhỏ trước khi chạy. AI Employee thực hiện thật và trả về artifact kiểm chứng được. AI Manager kiểm tra đối chiếu tiêu chí nghiệm thu, sau đó Human Manager phê duyệt, từ chối hoặc yêu cầu làm lại.

**Why this priority**: Đây là khoảnh khắc chứng minh sản phẩm là "lực lượng lao động AI thật" chứ không phải màn trình diễn (Nguyên tắc I). Cùng với US1 và US2, đây là lõi của MVP.

**Independent Test**: Có thể kiểm thử bằng cách giao một task thật (ví dụ "phân tích tài liệu yêu cầu và viết báo cáo" cho AI BA, công ty đã có AI Manager), theo dõi qua bước AI Manager xác nhận đến khi có artifact, rồi phê duyệt; kiểm tra task chỉ chuyển Completed khi có bằng chứng đối chiếu tiêu chí nghiệm thu.

**Acceptance Scenarios**:

1. **Given** Human Manager có AI Employee trong phạm vi quản lý, **When** họ tạo task đầy đủ trường bắt buộc và giao trực tiếp cho nhân viên, **Then** AI Manager phụ trách xác nhận phân công hoặc chia việc trước, sau đó nhân viên nhận task, thực hiện và trả về artifact có thể mở xem; tiến độ hiển thị theo thời gian.
2. **Given** một mục tiêu được giao cho Development Team, **When** AI Manager nhận mục tiêu, **Then** AI Manager đề xuất danh sách task con kèm assignee và phụ thuộc, và người dùng thấy được phân rã này.
3. **Given** AI Employee đã nộp kết quả, **When** AI Manager kiểm tra thấy chưa đạt tiêu chí nghiệm thu, **Then** task quay lại AI Employee kèm lý do yêu cầu làm lại và lần làm lại được ghi nhận.
4. **Given** kết quả đã được AI Manager xác nhận, **When** Human Manager phê duyệt, từ chối hoặc yêu cầu làm lại, **Then** quyết định được lưu kèm người thực hiện, thời điểm và lý do; chỉ phê duyệt mới đưa task sang Completed.
5. **Given** task thiếu bằng chứng hoàn thành đối chiếu tiêu chí nghiệm thu, **When** có yêu cầu đánh dấu Completed, **Then** hệ thống từ chối.
6. **Given** người dùng không thuộc phạm vi quản lý của một nhân viên, **When** họ cố giao task cho nhân viên đó, **Then** hệ thống từ chối.
7. **Given** một task giao trực tiếp cho AI Employee và công ty không có AI Manager nào đang hoạt động, **When** hệ thống xử lý task, **Then** task chuyển Blocked với lý do rõ ràng, người quản lý được báo và không run thực thi nào được bắt đầu.

---

### User Story 4 - Kiểm soát quyền hạn và phê duyệt hành động nhạy cảm (Priority: P1)

Mỗi hành động của AI Employee thuộc đúng một trong bốn mức quyền: Auto Execute, Review Required, Human Approval, Restricted. Hành động nhạy cảm (gửi email, xóa dữ liệu, deploy – nhất là lên production) luôn cần Human Approval. Người dùng xem và xử lý các yêu cầu phê duyệt chờ duyệt, nhìn thấy rõ AI định làm gì và vì sao.

**Why this priority**: Giao việc cho AI chỉ an toàn khi quyền hạn rõ ràng và được cưỡng chế (Nguyên tắc II, NON-NEGOTIABLE). Story này phải có trước khi cho AI chạy việc thật.

**Independent Test**: Có thể kiểm thử bằng cách cấu hình một AI Employee, yêu cầu nó thực hiện một hành động nhạy cảm (ví dụ gửi email), và xác nhận hành động bị giữ ở trạng thái chờ cho đến khi người có thẩm quyền phê duyệt; hành động chưa phân loại phải bị từ chối.

**Acceptance Scenarios**:

1. **Given** AI Employee đang thực hiện task, **When** nó cần thực hiện hành động thuộc mức Auto Execute trong phạm vi được cấp, **Then** hành động diễn ra không cần can thiệp và vẫn được ghi nhận.
2. **Given** AI Employee cần gửi email hoặc xóa dữ liệu hoặc deploy, **When** hành động được kích hoạt, **Then** hệ thống tạo yêu cầu Human Approval, tạm dừng hành động, đưa nhân viên vào trạng thái Waiting Approval và thông báo cho người duyệt.
3. **Given** một hành động chưa được phân loại mức quyền, **When** AI Employee cố thực hiện, **Then** hành động được xử lý như Restricted và bị từ chối.
4. **Given** nội dung đầu vào hoặc chỉ dẫn trong task cố ép AI bỏ qua phê duyệt, **When** AI Employee thực hiện, **Then** chính sách quyền hạn vẫn được cưỡng chế bởi hệ thống và hành động nhạy cảm vẫn cần Human Approval.
5. **Given** một yêu cầu phê duyệt đang chờ, **When** người có thẩm quyền từ chối kèm lý do, **Then** hành động không được thực hiện, task giữ In Progress, run tiếp tục với lý do từ chối được đưa cho AI Employee, và quyết định được ghi lại.

---

### User Story 5 - Quan sát công ty vận hành trong Virtual Office (Priority: P2)

Người dùng mở Virtual Office – không gian 2D phong cách pixel art – và thấy mỗi AI Employee là một nhân vật ở đúng khu vực phòng ban của mình, với trạng thái thay đổi theo thời gian thực dựa trên hoạt động thật. Nhấp vào nhân vật để mở Employee Profile.

**Why this priority**: Đây là giao diện chính và điểm khác biệt của sản phẩm (Phase 3, "Work as Play"), nhưng chỉ có ý nghĩa khi US2–US4 đã tạo ra hoạt động thật để phản ánh.

**Independent Test**: Có thể kiểm thử bằng cách mở Virtual Office khi một task đang chạy, xác nhận nhân vật chuyển sang Working/Thinking/Waiting Approval đúng lúc có sự kiện tương ứng, và Employee Profile hiển thị đúng task hiện tại và tiến độ.

**Acceptance Scenarios**:

1. **Given** công ty có phòng ban và nhân viên, **When** người dùng mở Virtual Office, **Then** mỗi phòng ban có một khu vực và mỗi nhân viên là một nhân vật đặt đúng khu vực của mình.
2. **Given** Virtual Office đang mở, **When** một AI Employee bắt đầu task, chờ phê duyệt, hoàn thành hoặc gặp lỗi, **Then** trạng thái của nhân vật tương ứng (Working, Waiting Approval, Completed, Error/Blocked) cập nhật trong vài giây mà không cần tải lại trang.
3. **Given** không có hoạt động thật nào của một nhân viên, **When** người dùng quan sát, **Then** nhân vật ở trạng thái Idle (hoặc Break nếu nhân viên đang bị tạm ngưng) và không có animation giả làm việc.
4. **Given** người dùng nhấp vào một nhân vật, **When** Employee Profile mở ra, **Then** hiển thị task hiện tại và tiến độ, công cụ đang dùng và trạng thái, các trao đổi liên quan, kết quả/review gần nhất, token và chi phí, và các blocker.
5. **Given** kết nối thời gian thực bị gián đoạn, **When** người dùng đang xem Virtual Office, **Then** hệ thống báo trạng thái có thể đã cũ và tự đồng bộ lại khi kết nối trở lại.

---

### User Story 6 - Theo dõi chi phí AI, tiến độ và giới hạn ngân sách (Priority: P2)

Người dùng đặt giới hạn token, ngân sách, số task đồng thời và model được phép ở phạm vi công ty, phòng ban, team và nhân viên; xem trong Company Dashboard tiến độ công việc và chi phí AI của toàn công ty, của từng phòng ban/task/nhân viên.

**Why this priority**: Không có kiểm soát chi phí, AI tự chủ có thể tạo chi phí không giới hạn (Nguyên tắc V). Cần hoàn thiện sớm, nhưng phụ thuộc vào việc đã có task chạy thật.

**Independent Test**: Có thể kiểm thử bằng cách đặt ngân sách thấp cho một nhân viên, giao task vượt mức, và xác nhận task bị chặn hoặc chuyển lên người thật thay vì âm thầm vượt; Dashboard khớp với số liệu từng task.

**Acceptance Scenarios**:

1. **Given** một nhân viên có ngân sách và giới hạn token, **When** task đang chạy tiệm cận giới hạn (mặc định 80%), **Then** người quản lý nhận cảnh báo.
2. **Given** task sắp vượt giới hạn, **When** hệ thống phát hiện, **Then** task bị tạm dừng/chặn và chuyển lên người thật quyết định; không có chi tiêu vượt mức nào xảy ra âm thầm.
3. **Given** công ty đã chạy nhiều task, **When** người dùng mở Company Dashboard, **Then** thấy Total Employees, Active Tasks, Completed Tasks, On-time Completion Rate, tiêu thụ token và chi phí vận hành AI, có thể lọc theo phòng ban.
4. **Given** một Employee Profile, **When** người dùng xem phần chi phí, **Then** số liệu token/chi phí của nhân viên khớp với tổng chi phí các task của nhân viên đó.
5. **Given** model không nằm trong danh sách được phép ở phạm vi của nhân viên, **When** người dùng cố chọn model đó, **Then** hệ thống từ chối.

---

### User Story 7 - Truy vết, xử lý lỗi và phục hồi (Priority: P2)

Người quản lý có thể xem toàn bộ lịch sử thực thi của một task hoặc một nhân viên (nhật ký, các bước, lỗi, kết quả), hệ thống xử lý timeout và thử lại tường minh, và phục hồi công việc dở dang sau sự cố hoặc khởi động lại mà không mất hay lặp việc.

**Why this priority**: "Hoàn thành" đòi hỏi bằng chứng và lỗi phải chẩn đoán được (Nguyên tắc VII). Đây là điều kiện để tin tưởng lực lượng lao động AI, nhưng có thể hoàn thiện sau các luồng chính.

**Independent Test**: Có thể kiểm thử bằng cách buộc một lần chạy thất bại và một lần khởi động lại hệ thống giữa chừng, rồi xác nhận lịch sử thực thi giải thích nguyên nhân và công việc không bị mất hay chạy lặp.

**Acceptance Scenarios**:

1. **Given** một task đã chạy, **When** người quản lý mở lịch sử thực thi, **Then** thấy các bước, công cụ đã dùng, kết quả, lỗi (nếu có), thời gian và chi phí của task.
2. **Given** một lần chạy vượt thời gian cho phép, **When** timeout xảy ra, **Then** hệ thống thử lại theo chính sách và sau khi hết số lần thử thì đánh dấu task Error/Blocked kèm nguyên nhân và thông báo cho người quản lý.
3. **Given** hệ thống bị gián đoạn khi task đang chạy, **When** hệ thống hoạt động lại, **Then** task được tiếp tục hoặc đánh dấu lỗi rõ ràng, không mất kết quả đã có và không thực hiện lại các hành động đã hoàn tất.
4. **Given** nhiều nhân viên cùng có lịch sử, **When** người dùng lọc theo một nhân viên, **Then** chỉ thấy lịch sử của nhân viên đó trong phạm vi quyền của mình.

---

### User Story 8 - Cột mốc gamification nhẹ (Priority: P3)

Người dùng nhận một số cột mốc (Achievement cơ bản) khi đạt các sự kiện thật như tạo AI Employee đầu tiên, thành lập phòng ban đầu tiên, hoàn thành task đầu tiên được phê duyệt – đủ để tạo trải nghiệm thú vị mà không thay thế đánh giá năng suất thật.

**Why this priority**: Phạm vi MVP chỉ cần gamification "đủ vui"; hệ thống XP/Level phức tạp thuộc Phase 5.

**Independent Test**: Có thể kiểm thử bằng cách thực hiện sự kiện đầu tiên (tạo nhân viên AI đầu tiên) và xác nhận cột mốc tương ứng xuất hiện đúng một lần; kiểm tra cột mốc không được cấp khi chỉ tiêu tốn nhiều token.

**Acceptance Scenarios**:

1. **Given** công ty chưa có nhân viên, **When** người dùng tạo AI Employee đầu tiên, **Then** cột mốc "First Employee" được ghi nhận và hiển thị một lần.
2. **Given** một AI Employee tiêu tốn rất nhiều token hoặc chạy rất lâu, **When** hệ thống xét các cột mốc, **Then** không có cột mốc nào được cấp chỉ vì lý do đó.

---

### User Story 9 - CEO AI Assistant điều hành công ty cùng CEO (Priority: P2)

CEO giao cho CEO AI Assistant – một AI Employee đặc biệt báo cáo trực tiếp cho CEO – các công việc điều hành công ty hằng ngày: nắm tình hình công ty, giao việc thay mặt CEO, dựng/chỉnh cơ cấu và nhân sự AI, theo dõi chi phí và đề xuất cách xử lý blocker. CEO chỉ cần nêu yêu cầu bằng ngôn ngữ tự nhiên thay vì tự đi qua từng màn hình; trợ lý thực thi trực tiếp các thao tác điều hành hợp lệ trong phạm vi quyền của CEO. Các quyết định thuộc về con người (phê duyệt kết quả, nâng giới hạn, đổi chính sách quyền) vẫn do CEO tự thực hiện.

**Why this priority**: Giúp đơn giản hóa việc vận hành công ty và giảm số thao tác thủ công của CEO, nhưng chỉ có ý nghĩa khi vòng lặp lõi đã chạy (US1–US4) và đã có dữ liệu chi phí, lịch sử thực thi để trợ lý dựa vào (US6, US7). Trợ lý là lớp tiện lợi đặt trên các thao tác sẵn có, không thay thế AI Manager hay bước Human Approval.

**Independent Test**: Có thể kiểm thử bằng cách tạo CEO AI Assistant từ mẫu, gửi yêu cầu "tổng hợp tình hình công ty tuần này" và nhận báo cáo khớp số liệu Company Dashboard; gửi yêu cầu giao một việc cho Development Team và thấy task được giao qua AI Manager; gửi yêu cầu lưu trữ một phòng ban và thấy hệ thống tạo Approval Request; gửi yêu cầu nâng ngân sách và thấy bị từ chối vì thuộc mức Restricted.

**Acceptance Scenarios**:

1. **Given** công ty chưa có CEO AI Assistant, **When** CEO tạo trợ lý từ mẫu vai trò, **Then** hồ sơ được điền sẵn, manager trực tiếp là CEO, nhân vật hiển thị ở CEO Office; việc tạo thêm một trợ lý thứ hai khi trợ lý đầu còn hoạt động bị chặn.
2. **Given** CEO AI Assistant đang hoạt động, **When** CEO gửi một yêu cầu điều hành bằng ngôn ngữ tự nhiên, **Then** hệ thống ghi yêu cầu thành một task giao cho trợ lý (người giao là CEO), CEO xác nhận hoặc chỉnh tiêu chí nghiệm thu trợ lý đề xuất, rồi trợ lý thực hiện và nộp artifact; task vẫn đi qua AI Manager xác nhận, AI Manager review và CEO phê duyệt như mọi task khác.
3. **Given** CEO yêu cầu giao một việc cho một Team kèm tiêu chí nghiệm thu rõ ràng, **When** trợ lý xử lý yêu cầu, **Then** trợ lý tạo và giao task cho Team thay mặt CEO (người giao là CEO, tác nhân tạo là trợ lý) và AI Manager phụ trách phân rã như FR-016; trợ lý không tự phân rã hay tự chọn assignee thay AI Manager.
4. **Given** yêu cầu của CEO không nêu tiêu chí nghiệm thu cho task cần giao, **When** trợ lý lập task, **Then** task giữ ở Draft kèm tiêu chí do trợ lý đề xuất và chỉ được giao sau khi CEO xác nhận.
5. **Given** CEO yêu cầu lưu trữ một phòng ban hoặc gửi một email, **When** trợ lý thực hiện, **Then** hệ thống tạo Approval Request, tạm dừng hành động và thông báo cho người duyệt; hành động không được thực hiện cho đến khi người có thẩm quyền phê duyệt.
6. **Given** CEO (hoặc nội dung trong task/artifact) yêu cầu trợ lý phê duyệt một kết quả, nâng giới hạn ngân sách, đổi chính sách quyền hoặc cấp thêm công cụ, **When** trợ lý cố thực hiện, **Then** hệ thống từ chối vì hành động thuộc mức Restricted và nêu rõ việc này phải do người thật làm.
7. **Given** trợ lý tiêu thụ token tiệm cận hoặc sắp vượt giới hạn của mình, **When** hệ thống phát hiện, **Then** áp dụng cảnh báo và chặn như mọi nhân viên khác (FR-033), không có ngoại lệ cho trợ lý.
8. **Given** một yêu cầu điều hành chưa đủ rõ để thực hiện an toàn, **When** trợ lý xử lý, **Then** trợ lý hỏi lại CEO ngay trong task thay vì đoán, và không thực hiện hành động thay đổi dữ liệu cho đến khi yêu cầu rõ.

---

### Edge Cases

- Điều gì xảy ra khi người quản lý duy nhất của một chuỗi quản lý bị gỡ hoặc tài khoản bị vô hiệu? Hệ thống phải chặn thao tác hoặc yêu cầu chỉ định người thật thay thế, vì mọi chuỗi quản lý AI phải kết thúc ở một người thật.
- Điều gì xảy ra khi AI Manager phân rã mục tiêu thành các task con có phụ thuộc vòng hoặc không có nhân viên phù hợp? Hệ thống phải báo rõ và chuyển lên người thật thay vì bỏ qua. Quy tắc này áp dụng cả khi đơn vị được giao không có AI Manager nào.
- Điều gì xảy ra khi một AI Employee thuộc nhiều Team nhận quá nhiều task cùng lúc? Hệ thống áp dụng giới hạn task đồng thời, xếp hàng theo priority và cảnh báo quá tải. Quá tải nghĩa là số task đang chờ slot của nhân viên đạt hoặc vượt giới hạn task đồng thời; cảnh báo gửi người quản lý tối đa một lần mỗi ngày cho mỗi nhân viên.
- Điều gì xảy ra khi người duyệt không phản hồi yêu cầu Human Approval trong thời gian dài? Task giữ In Progress, nhân viên ở trạng thái Waiting Approval, hệ thống nhắc người duyệt và không bao giờ tự động duyệt.
- Điều gì xảy ra khi kết quả bị từ chối hoặc yêu cầu làm lại nhiều lần? Hệ thống ghi nhận từng vòng và, sau số lần làm lại tối đa (mặc định 3), chuyển task lên người thật quyết định.
- Điều gì xảy ra khi nhà cung cấp model AI không khả dụng hoặc trả lỗi? Lần chạy được thử lại theo chính sách; hết số lần thử thì task báo Error/Blocked với nguyên nhân rõ ràng.
- Điều gì xảy ra khi deadline của task đã qua mà task chưa hoàn thành? Task được đánh dấu quá hạn, ảnh hưởng đến On-time Completion Rate và thông báo cho người quản lý.
- Điều gì xảy ra khi một người dùng cố truy cập dữ liệu của công ty/phòng ban/task ngoài phạm vi của mình (kể cả bằng cách đoán đường dẫn)? Hệ thống từ chối ở mọi yêu cầu.
- Điều gì xảy ra khi người dùng xóa phòng ban/nhân viên đã có lịch sử task, chi phí và review? Dữ liệu lịch sử phải được giữ để phục vụ truy vết (lưu trữ thay vì xóa mất).
- Điều gì xảy ra khi Virtual Office hiển thị 10 nhân viên cùng thay đổi trạng thái trong thời gian ngắn? Giao diện vẫn phản hồi, không bỏ sót hay đảo thứ tự trạng thái.
- Điều gì xảy ra khi mức tiêu thụ vượt giới hạn do một lần gọi model đơn lẻ rất lớn? Hệ thống phải chặn các lần chạy tiếp theo, chuyển lên người thật và ghi nhận mức vượt.
- Điều gì xảy ra khi CEO AI Assistant bị tạm ngưng hoặc lưu trữ khi đang xử lý yêu cầu điều hành? Áp dụng FR-008: run dừng ở bước an toàn tiếp theo, task chuyển Blocked; các thay đổi trợ lý đã thực hiện trước đó vẫn giữ nguyên và truy vết được, không tự hoàn tác ngầm.
- Điều gì xảy ra khi yêu cầu điều hành vượt phạm vi quyền của CEO, nhắm sang công ty khác hoặc cần chức năng ngoài v1.0 (Project, email/push ngoài ứng dụng, Daily Report)? Hệ thống từ chối ở server và nêu rõ lý do; trợ lý không dùng đường vòng để thực hiện.
- Điều gì xảy ra khi trợ lý thực hiện dở một chuỗi thao tác điều hành thì gặp lỗi? Các thao tác đã hoàn tất không bị thực hiện lại (FR-044), thao tác chưa xong được đánh dấu rõ trong task để CEO chọn tiếp tục hoặc hủy.

## Requirements *(mandatory)*

### Functional Requirements

**Tổ chức và quản lý (Phase 1)**

- **FR-001**: Hệ thống MUST cho phép người dùng đã đăng nhập tạo một công ty và quản lý cơ cấu tổ chức theo cấp Company → Division → Department → Team → Employee (AI hoặc người thật) do người dùng tự định nghĩa.
- **FR-002**: Hệ thống MUST cho phép tạo, đổi tên, sắp xếp lại và xóa/lưu trữ Division, Department và Team; thao tác xóa MUST bị chặn nếu đơn vị còn nhân viên hoặc task đang hoạt động.
- **FR-003**: Hệ thống MUST cung cấp cơ cấu mẫu công ty phần mềm (Development, BA, QA) làm điểm khởi đầu, và cơ cấu mẫu MUST chỉ là template có thể tùy chỉnh, không phải ràng buộc cứng.
- **FR-004**: Hệ thống MUST hiển thị sơ đồ tổ chức phản ánh đúng cấu trúc hiện tại cùng người quản lý của từng đơn vị.
- **FR-005**: Hệ thống MUST cho phép gán một người thật làm manager của một AI Employee, một Team hoặc một Department; phạm vi quản lý MUST quyết định khả năng xem, giao việc và review.
- **FR-006**: Hệ thống MUST bảo đảm mỗi AI Employee có một manager trực tiếp (người thật hoặc AI) và mọi chuỗi quản lý AI kết thúc ở một người thật chịu trách nhiệm; thao tác phá vỡ ràng buộc này MUST bị chặn. Manager AI của một AI Employee MUST là AI Manager.
- **FR-007**: Hệ thống MUST cho phép một AI Employee thuộc nhiều Team, đồng thời theo dõi workload, mức ưu tiên và số task đồng thời của nhân viên để tránh quá tải. Thực thể dự án (Project) nằm ngoài phạm vi v1.0.

**AI Employee và AI Manager (Phase 2)**

- **FR-008**: Hệ thống MUST cho phép tạo AI Employee từ mẫu vai trò hoặc cấu hình tùy chỉnh, và chỉnh sửa, tạm ngưng hoặc lưu trữ nhân viên sau khi tạo. Nhân viên bị tạm ngưng MUST không được bắt đầu run mới; run đang chạy MUST dừng ở bước an toàn tiếp theo và task chuyển Blocked với lý do tạm ngưng; task đang chờ slot được giữ nguyên và MUST tự động được xếp chạy khi nhân viên hoạt động lại. Task đã Blocked MUST không được tiếp tục khi assignee còn bị tạm ngưng.
- **FR-009**: Hồ sơ AI Employee MUST gồm: Name/Avatar, Position/Department, Personality, Skills/Seniority (Junior, Middle, Senior, Expert), AI Model, System Prompt, Tools, Manager, Status/Performance.
- **FR-010**: Hệ thống MUST cho phép chọn model AI theo từng AI Employee trong danh sách model được phép, và việc đổi model của một nhân viên MUST không đòi hỏi thay đổi nhân viên khác hay chức năng khác của hệ thống.
- **FR-011**: Hệ thống MUST phân biệt AI Manager (nhận mục tiêu, chia nhỏ, phân công, theo dõi tiến độ và workload, review, tổng hợp, báo cáo) với AI Employee (nhận task, thực hiện theo chuyên môn, dùng công cụ được cấp quyền, báo cáo kết quả). CEO AI Assistant (FR-046) là một AI Employee thường, không phải AI Manager: không phân rã mục tiêu, không review và không thay thế AI Manager.
- **FR-012**: Hệ thống MUST cho phép cấu hình theo từng employee cách thực hiện công việc phù hợp vai trò (vai trò làm việc với mã nguồn so với vai trò tài liệu/phân tích), không giả định một cách duy nhất cho toàn hệ thống. Trong v1.0, AI Manager MUST dùng runtime tài liệu/phân tích vì bước phân rã và review cần structured output đã kiểm chứng.
- **FR-013**: AI Employee MUST lưu giữ lịch sử làm việc và ngữ cảnh liên quan của mình; nội dung này MUST chỉ truy cập được trong phạm vi tổ chức/team/nhân viên được phép, không rò rỉ khi chưa có quy tắc chia sẻ tường minh.

**Task và quy trình giao việc (Phase 2)**

- **FR-014**: Mỗi task MUST có: mục tiêu, người giao, assignee, deadline, priority, acceptance criteria, đầu ra mong đợi và trạng thái.
- **FR-015**: Người dùng MUST có thể giao task cho một AI Employee, một Team hoặc một Department trong phạm vi quản lý của mình. Task giao trực tiếp cho một AI Employee MUST qua bước AI Manager xác nhận phân công hoặc chia việc trước khi chạy (FR-016).
- **FR-016**: Với mục tiêu giao cho Team/Department, AI Manager MUST phân tích, chia nhỏ thành task con, chọn nhân viên phù hợp theo chuyên môn và workload, và xử lý phụ thuộc giữa các task; người dùng MUST xem được kết quả phân rã. Task giao Team/Department MUST được phân rã thành ít nhất một task con; kế hoạch giữ nguyên phân công hoặc không có task con MUST làm task chuyển Blocked và người quản lý MUST được báo.
- **FR-016a**: AI Manager phụ trách là AI Manager thuộc Team được giao; nếu không có thì là AI Manager có phòng ban chính là đơn vị đó; nếu vẫn không có, hệ thống MUST tự tạo một AI Manager cho Team (mẫu `ai_manager`, thuộc Team và department chứa Team, manager trực tiếp là người quản lý Team hoặc CEO) rồi dùng AI Manager đó; chỉ khi không tạo được thì task MUST chuyển Blocked và người quản lý MUST được báo. Một AI Manager có thể thuộc nhiều Team. Với task giao trực tiếp cho AI Employee, AI Manager phụ trách chọn theo thứ tự ở FR-018 (nhân viên được giao là AI Manager thì tự đảm nhiệm bước này); AI Manager có thể xác nhận giữ nguyên phân công hoặc chia thành task con; không có AI Manager nào thì task MUST chuyển Blocked. Khi nhiều AI Manager cùng khớp ở một bậc chọn (FR-016a, FR-018), hệ thống lấy AI Manager có `id` nhỏ nhất (cũ nhất). Với task giao Team, bậc "phòng ban" là department chứa Team đó.
- **FR-016b**: Task con kế thừa deadline và priority của task cha; assignee MUST thuộc phạm vi quản lý của người giao task cha. Task cha chuyển In Progress khi kế hoạch phân rã được áp dụng và chuyển In Review khi mọi task con Completed. Mỗi task con đi đủ vòng đời FR-020a, kể cả Human Approval, và task phụ thuộc chỉ bắt đầu khi task nó phụ thuộc đã Completed. Task con không qua bước xác nhận hay phân rã của AI Manager lần nữa (phân rã tối đa một cấp), vì AI Manager đã phân công khi lập kế hoạch.
- **FR-016c**: Task con bị hủy thì task cha MUST chuyển Blocked với lý do `SUBTASK_CANCELLED` và người quản lý chỉ có thể hủy task cha. Hủy task cha MUST hủy mọi task con chưa kết thúc cùng các run và yêu cầu phê duyệt đang chờ của chúng.
- **FR-017**: AI Employee MUST thực hiện task thật và trả về artifact hoặc kết quả có thể kiểm chứng; kết quả MUST được lưu và mở xem được.
- **FR-018**: Một AI Manager độc lập với tác nhân tạo ra đầu ra MUST kiểm tra kết quả đối chiếu acceptance criteria và có thể yêu cầu làm lại. Thứ tự chọn reviewer AI: manager AI trực tiếp của người thực hiện → AI Manager cùng phòng ban → AI Manager bất kỳ đang hoạt động trong công ty, luôn khác tác nhân tạo ra đầu ra. Với artifact tổng hợp của task cha, reviewer là một AI Manager khác tác nhân đã tổng hợp, ưu tiên AI Manager không thực hiện task con nào. Không có reviewer phù hợp thì task MUST chuyển Blocked và báo người thật.
- **FR-019**: Human Manager MUST có thể approve, reject hoặc yêu cầu làm lại; mỗi quyết định MUST được ghi nhận kèm người thực hiện, thời điểm và lý do.
- **FR-020**: Hệ thống MUST không cho đánh dấu task Completed khi thiếu bằng chứng hoàn thành đối chiếu với acceptance criteria.
- **FR-020a**: Task MUST đi theo vòng đời trạng thái: Draft → Assigned → In Progress → In Review (AI Manager kiểm tra) → Awaiting Human Approval → Completed. Từ In Review hoặc Awaiting Human Approval, task MUST có thể quay lại In Progress (Rework) và mỗi vòng làm lại được ghi nhận. Task MAY chuyển sang Blocked/Error khi gặp lỗi hoặc blocker, và sang Cancelled khi bị hủy. Quá hạn (Overdue) là cờ kèm theo task chứ không phải trạng thái riêng. Chỉ chuyển từ Awaiting Human Approval sang Completed khi Human Manager phê duyệt; mọi chuyển trạng thái ngoài các cạnh trên MUST bị từ chối. Quyết định reject của Human Manager chuyển task sang Blocked (tính là một vòng làm lại, không tự chạy lại); người quản lý sau đó chọn hủy hoặc tiếp tục. Tiếp tục nghĩa là task về In Progress với run mới nhận lý do từ chối; kết quả đã bị từ chối MUST không được phê duyệt lại. Sau khi đạt số lần làm lại tối đa, nếu người quản lý tiếp tục thì bộ đếm escalation bắt đầu lại, lịch sử các vòng vẫn giữ nguyên. Với task cha, rework hoặc tiếp tục sau reject MUST chạy lại bước tổng hợp kèm lý do và không mở lại task con đã Completed.
- **FR-021**: Hệ thống MUST cung cấp Task Board hiển thị task theo trạng thái, tiến độ, priority, deadline, assignee và phòng ban, với khả năng lọc.
- **FR-022**: Hệ thống MUST cho phép trao đổi giữa người quản lý và nhân viên AI/AI Manager gắn trực tiếp vào task (không có hội thoại ngoài ngữ cảnh một task hoặc hoạt động thật).
- **FR-023**: Task gặp lỗi hoặc bị chặn MUST được thể hiện tường minh với nguyên nhân và blocker; thông báo theo FR-041. Người quản lý MUST thấy nguyên nhân và chọn được tiếp tục hoặc hủy task ngay trên chi tiết task. Ngoại lệ: blocker `SUBTASK_CANCELLED` chỉ cho phép hủy (FR-016c).

**Quyền hạn, phê duyệt và cô lập dữ liệu (xuyên suốt)**

- **FR-024**: Mỗi hành động của AI Employee MUST thuộc một trong bốn mức quyền Auto Execute, Review Required, Human Approval, Restricted; hành động chưa phân loại MUST mặc định là Restricted. Với mức Review Required, hành động được thực hiện ngay nhưng kết quả MUST được một AI Manager độc lập xem xét ở bước In Review trước khi task được chuyển tiếp; chỉ hành động hoàn tác được hoặc không có tác động ra ngoài mới được xếp vào mức này (hành động có tác động ra ngoài không hoàn tác được MUST xếp vào Human Approval). Lệnh shell chỉ được xem là đã phân loại khi khớp allowlist do hệ thống định nghĩa; mọi lệnh khác MUST được xử lý như Restricted.
- **FR-025**: Hành động nhạy cảm (gồm gửi email, xóa dữ liệu, deploy, đặc biệt lên production) MUST luôn yêu cầu Human Approval và MUST được hệ thống cưỡng chế, không chỉ dựa vào câu chữ trong chỉ dẫn; yêu cầu này áp dụng cả khi adapter đang ở chế độ sandbox/dry-run.
- **FR-026**: Hệ thống MUST tạo yêu cầu phê duyệt có đủ ngữ cảnh (hành động, lý do, nhân viên, task), tạm dừng hành động cho đến khi có quyết định, và thông báo theo FR-041. Nếu người duyệt bị vô hiệu khi yêu cầu còn chờ, yêu cầu MUST được chuyển cho CEO.
- **FR-027**: Công cụ và credential của AI Employee MUST được cấp theo nguyên tắc đặc quyền tối thiểu; AI Employee chỉ dùng được công cụ được cấp. Trong v1.0, danh mục công cụ gồm: (a) công cụ workspace (đọc/ghi tài liệu, mã nguồn, chạy test) trong khu vực làm việc do người dùng cấp; (b) các công cụ hành động nhạy cảm (gửi email, xóa dữ liệu, deploy) cung cấp qua adapter cấu hình được, mặc định chạy ở chế độ sandbox/dry-run và không tác động hệ thống bên ngoài thật cho đến khi người dùng cấu hình tường minh adapter thật. Trong v1.0, AI Employee chỉ ghi vào thư mục làm việc riêng của từng run (bản sao của workspace), không ghi thẳng vào nguồn; kết quả được nộp dưới dạng artifact.
- **FR-028**: Hệ thống MUST cưỡng chế phân quyền trên mọi yêu cầu truy cập (không chỉ bằng cách ẩn chức năng trên giao diện) theo công ty, phòng ban, team, task và tài liệu.
- **FR-029**: Dữ liệu MUST được cô lập theo công ty ngay từ thiết kế; không tính năng nào được giả định chỉ có một công ty hoặc một người dùng, dù v1.0 chỉ triển khai trải nghiệm một công ty.
- **FR-030**: Hệ thống MUST yêu cầu xác thực người dùng trước khi truy cập mọi chức năng và dữ liệu.

**Kiểm soát chi phí và năng lực (Phase 2–3)**

- **FR-031**: Hệ thống MUST hỗ trợ đặt giới hạn token, ngân sách, số task đồng thời và model được phép ở phạm vi công ty, phòng ban, team và nhân viên. Giới hạn token và ngân sách của mỗi phạm vi MUST được tính theo tháng lịch (bộ đếm tự đặt lại vào đầu tháng), và MAY có thêm trần token/chi phí tùy chọn trên từng task; khi có nhiều phạm vi áp dụng cho cùng một lần chạy, giới hạn nào chạm trước sẽ được áp dụng.
- **FR-032**: Hệ thống MUST đo token và chi phí theo từng task và từng nhân viên.
- **FR-033**: Hệ thống MUST cảnh báo khi mức sử dụng tiệm cận giới hạn và MUST chặn hoặc chuyển lên người thật khi task sắp vượt giới hạn; KHÔNG ĐƯỢC âm thầm vượt mức. "Sắp vượt" nghĩa là mức đã dùng cộng phần đang giữ và phần ước tính cho bước kế tiếp sẽ vượt giới hạn.

**Virtual Office và Dashboard (Phase 3)**

- **FR-034**: Hệ thống MUST cung cấp Virtual Office 2D phong cách pixel art, có khu vực tương ứng với từng phòng ban đã tạo cùng CEO Office và Break Room.
- **FR-035**: Mỗi nhân viên MUST hiển thị là một nhân vật ở khu vực phòng ban của mình, với trạng thái thuộc: Idle, Working, Thinking, Communicating, Meeting, Waiting Approval, Completed, Error/Blocked, Break. Trong v1.0, Meeting chưa có sự kiện nguồn nên không xuất hiện; Break chỉ dùng khi nhân viên bị tạm ngưng. CEO AI Assistant (FR-046) hiển thị ở CEO Office thay vì khu vực phòng ban.
- **FR-036**: Trạng thái nhân viên MUST suy ra từ sự kiện agent/task thật, MUST KHÔNG được sinh ngẫu nhiên hay dựng sẵn; hệ thống MUST không có chat giả hoặc animation giả.
- **FR-037**: Thay đổi trạng thái MUST được cập nhật theo thời gian thực mà không cần tải lại trang, từ một nguồn trạng thái duy nhất có thẩm quyền; khi mất kết nối, hệ thống MUST báo dữ liệu có thể đã cũ và tự đồng bộ lại khi kết nối trở lại. Người xem chỉ nhận trạng thái và sự kiện trong phạm vi quản lý của mình, do server lọc.
- **FR-038**: Nhấp vào nhân vật MUST mở Employee Profile gồm tối thiểu: task hiện tại và tiến độ, công cụ đang dùng và trạng thái runtime, các trao đổi liên quan, kết quả gần nhất và lịch sử review, token và chi phí, các blocker.
- **FR-039**: Phong cách trình bày của Virtual Office MUST độc lập với dữ liệu và quy tắc nghiệp vụ, để có thể thay đổi cách hiển thị mà không đổi logic nghiệp vụ.
- **FR-040**: Hệ thống MUST cung cấp Company Dashboard gồm tối thiểu: Total Employees, Active Tasks, Completed Tasks, On-time Completion Rate, tiêu thụ token và chi phí vận hành AI, có thể xem theo phòng ban. Active Tasks, Completed Tasks và On-time Completion Rate chỉ đếm task gốc (không đếm task con). On-time Completion Rate là số task gốc Completed có thời điểm hoàn thành không muộn hơn deadline chia cho tổng số task gốc Completed; chưa có task Completed thì hiển thị là chưa có dữ liệu. Token và chi phí tính trên mọi task, gồm cả task con.
- **FR-041**: Hệ thống MUST gửi thông báo cho người quản lý khi task hoàn thành, gặp lỗi, quá hạn, cần phê duyệt hoặc khi nhân viên quá tải. Trong v1.0, thông báo chỉ được gửi trong ứng dụng: đẩy realtime tới người quản lý đang mở ứng dụng và lưu trong hộp thông báo có trạng thái đã đọc/chưa đọc để người quản lý xem lại khi quay lại. Người nhận: task hoàn thành, lỗi, quá hạn, escalation và task bị chặn vì ngân sách gửi người giao task; cần phê duyệt gửi người duyệt; nhân viên quá tải gửi người thật cuối chuỗi quản lý của nhân viên; cảnh báo ngân sách gửi người quản lý của phạm vi (CEO với phạm vi công ty). Người nhận bị vô hiệu thì gửi CEO.

**Quan sát, độ tin cậy và gamification nhẹ**

- **FR-042**: Mọi lần chạy agent MUST ghi nhật ký, vết thực thi, trạng thái runtime, lỗi và lịch sử, truy vấn được theo từng task và từng nhân viên trong phạm vi quyền của người xem.
- **FR-043**: Workflow MUST định nghĩa timeout và số lần thử lại, và xử lý task lỗi một cách tường minh.
- **FR-044**: Sau sự cố hoặc khởi động lại, mỗi run đang chạy MUST được tiếp tục, hoặc được đánh dấu lỗi rõ ràng để người quản lý chọn tiếp tục từ kết quả đã có. Kết quả đã có MUST không bị mất và hành động đã hoàn tất MUST không bị thực hiện lại.
- **FR-045**: Hệ thống MUST ghi nhận một số cột mốc Achievement cơ bản dựa trên sự kiện thật (tối thiểu: First Employee, First Department, task đầu tiên được phê duyệt); cột mốc MUST không được cấp chỉ vì dùng nhiều token hoặc chạy lâu và MUST không thay thế đánh giá năng suất.

**CEO AI Assistant – điều hành công ty thay mặt CEO (Phase 2)**

- **FR-046**: Hệ thống MUST cung cấp mẫu vai trò `ceo_assistant` để tạo CEO AI Assistant. Mỗi công ty có tối đa một CEO AI Assistant đang hoạt động trong v1.0. Trợ lý là AI Employee thường (FR-011), manager trực tiếp MUST là CEO (người thật), được cấu hình model, chỉ dẫn vai trò và công cụ theo FR-009, FR-010, FR-012, được tạm ngưng/lưu trữ theo FR-008 và thuộc cấp công ty (không bắt buộc thuộc một Department); nhân vật hiển thị ở CEO Office.
- **FR-047**: Mỗi yêu cầu điều hành CEO gửi cho trợ lý MUST được ghi thành một Task (người giao là CEO, assignee là trợ lý) để trao đổi gắn với task theo FR-022; CEO chỉ cần nêu mục tiêu, trợ lý đề xuất acceptance criteria, deadline, priority và đầu ra mong đợi để CEO xác nhận hoặc chỉnh trước khi chạy. Task của trợ lý MUST đi đủ vòng đời FR-020a, kể cả AI Manager xác nhận (FR-015), AI Manager review độc lập (FR-018) và Human Approval của CEO (FR-019); trợ lý MUST NOT review hay phê duyệt kết quả của chính mình.
- **FR-048**: Trợ lý MUST thực thi trực tiếp các nhóm công việc điều hành sau, thông qua các thao tác hợp lệ của hệ thống (không truy cập tắt vào dữ liệu): (a) nắm tình hình – tổng hợp Company Dashboard, task, blocker, chi phí và ngân sách thành báo cáo lưu dưới dạng artifact, chỉ dựa trên dữ liệu thật; (b) giao việc thay mặt CEO – tạo và giao task cho AI Employee, Team hoặc Department; nếu tiêu chí nghiệm thu do CEO nêu trong yêu cầu thì giao ngay, nếu do trợ lý đề xuất thì task MUST giữ ở Draft chờ CEO xác nhận, và việc phân rã, phân công vẫn do AI Manager thực hiện theo FR-016; (c) cơ cấu và nhân sự AI – tạo, đổi tên, sắp xếp lại Division/Department/Team, tạo và chỉnh sửa AI Employee từ mẫu vai trò với công cụ mặc định của mẫu, tạm ngưng hoặc kích hoạt lại nhân viên; (d) blocker và escalation – đề xuất phương án tiếp tục hoặc hủy kèm lý do, quyết định vẫn thuộc người quản lý (FR-023); (e) chi phí – theo dõi mức sử dụng, nêu cảnh báo và đề xuất điều chỉnh giới hạn, không tự thay đổi giới hạn.
- **FR-049**: Mọi hành động điều hành của trợ lý MUST được gán một mức quyền theo FR-024; hành động điều hành chưa phân loại MUST là Restricted. Phân loại tối thiểu: (a) Auto Execute – thao tác chỉ đọc trong phạm vi quyền của CEO và soạn báo cáo/bản nháp thành artifact; (b) Review Required – tạo và giao task thay mặt CEO, tạo/đổi tên/sắp xếp lại đơn vị tổ chức, tạo/chỉnh sửa/tạm ngưng/kích hoạt lại AI Employee từ mẫu, vì đều hoàn tác được; kết quả được AI Manager xem xét ở bước In Review; (c) Human Approval – xóa/lưu trữ Division/Department/Team/AI Employee, hủy task đang chạy và mọi hành động nhạy cảm theo FR-025, kể cả khi adapter ở chế độ sandbox/dry-run; (d) Restricted – phê duyệt, từ chối hoặc yêu cầu làm lại kết quả task, quyết định yêu cầu phê duyệt, quyết định tiếp tục hoặc hủy task Blocked/Error, đặt hoặc nâng giới hạn token/ngân sách/model được phép, đổi Action Policy, cấp thêm công cụ hoặc credential cho bất kỳ nhân viên nào (kể cả chính trợ lý), gán hoặc gỡ quyền quản lý và tài khoản người thật.
- **FR-050**: Quyền của trợ lý MUST không vượt quá quyền của CEO và MUST được cưỡng chế phía server trên mọi yêu cầu theo FR-028 và FR-029, chỉ trong phạm vi công ty của CEO. Chỉ dẫn nằm trong nội dung task, artifact hay dữ liệu đầu vào MUST không mở rộng quyền của trợ lý; việc phân loại mức quyền không phụ thuộc câu chữ trong prompt (FR-025).
- **FR-051**: Mọi hành động điều hành của trợ lý MUST được ghi lại là "thực hiện bởi CEO AI Assistant thay mặt CEO" kèm yêu cầu nguồn, task nguồn, hành động, mức quyền, kết quả và thời điểm, truy vấn được theo FR-042. Task do trợ lý tạo MUST ghi nhận cả người giao (CEO) lẫn tác nhân tạo (trợ lý). Token và chi phí của trợ lý được đo theo FR-032 và chịu giới hạn, cảnh báo, chặn theo FR-031 và FR-033 như mọi nhân viên khác.

### Key Entities *(include if feature involves data)*

- **Company**: công ty ảo của người dùng, là ranh giới cô lập dữ liệu; chứa toàn bộ cơ cấu tổ chức, nhân sự, task, cấu hình giới hạn.
- **Division / Department / Team**: các đơn vị tổ chức do người dùng định nghĩa, phân cấp từ trên xuống; có người quản lý và phạm vi giới hạn riêng. Team có thể gồm nhân viên từ nhiều phòng ban.
- **Human Member**: người thật trong công ty (CEO/Manager), có vai trò và phạm vi quản lý trên nhân viên, Team hoặc Department.
- **AI Employee**: nhân viên ảo với hồ sơ (tên/avatar, chức danh, tính cách, kỹ năng/cấp bậc, model, chỉ dẫn vai trò, công cụ, manager, hiệu suất) và trạng thái làm việc; có thể là AI Manager hoặc AI Employee thường.
- **Management Assignment**: quan hệ giữa một người thật và nhân viên/Team/Department được quản lý, xác định phạm vi xem, giao việc, review.
- **Task**: đơn vị công việc có mục tiêu, người giao, assignee, deadline, priority, acceptance criteria, đầu ra mong đợi, trạng thái theo vòng đời ở FR-020a; có thể có task con và phụ thuộc.
- **Artifact / Evidence**: kết quả hoàn thành thật (tài liệu, báo cáo, mã, bộ test…) và bằng chứng đối chiếu với từng acceptance criteria.
- **Review Record**: ghi nhận kiểm tra/phê duyệt/từ chối/yêu cầu làm lại cùng người thực hiện, thời điểm và lý do.
- **Action Policy**: gán mỗi loại hành động vào một mức quyền (Auto Execute, Review Required, Human Approval, Restricted).
- **Approval Request**: yêu cầu phê duyệt gắn với hành động nhạy cảm, có ngữ cảnh, trạng thái chờ/duyệt/từ chối.
- **Limit & Budget**: giới hạn token, ngân sách (theo tháng lịch), task đồng thời và model được phép ở từng phạm vi, cùng trần tùy chọn trên từng task.
- **Usage Record**: mức tiêu thụ token và chi phí gắn với task và nhân viên.
- **Execution Record (Agent Run)**: lịch sử một lần chạy agent gồm nhật ký, bước, lỗi, thời gian, kết quả.
- **Employee Status**: trạng thái làm việc hiện tại của nhân viên, suy ra từ sự kiện thật.
- **Office Zone**: khu vực trong Virtual Office gắn với phòng ban, cùng vị trí nhân vật.
- **Notification**: thông báo trong ứng dụng gửi người quản lý về các sự kiện ở FR-041 và cảnh báo ngân sách, có trạng thái đã đọc/chưa đọc.
- **Milestone**: cột mốc Achievement cơ bản gắn với sự kiện thật. `Milestone` chỉ là tên trong code; giao diện hiển thị là Achievement.
- **CEO AI Assistant**: AI Employee tạo từ mẫu `ceo_assistant`, manager trực tiếp là CEO, thực thi các thao tác điều hành thay mặt CEO trong phạm vi quyền của CEO; mỗi yêu cầu điều hành là một Task, mỗi hành động được ghi kèm mức quyền và dấu "thay mặt CEO" trong Execution Record.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Một người dùng mới dựng được công ty mẫu (ba phòng ban) cùng ít nhất 5 AI Employee từ trạng thái trống trong vòng 15 phút mà không cần tài liệu hướng dẫn. Đo trên tối thiểu 10 người thử chưa từng dùng sản phẩm.
- **SC-002**: 100% task ở trạng thái Completed có ít nhất một artifact kiểm chứng được và bằng chứng đối chiếu từng acceptance criteria; không có task Completed nào thiếu bằng chứng.
- **SC-003**: Trong bộ kiểm thử hành động nhạy cảm (gửi email, xóa dữ liệu, deploy), 100% trường hợp bị giữ lại cho đến khi có Human Approval; 0 trường hợp lách được, kể cả khi nội dung đầu vào cố ép bỏ qua.
- **SC-004**: 100% hành động chưa được phân loại mức quyền bị từ chối trong kiểm thử.
- **SC-005**: Trạng thái nhân viên trên Virtual Office thay đổi trong vòng 3 giây kể từ khi sự kiện thật xảy ra trong ít nhất 95% trường hợp.
- **SC-006**: Khi đối chiếu 50 lần chuyển trạng thái mẫu giữa Virtual Office và nhật ký thực thi, 100% khớp với sự kiện thật; không có trạng thái hay animation nào xuất hiện mà không có sự kiện nguồn.
- **SC-007**: Virtual Office vẫn thao tác mượt (mở Employee Profile trong dưới 1 giây) khi 10 AI Employee cùng hoạt động.
- **SC-008**: Tổng chi phí và token trong Company Dashboard khớp với tổng của từng task với sai lệch không quá 1%.
- **SC-009**: Trong kiểm thử vượt ngân sách, 100% task sắp vượt giới hạn bị chặn hoặc chuyển lên người thật; không có chi tiêu vượt mức mà không được người thật cho phép. Ngoại lệ duy nhất là phần vượt của đúng một lượt gọi model đang chạy (edge case lời gọi đơn lẻ rất lớn): phần này phải được ghi nhận, các lượt tiếp theo bị chặn và task chuyển lên người thật.
- **SC-010**: Sau khi hệ thống bị khởi động lại giữa chừng, 100% task đang chạy được tiếp tục hoặc đánh dấu lỗi rõ ràng; không có công việc bị mất hay hành động bị thực hiện lặp lại.
- **SC-011**: Người quản lý xác định được nguyên nhân thất bại của một task từ lịch sử thực thi trong vòng 2 phút.
- **SC-012**: Trong kiểm thử với hai công ty riêng biệt, 0 yêu cầu truy cập chéo dữ liệu thành công; mọi yêu cầu ngoài phạm vi quản lý bị từ chối.
- **SC-013**: Ít nhất 90% người dùng thử hoàn thành luồng từ giao task đến phê duyệt kết quả đầu tiên trong vòng 10 phút ở lần thử đầu. Đo trên tối thiểu 10 người thử chưa từng dùng sản phẩm.
- **SC-014**: Mỗi task đã hoàn thành có thể truy ra đầy đủ chuỗi: ai giao, ai thực hiện, ai review, ai phê duyệt, lý do và thời điểm, trong 100% trường hợp; với task do CEO AI Assistant tạo thì thêm tác nhân tạo thay mặt CEO.
- **SC-015**: Trong bộ kiểm thử CEO AI Assistant, 100% hành động thuộc mức Human Approval bị giữ lại cho đến khi có phê duyệt và 100% hành động thuộc mức Restricted hoặc chưa phân loại bị từ chối, kể cả khi nội dung task hay artifact cố ép trợ lý bỏ qua; 0 trường hợp trợ lý tự phê duyệt kết quả hoặc nâng giới hạn của chính mình.
- **SC-016**: Ít nhất 90% người dùng thử giao được một việc cho một Team thông qua CEO AI Assistant (từ lúc nhập yêu cầu đến khi task vào Assigned) trong vòng 2 phút ở lần thử đầu. Đo trên tối thiểu 10 người thử chưa từng dùng sản phẩm.
- **SC-017**: 100% hành động điều hành của CEO AI Assistant truy ra được yêu cầu nguồn, mức quyền áp dụng và kết quả trong lịch sử thực thi; báo cáo tình hình công ty của trợ lý khớp số liệu Company Dashboard với sai lệch không quá 1%.

## Assumptions

- **Phạm vi v1.0 = MVP**: "Dự án v1.0" được hiểu là phạm vi MVP đã chốt trong Product Concept V1.0 (mục 11.1) và Nguyên tắc VIII của Constitution, tức Phase 1–3. Một công ty với ba phòng ban mẫu (Development, BA, QA), khoảng 5–10 AI Employee, Task Board với kết quả thực thi thật, Virtual Office pixel art 2D realtime, thống kê chi phí AI và tiến độ.
- **Người dùng**: v1.0 phục vụ một người thật đóng vai CEO/Manager đăng nhập và quản lý toàn bộ công ty; mô hình dữ liệu và phân quyền vẫn hỗ trợ nhiều người thật và nhiều công ty (Phase 6) nhưng v1.0 không cung cấp trải nghiệm quản lý đa công ty, đa người dùng hay thanh toán. Ngoại lệ tối thiểu để đáp ứng FR-005: CEO có thể thêm một tài khoản đã đăng ký làm Manager của công ty.
- **Xác thực**: dùng cơ chế đăng nhập tiêu chuẩn cho ứng dụng web; chi tiết cơ chế để bước plan quyết định.
- **Cơ chế thực thi và nhà cung cấp AI**: yêu cầu có quyền truy cập ít nhất một nhà cung cấp model AI và người dùng cung cấp khu vực làm việc mà AI được phép dùng (ví dụ kho mã nguồn, thư mục tài liệu). Các hành động nhạy cảm (gửi email, xóa dữ liệu, deploy) trong v1.0 chạy qua adapter sandbox/dry-run theo mặc định; v1.0 chỉ giao adapter dry-run; tích hợp thật với email/CI-CD không phải điều kiện hoàn thành v1.0, và chế độ live báo lỗi cho đến khi có adapter thật được cấu hình tường minh. Khả năng của Claude/Claude Code mà plan dựa vào phải được kiểm chứng với tài liệu chính thức hiện hành trước khi chốt.
- **Cấu hình mặc định**: ngưỡng cảnh báo ngân sách mặc định 80%; công ty chưa có chính sách ngân sách áp hạn mức mặc định 20 USD và 2.000.000 token mỗi tháng, không bao giờ coi là không giới hạn; số lần làm lại tối đa trước khi chuyển lên người thật mặc định 3; số lần thử lại và timeout có giá trị mặc định cấu hình được. Có thể điều chỉnh ở bước clarify/plan.
- **Mẫu vai trò**: v1.0 cung cấp mẫu cho AI Developer, AI Business Analyst, AI QA Engineer, AI Manager và CEO AI Assistant; các vai trò khác (Marketing, HR, Finance) là tùy chỉnh.
- **CEO AI Assistant**: trợ lý là tùy chọn (CEO tạo khi cần, không tự tạo cùng công ty) và không tính vào mục tiêu 5–10 AI Employee của SC-001. Trong v1.0 trợ lý chỉ hành động khi CEO gửi yêu cầu (không chủ động chạy theo lịch, không báo cáo định kỳ vì Daily Report thuộc Phase 4), chỉ nhận yêu cầu dạng văn bản trong ứng dụng gắn với task, và chỉ dùng các thao tác sẵn có của hệ thống nên không kéo theo engine hay phạm vi mới. Trợ lý thuộc Phase 2 vì chỉ là một mẫu AI Employee bổ sung (YAGNI): mục tiêu đơn giản hóa vận hành được đáp ứng mà không thay đổi quy trình của Nguyên tắc II.
- **Virtual Office**: khu vực gồm các phòng ban đã tạo, CEO Office và Break Room; các khu vực khác (Meeting Room, Training Room, Server Room, Project Room) và tùy chỉnh bố trí văn phòng thuộc các phase sau.
- **Ngoài phạm vi v1.0** (thuộc Phase 4–6 hoặc xa hơn): thực thể dự án (Project), thông báo qua email/push/webhook ngoài ứng dụng, Company/Department/Team Chat, Meeting Room, Daily Report, hệ thống XP/Level đầy đủ, Reward, Office Upgrade, Game Center, nhiều loại tài sản ảo, multiplayer, quản lý đa công ty/đa người dùng đầy đủ, thanh toán/billing, giao diện isometric 3D, và mở rộng sang các ngành nghề ngoài công ty phần mềm.
- **Dữ liệu và triển khai**: dữ liệu và kết quả của công ty được lưu giữ bền vững; cấu hình theo môi trường tách khỏi mã nguồn; ngôn ngữ giao diện mặc định là tiếng Việt, thuật ngữ sản phẩm giữ tiếng Anh. Task Center là khu vực quản lý công việc; Task Board là màn hình chính của khu vực đó.
- **Tài liệu tham chiếu**: `ref/Claude_Company_Product_Concept_V1.docx` (định hướng sản phẩm) và `.specify/memory/constitution.md` (nguyên tắc bắt buộc, kiểm tra ở bước Constitution Check của plan).
