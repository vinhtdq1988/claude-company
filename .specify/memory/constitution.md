<!--
BÁO CÁO TÁC ĐỘNG ĐỒNG BỘ (chỉ để rà soát tạm thời; xóa trước khi commit)
- Thay đổi phiên bản: 1.0.0 → 1.0.1  [PATCH]
- Lý do: dịch toàn bộ constitution từ tiếng Anh sang tiếng Việt theo CLAUDE.md. Chỉ thay đổi
  cách diễn đạt; không thêm, bớt hay đổi nghĩa của nguyên tắc nào.
- Nguyên tắc đổi tên: chỉ đổi ngôn ngữ của tên (I–VIII giữ nguyên thứ tự và ý nghĩa).
- Mục thêm: không. Mục xóa: không.
- Giữ nguyên tiếng Anh theo CLAUDE.md: tiêu đề cố định của template ("Core Principles",
  "Governance"), marker NON-NEGOTIABLE, và thuật ngữ sản phẩm (AI Employee, AI Manager,
  Virtual Office, Auto Execute, Review Required, Human Approval, Restricted, ...).
- Template/lệnh liên quan: không sửa; chúng đọc constitution khi chạy (bước Constitution Check).
- Việc cần theo dõi (TODO): không có.
-->
# Claude Company Constitution

## Core Principles

### I. Công việc thật, không phải màn trình diễn (NON-NEGOTIABLE)
AI Employee là một thực thể công việc có hồ sơ, chuyên môn, quyền hạn, công cụ, nhiệm vụ và lịch
sử làm việc riêng. AI Employee không bao giờ chỉ là vỏ chatbot hay vật trang trí.

- Mọi task của AI Employee PHẢI được thực thi thật và trả về artifact hoặc kết quả có thể kiểm
  chứng. Animation, chat hay trạng thái không dựa trên việc thực thi thật KHÔNG ĐƯỢC phát hành.
- Mọi hội thoại (Company, Department, Team, Direct Message, Meeting) PHẢI gắn với một task hoặc
  hoạt động thật. Cấm tạo chat giả hoặc chat độn chỉ để văn phòng trông sinh động.
- XP, Level, Achievement và Reward chỉ là lớp trải nghiệm. Chúng KHÔNG ĐƯỢC thay thế hay làm sai
  lệch việc đánh giá năng suất thực tế, và KHÔNG ĐƯỢC cấp chỉ vì dùng nhiều token hay chạy lâu.

Lý do: giá trị của sản phẩm là một lực lượng lao động AI thật. Hoạt động giả lập làm mất niềm tin
của người dùng và khiến dữ liệu hiệu suất vô nghĩa.

### II. Con người lãnh đạo và quyền hạn theo cấp (NON-NEGOTIABLE)
Con người định hướng, review và phê duyệt; AI thực thi trong phạm vi quyền hạn được cấp.

- Mỗi AI Employee PHẢI có một Manager trực tiếp (người thật hoặc AI), và mọi chuỗi quản lý AI
  PHẢI kết thúc ở một người thật chịu trách nhiệm.
- Mỗi hành động PHẢI được phân vào một trong bốn mức quyền: **Auto Execute**,
  **Review Required**, **Human Approval**, **Restricted**. Hành động chưa phân loại mặc định là
  Restricted.
- Các hành động nhạy cảm (gồm gửi email, xóa dữ liệu và deploy, đặc biệt là lên production) PHẢI
  yêu cầu Human Approval theo chính sách, do hệ thống cưỡng chế, không chỉ dựa vào câu chữ trong
  prompt.
- Kết quả task PHẢI đi qua quy trình đã định: Human Manager đặt mục tiêu và tiêu chí nghiệm thu →
  AI Manager phân tích, chia nhỏ và giao việc → AI Employees thực hiện → AI Manager kiểm tra →
  Human Manager phê duyệt theo quyền hạn.
- Mọi phê duyệt, từ chối và yêu cầu làm lại PHẢI được ghi nhận kèm người thực hiện, thời điểm và
  lý do.

Lý do: chỉ có thể giao việc cho AI một cách an toàn khi quyền hạn rõ ràng, có giới hạn và có thể
truy vết.

### III. Tổ chức do người dùng định nghĩa, cô lập ngay từ thiết kế
Người dùng tự xây dựng công ty; hệ thống không được ép một template cố định.

- Mô hình miền PHẢI hỗ trợ cấu trúc Company → Division → Department → Team → Employee (AI hoặc
  người thật) do người dùng tự định nghĩa. Cơ cấu mẫu (ví dụ công ty phần mềm) là template,
  không bao giờ là ràng buộc cứng trong code.
- Một người thật PHẢI có thể được gán làm manager của một AI Employee, một Team hoặc một
  Department. Phạm vi quản lý PHẢI quyết định khả năng xem, giao việc và quyền review.
- Một AI Employee CÓ THỂ thuộc nhiều team hoặc dự án; hệ thống PHẢI theo dõi workload, mức ưu
  tiên và số task đồng thời để tránh quá tải.
- Cô lập đa người dùng và đa tổ chức PHẢI được thiết kế từ mô hình dữ liệu đầu tiên. Phân quyền
  PHẢI cưỡng chế được theo tổ chức, phòng ban, team, task và tài liệu. Không tính năng nào được
  giả định chỉ có một công ty toàn cục hay một người dùng duy nhất.

Lý do: vá đa tenant và phân quyền vào mô hình một công ty về sau vừa tốn kém vừa rủi ro bảo mật.

### IV. Tiến độ trung thực và trực quan
Virtual Office là giao diện chính và phải phản ánh đúng thực tế.

- Trạng thái nhân viên (Idle, Working, Thinking, Communicating, Meeting, Waiting Approval,
  Completed, Error/Blocked, Break) PHẢI suy ra từ sự kiện agent/task thật, không bao giờ ngẫu
  nhiên.
- Thay đổi trạng thái PHẢI lan truyền theo thời gian thực (WebSocket hoặc tương đương) từ một
  nguồn trạng thái duy nhất có thẩm quyền (Office Simulation Engine).
- Employee Profile PHẢI hiển thị tối thiểu: task hiện tại và tiến độ, công cụ đang dùng và trạng
  thái runtime, các trao đổi liên quan, kết quả gần nhất và lịch sử review, token usage và chi
  phí, cùng các blocker.
- Phong cách hiển thị (pixel art 2D, isometric) là lựa chọn trình bày và PHẢI tách khỏi tầng
  domain và engine, để có thể đổi mà không động đến logic nghiệp vụ.

Lý do: "Work as Play" chỉ có ý nghĩa khi bề mặt trò chơi là góc nhìn trung thực của công việc.

### V. Quản trị chi phí và năng lực xử lý
Chi phí AI và mức đồng thời là tài nguyên hạng nhất, được cưỡng chế.

- Hệ thống PHẢI hỗ trợ giới hạn token, ngân sách, số task đồng thời theo employee/team, và các
  model được phép dùng, ở phạm vi company, department, team và employee.
- Token usage và chi phí vận hành AI PHẢI được đo theo từng task và từng employee, và hiển thị
  trong Company Dashboard và Employee Profile.
- Task sắp vượt giới hạn PHẢI bị chặn hoặc chuyển lên người thật; KHÔNG ĐƯỢC âm thầm vượt mức.

Lý do: AI tự chủ không có ngân sách được cưỡng chế sẽ tạo ra chi phí không giới hạn và không thể
dự đoán.

### VI. Kiến trúc độc lập model, tách biệt theo engine
Claude Company là lớp điều phối, không phải lớp giao diện mỏng bọc Claude Code.

- Mọi truy cập model PHẢI đi qua một abstraction layer để Claude và các model khác có thể thay
  thế nhau theo từng AI Employee. Code tính năng KHÔNG ĐƯỢC gọi trực tiếp SDK của nhà cung cấp
  model.
- Trách nhiệm PHẢI được tách thành các engine riêng với interface rõ ràng: Organization,
  Employee, Task, Orchestration, Memory, Communication, Permission, Gamification và Office
  Simulation. Một engine KHÔNG ĐƯỢC truy cập vào kho lưu trữ nội bộ của engine khác.
- Claude Code (Hooks, Subagents, MCP) NÊN dùng cho các vai trò làm việc với source code như AI
  Developer. Các vai trò như BA, PM, HR và Marketing NÊN dùng Claude API hoặc agent workflow
  chuyên biệt. Lựa chọn này PHẢI là cấu hình theo từng employee, không phải giả định toàn cục.
- Hồ sơ AI Employee (Name/Avatar, Position/Department, Personality, Skills/Seniority, AI Model,
  System Prompt, Tools, Manager, Status/Performance) là hợp đồng giữa Employee Engine và phần
  còn lại của hệ thống.

Lý do: ranh giới engine và lớp trừu tượng model giúp sản phẩm mở rộng vượt khỏi một nhà cung cấp,
một loại vai trò và một giao diện.

### VII. Chất lượng dựa trên bằng chứng, độ tin cậy và khả năng quan sát
"Hoàn thành" đòi hỏi bằng chứng.

- Mỗi task PHẢI có: mục tiêu, người giao, assignee, deadline, priority, acceptance criteria, đầu
  ra mong đợi và trạng thái. Task KHÔNG ĐƯỢC đánh dấu hoàn thành nếu thiếu bằng chứng hoàn thành
  đối chiếu với acceptance criteria.
- Đầu ra PHẢI review được một cách độc lập với agent tạo ra nó (AI Manager, reviewer hoặc người
  thật), và kết quả approve / reject / rework PHẢI được ghi nhận.
- Mọi lần chạy agent PHẢI sinh log, trace, trạng thái runtime, lỗi và lịch sử thực thi, truy vấn
  được theo từng task và từng employee.
- Workflow PHẢI định nghĩa timeout và retry, xử lý task lỗi một cách tường minh, và phục hồi
  được sau crash hoặc restart mà không mất hay lặp công việc.

Lý do: chất lượng và niềm tin vào lực lượng lao động AI đến từ bằng chứng kiểm chứng được và lỗi
chẩn đoán được, không phải từ lời tự báo cáo của agent.

### VIII. Phát triển tăng dần, ưu tiên MVP
Bắt đầu nhỏ và thật; chỉ mở rộng sau khi phần lõi chạy được.

- Việc phát triển PHẢI theo thứ tự các phase: (1) Company/Department/Employee/Organization →
  (2) AI Employee, AI Manager, Task Assignment → (3) Virtual Office, Animation, Realtime →
  (4) Team Collaboration, Chat, Review → (5) XP, Level, Achievement, Upgrade →
  (6) Multi-company, Multi-user, Billing. Không được bắt đầu một phase sau theo cách làm hỏng
  phạm vi đang chạy tốt của phase trước.
- Phạm vi MVP gồm: một công ty với ba phòng ban (Development, BA, QA); một người thật đóng vai
  CEO/Manager; khoảng 5–10 AI Employees; tạo theo mẫu hoặc tùy chỉnh; giao nhân viên AI hoặc
  team cho người thật quản lý; AI Manager tự chia task; Task Board với kết quả thực thi thật;
  văn phòng pixel art 2D với trạng thái realtime; thống kê chi phí AI và tiến độ.
- Hệ thống XP phức tạp, nhiều loại tài sản ảo và multiplayer KHÔNG ĐƯỢC đưa vào MVP. Gamification
  trong MVP chỉ giới hạn ở mức đủ tạo trải nghiệm thú vị.
- Độ phức tạp vượt quá phase hiện tại PHẢI được biện minh bằng văn bản (YAGNI), nhưng mô hình dữ
  liệu KHÔNG ĐƯỢC chặn các phase sau (xem Nguyên tắc III).

Lý do: ý tưởng sản phẩm rất rộng; chia phase có kỷ luật giúp mỗi bản tăng trưởng đều phát hành
được và là thật.

## Ràng buộc về công nghệ và kiến trúc

- **Stack mặc định** (theo Product Concept): React + TypeScript (frontend), PixiJS (office
  rendering), Node.js + NestJS (backend), PostgreSQL (database), Redis (cache/queue), WebSocket
  (realtime), Claude API + Claude Code (tích hợp AI), custom agent runtime (orchestration), lưu
  trữ tương thích S3 (file), Docker (deployment). Việc đi chệch khỏi stack PHẢI được biện minh
  trong plan của tính năng và KHÔNG ĐƯỢC vi phạm Nguyên tắc III và VI.
- **Xác minh trước khi dựa vào**: các giả định về khả năng của Claude hoặc Claude Code (Hooks,
  Subagents, MCP, hành vi API) PHẢI được kiểm chứng với tài liệu chính thức hiện hành trước khi
  một plan phụ thuộc vào chúng. Product Concept là tài liệu định hướng, không phải tuyên bố về
  các tính năng đã có của nền tảng.
- **Nền tảng bảo mật**: phân quyền PHẢI được cưỡng chế phía server ở mọi request theo các phạm vi
  trong Nguyên tắc III; secret KHÔNG BAO GIỜ được lưu trong source control hoặc để lộ ra client;
  quyền truy cập công cụ và credential cấp cho AI Employee PHẢI theo nguyên tắc đặc quyền tối
  thiểu.
- **Quyền sở hữu dữ liệu**: nội dung của Memory Engine (kiến thức, ngữ cảnh, lịch sử làm việc)
  PHẢI giới hạn trong tổ chức của nó và KHÔNG ĐƯỢC rò rỉ giữa các tổ chức, team hoặc employee nếu
  không có quy tắc chia sẻ tường minh.
- **Deployment**: mọi service PHẢI chạy được bằng Docker kèm cấu hình có tài liệu; giá trị riêng
  theo môi trường PHẢI lấy từ cấu hình, không nằm trong code.

## Quy trình phát triển và cổng chất lượng

- **Quy trình theo spec**: tính năng đi theo specify → clarify → plan → tasks → implement. Mỗi
  feature spec PHẢI nêu rõ thuộc phase nào (Nguyên tắc VIII).
- **Constitution Check**: mỗi plan PHẢI có một cổng kiểm tra tuân thủ Nguyên tắc I–VIII trước
  bước research và kiểm tra lại sau bước thiết kế. Vi phạm PHẢI được ghi vào bảng
  complexity/justification của plan, hoặc thiết kế PHẢI thay đổi.
- **Kiểm thử**: hành vi cưỡng chế phân quyền, phê duyệt, giới hạn ngân sách, cô lập tenant và
  lan truyền trạng thái PHẢI có test tự động. Contract test PHẢI bao phủ từng interface của
  engine và abstraction layer của model. Mỗi bản sửa lỗi PHẢI kèm một regression test.
- **Definition of Done** của một tính năng: đạt acceptance criteria kèm bằng chứng; đã gán mức
  quyền cho mọi hành động mới; đã có đo chi phí và logging cho mọi hành vi agent mới; tài liệu
  được cập nhật.
- **Review**: mỗi thay đổi PHẢI được review bởi người khác tác giả, và review PHẢI xác nhận sự
  tuân thủ constitution. Thay đổi chạm vào Permission, Task hoặc Orchestration engine, hoặc cô
  lập tenant, cần được xem xét kỹ hơn.
- **Demo hành vi thật**: demo tính năng agent PHẢI dùng đầu ra thực thi thật, không dùng animation
  giả lập hay kịch bản dựng sẵn.

## Governance

Constitution này đứng trên mọi thực hành, template và quy ước khác của dự án Claude Company. Khi
một tài liệu khác mâu thuẫn với nó, constitution được ưu tiên.

- **Quy trình sửa đổi**: một sửa đổi PHẢI được đề xuất bằng văn bản kèm lý do, các nguyên
  tắc/mục bị ảnh hưởng và kế hoạch di chuyển cho spec, plan và code hiện có. Sửa đổi chỉ có hiệu
  lực sau khi chủ dự án phê duyệt và Báo cáo Tác động Đồng bộ (Sync Impact Report) đã được rà
  soát. `/speckit-constitution` là cơ chế để áp dụng sửa đổi.
- **Chính sách đánh phiên bản** (semantic versioning): MAJOR cho việc xóa hoặc định nghĩa lại
  nguyên tắc theo cách không tương thích ngược; MINOR cho việc thêm nguyên tắc hoặc mục mới, hoặc
  mở rộng đáng kể hướng dẫn; PATCH cho làm rõ, chỉnh câu chữ và sửa lỗi chính tả. Các nguyên tắc
  đánh dấu NON-NEGOTIABLE chỉ được thay đổi bằng sửa đổi MAJOR.
- **Rà soát tuân thủ**: mọi plan (Constitution Check) và mọi code review PHẢI xác minh sự tuân
  thủ. Vi phạm không có biện minh sẽ chặn merge. Ngoại lệ có biện minh PHẢI được ghi trong plan
  của tính năng, kèm phương án đơn giản hơn đã bị loại và lý do.
- **Rà soát định kỳ**: constitution PHẢI được rà soát khi kết thúc mỗi phase phát triển (Nguyên
  tắc VIII) để xác nhận nó vẫn phản ánh đúng thực tế sản phẩm.
- **Hướng dẫn khi vận hành**: tài liệu Product Concept
  (`ref/Claude_Company_Product_Concept_V1.docx`) là nguồn ý định sản phẩm; khi mâu thuẫn với
  constitution này, constitution chi phối cho đến khi được sửa đổi. Quy ước ngôn ngữ làm việc
  nằm trong `CLAUDE.md`.

**Version**: 1.0.1 | **Ratified**: 2026-11-09 | **Last Amended**: 2026-11-09
