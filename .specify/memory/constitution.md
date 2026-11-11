<!--
BÁO CÁO TÁC ĐỘNG ĐỒNG BỘ (chỉ để rà soát tạm thời; xóa trước khi commit)
- Thay đổi phiên bản: 1.2.0 → 1.3.0  [MINOR]
- Lý do: bổ sung mô hình phân phối "đóng gói chạy trên một PC bất kỳ, không server, không phụ
  thuộc cloud" và chính sách vận hành "script trước, AI khi cần; ưu tiên tài khoản subscription".
  Thêm hai nguyên tắc mới (X, XI) và mở rộng đáng kể ràng buộc công nghệ/deployment. Không xóa
  hay định nghĩa lại nguyên tắc I–IX; các nguyên tắc NON-NEGOTIABLE giữ nguyên nội dung. Quy tắc
  "Deployment" (Docker bắt buộc) bị thay thế, nhưng đây là nới lỏng một phương tiện để đạt
  Nguyên tắc X, không phải đảo ngược nguyên tắc, nên chọn MINOR (ranh giới với MAJOR, xem phần
  tóm tắt cho người dùng).
- Nguyên tắc thêm: X. Tự chứa, chạy cục bộ trên một PC (NON-NEGOTIABLE);
  XI. Script trước, AI khi cần; ưu tiên tài khoản subscription.
- Nguyên tắc sửa: V (thêm bullet đo và xử lý quota của tài khoản subscription); VI (đường truy
  cập model theo Nguyên tắc XI, bỏ khuyến nghị mặc định dùng Claude API cho BA/PM/HR/Marketing).
  I–IV, VII–IX giữ nguyên.
- Mục sửa khác: "Ràng buộc về công nghệ" (stack: lưu file cục bộ thay S3 bắt buộc, PostgreSQL/Redis
  phải đóng gói cục bộ, Docker thành tùy chọn; bullet Deployment thay bằng "Đóng gói và chạy cục
  bộ"); "Quy trình phát triển" (Constitution Check I–IX → I–XI; DoD thêm script vận hành, biện
  minh bước AI, chạy được trên bản đóng gói); Governance (không đổi cơ chế).
- Mục xóa: bullet "Deployment: mọi service PHẢI chạy được bằng Docker" (được thay thế).
- Việc cần theo dõi (TODO):
  - Phase 6 (Multi-company, Multi-user, Billing) cần xem lại phạm vi vì Billing và đa người dùng
    từ xa xung đột với mô hình PC cục bộ; chưa sửa Nguyên tắc VIII, xử lý khi tới phase đó.
  - Hiện trạng code còn dấu vết cloud/server (@aws-sdk/client-s3, scripts/dev-s3.mjs, thư mục
    docker/): cần đánh giá độ lệch so với Nguyên tắc X (xem Next Actions).
  - Kiểm chứng điều khoản và khả năng dùng tài khoản subscription qua công cụ chính thức với tài
    liệu hiện hành trước khi plan phụ thuộc vào nó (Nguyên tắc XI).
- Template/lệnh liên quan: không sửa theo phạm vi lệnh này; các lệnh Spec Kit đọc constitution
  khi chạy.
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
- Với đường truy cập bằng tài khoản subscription (Nguyên tắc XI), "chi phí" được đo bằng mức tiêu
  thụ quota (lượt, token, cửa sổ thời gian) thay vì tiền theo token. Hệ thống PHẢI nhận biết và
  xử lý tường minh việc chạm giới hạn của nhà cung cấp (xếp hàng, tạm dừng hoặc chuyển người
  thật), và giới hạn số task đồng thời PHẢI tính đến rate limit của subscription.

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
  Developer. Các vai trò như BA, PM, HR và Marketing NÊN dùng agent workflow chuyên biệt hoặc
  Claude API. Đường truy cập (subscription hay API key) tuân theo Nguyên tắc XI. Lựa chọn này
  PHẢI là cấu hình theo từng employee, không phải giả định toàn cục.
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
- Năng lực Dynamic Agency Harness (Nguyên tắc IX) PHẢI đi theo thang tăng dần: (a) Dynamic Team
  Builder: Task Profile, Capability Matching, Team Assembly, chế độ Solo/Sequential/Parallel →
  (b) Adaptive Orchestration: DAG với checkpoint, thêm/bỏ/thay Agent khi đang chạy, quality gate →
  (c) Autonomous Agency: học và tái sử dụng Team Pattern, đánh giá hiệu suất dài hạn,
  multi-project. Mức (c) KHÔNG ĐƯỢC đưa vào MVP; mỗi feature spec chạm tới Harness PHẢI nêu rõ
  thuộc mức (a), (b) hay (c).
- Độ phức tạp vượt quá phase hiện tại PHẢI được biện minh bằng văn bản (YAGNI), nhưng mô hình dữ
  liệu KHÔNG ĐƯỢC chặn các phase sau (xem Nguyên tắc III).

Lý do: ý tưởng sản phẩm rất rộng; chia phase có kỷ luật giúp mỗi bản tăng trưởng đều phát hành
được và là thật.

### IX. Điều phối động theo task (Dynamic Agency Harness)
Claude Company là lớp trải nghiệm tổ chức ảo; Dynamic Agency Harness (DAH) là lõi thực thi: phân
tích yêu cầu, chọn năng lực, lắp đội, lập workflow và điều chỉnh đội hình khi đang chạy.

- **Bắt đầu từ task**: mỗi yêu cầu PHẢI được phân tích thành một Task Profile (tối thiểu:
  task_type, domain, complexity, deliverables, constraints, risk, approval requirements) trước
  khi lắp đội. Hệ thống KHÔNG ĐƯỢC gắn cứng một bộ Skill hoặc danh sách Agent cho mọi công việc.
- **Đội nhỏ nhất đủ dùng**: Team Instance PHẢI dùng số thành viên nhỏ nhất đáp ứng chất lượng và
  thời hạn, và PHẢI bị chặn bởi ngân sách và mức đồng thời theo Nguyên tắc V. Chế độ thực thi
  (Solo, Specialist, Sequential, Parallel, Hierarchical, Hybrid) PHẢI được chọn theo Task
  Profile, không mặc định luôn dùng nhiều Agent.
- **Tách danh tính khỏi runtime**: Agent Template (hoặc AI Employee) có danh tính ổn định và được
  tái sử dụng; mỗi lần chạy tạo một Agent Instance với tập Skill, Tool, context và quyền riêng.
  Skill và Tool PHẢI được nạp theo task, và việc nạp KHÔNG ĐƯỢC mở rộng quyền vượt mức đã cấp cho
  employee và task (Nguyên tắc II). Agent Template và Skill PHẢI có metadata và version; mục nhập
  từ nguồn bên ngoài PHẢI được kiểm schema và KHÔNG tự động được cấp Tool hay quyền.
- **Người thật giữ quyền quyết định**: đội hình do Harness đề xuất KHÔNG ĐƯỢC ghi đè việc giao
  việc tường minh của manager. Đội hình hoặc thay đổi đội hình làm vượt ngưỡng chi phí, có hành
  động nhạy cảm hoặc rủi ro cao PHẢI chờ Human Approval. Mọi thành viên của Team Instance vẫn
  PHẢI có Manager và chuỗi quản lý kết thúc ở một người thật.
- **Cộng tác qua artifact**: Agent trao đổi qua Task, Artifact, kết quả có cấu trúc và bằng chứng,
  không chỉ qua hội thoại. Agent hoàn thành PHẢI giải phóng runtime và context nhưng PHẢI giữ lại
  Artifact để Agent khác dùng.
- **Workflow có thể truy vết**: workflow PHẢI là DAG có version, kèm dependency, checkpoint,
  idempotency và event log, để lập lại kế hoạch không làm mất hay lặp công việc (Nguyên tắc VII).
- **Tái cấu hình có căn cứ**: quyết định thêm, bỏ, thay Agent, giao lại, retry hoặc re-plan PHẢI
  dựa trên điều kiện kiểm chứng được (trạng thái task, kiểm tra deliverable, quality score, ngân
  sách, lịch sử hiệu suất), KHÔNG ĐƯỢC chỉ dựa vào nhận định tự do của một LLM. Mỗi quyết định
  PHẢI được ghi lại kèm lý do.
- **Đánh giá và tái sử dụng**: hệ thống PHẢI đo hiệu suất, chi phí và chất lượng ở cấp Agent,
  Team và Workflow. Team Pattern chỉ được lưu và tái sử dụng trong phạm vi tổ chức của nó
  (Nguyên tắc III) và dựa trên kết quả đã được kiểm chứng.
- **Không phá ranh giới engine**: các thành phần Harness (Task Intelligence, Agent Discovery, Team
  Assembly, Workflow Planner, Agent Runtime, Quality & Governance, Adaptive Orchestrator,
  Learning & Evaluation) PHẢI được đặt trong các engine hiện có hoặc engine mới có interface rõ
  ràng (Nguyên tắc VI), và PHẢI đi qua model abstraction layer.

Lý do: một lực lượng AI có giá trị khi đội hình khớp với từng công việc và điều chỉnh được giữa
chừng; nhưng tự chủ chỉ an toàn khi mọi quyết định lắp đội và tái cấu hình đều có giới hạn, có
căn cứ và truy vết được.

### X. Tự chứa, chạy cục bộ trên một PC (NON-NEGOTIABLE)
Claude Company là một ứng dụng đóng gói: người dùng cài hoặc giải nén rồi chạy trên máy của
mình. Sản phẩm không đòi hỏi server vận hành riêng, quy trình deploy hay hạ tầng cloud.

- **Chạy trên PC bất kỳ**: bản phân phối PHẢI chạy được trên một PC thông thường của người dùng,
  không cần máy chủ, không cần deploy, bằng một launcher hoặc một lệnh. Danh sách hệ điều hành
  được hỗ trợ PHẢI nêu trong plan; Windows là nền tảng kiểm chứng tối thiểu.
- **Không phụ thuộc cloud**: KHÔNG ĐƯỢC bắt buộc dịch vụ cloud hay dịch vụ bên thứ ba cho chức năng
  lõi (database/queue/storage managed, định danh, telemetry, license server…). Cuộc gọi tới nhà
  cung cấp model AI là ngoại lệ duy nhất, do người dùng cấu hình (Nguyên tắc XI). Mọi chức năng
  không cần AI (quản lý tổ chức, task board, văn phòng, thống kê) PHẢI hoạt động khi không có
  mạng.
- **Hạ tầng đi kèm**: database, queue, lưu trữ file và các thành phần runtime khác PHẢI được đóng
  gói hoặc do launcher tự khởi chạy cục bộ (hoặc thay bằng bản nhúng). Người dùng KHÔNG PHẢI tự
  cài và cấu hình dịch vụ hạ tầng bằng tay; Docker KHÔNG ĐƯỢC là điều kiện bắt buộc trên máy
  chạy. Các điều kiện tiên quyết còn lại (nếu có) PHẢI được liệt kê và kiểm tra tự động khi khởi
  động.
- **Dữ liệu cục bộ và an toàn**: dữ liệu PHẢI nằm trong một thư mục dữ liệu cấu hình được và PHẢI
  sao lưu, khôi phục, xuất được bằng script. Dữ liệu KHÔNG ĐƯỢC rời máy, trừ nội dung của các lời
  gọi model đã được phân quyền theo Nguyên tắc II. Service mặc định PHẢI chỉ lắng nghe trên
  loopback (127.0.0.1); mở ra mạng LAN PHẢI là lựa chọn tường minh của người dùng, mặc định tắt.
- **Cô lập vẫn giữ nguyên**: chế độ chạy cục bộ là một cách triển khai, không phải lý do bỏ mô
  hình đa tổ chức, đa người dùng và phân quyền (Nguyên tắc III).

Lý do: giá trị của sản phẩm phải đến được tay người dùng mà không cần vận hành hạ tầng; phụ thuộc
cloud làm tăng chi phí, rủi ro lộ dữ liệu và làm sản phẩm không dùng được khi ngoại tuyến.

### XI. Script trước, AI khi cần; ưu tiên tài khoản subscription
Vận hành càng nhiều càng tốt bằng script xác định; AI chỉ dùng cho phần thật sự cần phán đoán, và
việc truy cập AI ưu tiên tài khoản subscription của người dùng.

- **Script là mặc định cho vận hành**: các tác vụ vận hành (cài đặt, khởi động/dừng, migrate,
  seed, backup/restore, health check, dọn dẹp, build/đóng gói, kiểm tra, tổng hợp báo cáo) PHẢI
  được tự động hóa bằng script có hành vi xác định, chạy lại an toàn (idempotent), in kết quả rõ
  ràng và trả exit code đúng. Script PHẢI chạy được mà không cần AI hay mạng.
- **AI chỉ khi script không đủ**: mỗi bước dùng AI trong luồng vận hành hoặc luồng hệ thống PHẢI
  được biện minh trong plan (vì sao quy tắc hoặc script xác định không đáp ứng được: cần hiểu
  ngôn ngữ tự nhiên, sinh nội dung, phán đoán mơ hồ). Việc kiểm tra được bằng điều kiện xác định
  (trạng thái, schema, kiểm tra deliverable) PHẢI dùng logic xác định (Nguyên tắc IX).
- **Ưu tiên subscription**: model abstraction layer (Nguyên tắc VI) PHẢI hỗ trợ chế độ xác thực
  bằng tài khoản subscription của người dùng và PHẢI ưu tiên chế độ này hơn API key tính phí theo
  token. API key chỉ là phương án dự phòng, do người dùng cấu hình tường minh, và giao diện PHẢI
  cho thấy rõ khi đang dùng đường tính phí theo token.
- **Không tự chuyển sang đường tính phí**: khi subscription hết quota hoặc chưa đăng nhập, hệ
  thống PHẢI báo rõ và xếp hàng, tạm dừng hoặc chuyển người thật (Nguyên tắc V). KHÔNG ĐƯỢC tự
  động chuyển sang API key nếu người dùng chưa cho phép tường minh.
- **Dùng đúng cách chính thức**: việc dùng subscription PHẢI đi qua cơ chế đăng nhập và công cụ
  chính thức của nhà cung cấp, trong phạm vi điều khoản dịch vụ hiện hành. Claude Company KHÔNG
  ĐƯỢC trích xuất, sao chép, lưu riêng hay chia sẻ token đăng nhập của người dùng, và KHÔNG ĐƯỢC
  dùng một tài khoản để phục vụ người khác. Khả năng và điều khoản này PHẢI được kiểm chứng với
  tài liệu hiện hành (xem "Xác minh trước khi dựa vào").

Lý do: script rẻ, nhanh, tái lập được và không tốn quota; AI đắt và không xác định nên chỉ dành
cho việc cần phán đoán. Tài khoản subscription có chi phí cố định, phù hợp mô hình chạy cá nhân
trên một PC, nhưng chỉ an toàn khi dùng đúng điều khoản và có xử lý giới hạn quota.

## Ràng buộc về công nghệ và kiến trúc

- **Stack mặc định** (theo Product Concept): React + TypeScript (frontend), PixiJS (office
  rendering), Node.js + NestJS (backend), PostgreSQL (database), Redis (cache/queue), WebSocket
  (realtime), tích hợp AI qua model abstraction layer (ưu tiên Claude Code đăng nhập bằng tài
  khoản subscription; Claude API là phương án dự phòng, theo Nguyên tắc XI), custom agent runtime
  (orchestration), lưu file trên hệ thống tệp cục bộ (adapter tương thích S3 chỉ là tùy chọn,
  không bắt buộc). PostgreSQL và Redis là mặc định nhưng PHẢI được đóng gói hoặc khởi chạy cục
  bộ theo Nguyên tắc X; phương án nhúng (ví dụ SQLite, hàng đợi trong tiến trình) CÓ THỂ thay thế
  nếu plan biện minh. Việc đi chệch khỏi stack PHẢI được biện minh trong plan của tính năng và
  KHÔNG ĐƯỢC vi phạm Nguyên tắc III, VI và X. Các gợi ý công nghệ trong
  tài liệu Harness (Python + FastAPI, pgvector cho semantic discovery, custom DAG engine, định
  nghĩa Agent/Skill bằng Markdown + YAML, MCP) chỉ là tham khảo; mỗi gợi ý PHẢI được đánh giá và
  biện minh trong plan trước khi dùng, và định nghĩa Agent/Skill PHẢI có schema và version.
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
- **Đóng gói và chạy cục bộ**: bản phân phối PHẢI có script một lệnh để cài đặt, khởi động, dừng,
  migrate, backup/restore và kiểm tra sức khỏe (Nguyên tắc X, XI). Docker CÓ THỂ dùng như tiện
  ích cho phát triển hoặc kênh phân phối tùy chọn, nhưng KHÔNG ĐƯỢC là điều kiện bắt buộc trên
  PC chạy ứng dụng. Giá trị riêng theo máy PHẢI lấy từ cấu hình, không nằm trong code; secret
  PHẢI lưu cục bộ ngoài source control.

## Quy trình phát triển và cổng chất lượng

- **Quy trình theo spec**: tính năng đi theo specify → clarify → plan → tasks → implement. Mỗi
  feature spec PHẢI nêu rõ thuộc phase nào (Nguyên tắc VIII).
- **Constitution Check**: mỗi plan PHẢI có một cổng kiểm tra tuân thủ Nguyên tắc I–XI trước
  bước research và kiểm tra lại sau bước thiết kế. Vi phạm PHẢI được ghi vào bảng
  complexity/justification của plan, hoặc thiết kế PHẢI thay đổi.
- **Kiểm thử (tối giản theo chi phí)**: dự án KHÔNG áp dụng test-first và chưa yêu cầu e2e test.
  Cài đặt đi trước, test bổ sung sau. Chỉ bắt buộc unit test cho các hành vi có rủi ro cao nếu
  hỏng: cưỡng chế phân quyền, phê duyệt, giới hạn ngân sách và cô lập tenant. Contract test chỉ
  bắt buộc cho abstraction layer của model và các interface engine được nhiều engine khác gọi
  tới. Regression test chỉ bắt buộc cho lỗi thuộc các nhóm hành vi trên. E2e test sẽ được xem
  xét lại khi tới phase phát hành.
- **Definition of Done** của một tính năng: đạt acceptance criteria kèm bằng chứng; đã gán mức
  quyền cho mọi hành động mới; đã có đo chi phí và logging cho mọi hành vi agent mới; mọi quyết
  định lắp hoặc tái cấu hình team mới đều được ghi lý do (Nguyên tắc IX); tác vụ vận hành mới có
  script và mỗi bước AI mới có biện minh (Nguyên tắc XI); chạy được trên bản đóng gói cục bộ mà
  không cần server hay cloud (Nguyên tắc X); tài liệu được cập nhật.
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
  (`ref/Claude_Company_Product_Concept_V1.docx`) và tài liệu Dynamic Agency Harness
  (`ref/Dynamic_Agency_Harness_Idea.docx`) là nguồn ý định sản phẩm; khi mâu thuẫn với
  constitution này, constitution chi phối cho đến khi được sửa đổi. Quy ước ngôn ngữ làm việc
  nằm trong `CLAUDE.md`.

**Version**: 1.3.0 | **Ratified**: 2026-11-09 | **Last Amended**: 2026-11-11
