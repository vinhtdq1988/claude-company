import { expect, test, type Page } from '@playwright/test';

/**
 * Kịch bản Q3 (task thật trực tiếp) và Q5 (rework, reject rồi resume, cancel) của quickstart.md, chạy với
 * `MODEL_PROVIDER=fake` nên tất định và không tốn token. Cần stack đang chạy (`pnpm dev` hoặc Docker Compose,
 * gồm worker, Redis và MinIO) và dữ liệu seed (`pnpm db:seed`); địa chỉ web đặt qua `E2E_BASE_URL`.
 */

const PASSWORD = 'mat-khau-manh-123';
const SLOW = { timeout: 90_000 };

const hireForm = (page: Page) => page.getByRole('form', { name: 'Tuyển AI Employee' });
const statusBadge = (page: Page) => page.locator('.task-detail > header .badge').first();

async function hire(page: Page, template: string, name: string, unit: string, manager: string) {
  await page.getByRole('link', { name: 'AI Employee' }).click();
  await page.getByRole('button', { name: 'Tuyển AI Employee' }).click();
  const form = hireForm(page);
  await form.getByLabel('Mẫu vai trò').selectOption({ label: template });
  await form.getByLabel('Tên', { exact: true }).fill(name);
  await form.getByLabel('Department', { exact: true }).selectOption({ label: unit });
  await form.getByLabel('Manager trực tiếp').selectOption({ label: manager });
  await form.getByRole('button', { name: 'Tuyển dụng' }).click();
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
}

/** Công ty mới với CEO, một AI Manager và một AI BA báo cáo cho AI Manager. */
async function setupCompany(page: Page) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const ceo = `CEO ${suffix}`;
  await page.goto('/register');
  await page.getByLabel('Tên hiển thị').fill(ceo);
  await page.getByLabel('Email').fill(`ceo-${suffix}@example.com`);
  await page.getByLabel('Mật khẩu').fill(PASSWORD);
  await page.getByRole('button', { name: 'Tạo tài khoản' }).click();
  await page.getByLabel('Tên công ty').fill(`Công ty ${suffix}`);
  await page.getByRole('button', { name: 'Tạo công ty' }).click();
  await expect(page).toHaveURL(/\/c\/[^/]+\/org$/);

  await hire(page, 'AI Manager', 'Quản lý Dev', 'Development', ceo);
  await hire(page, 'AI Business Analyst', 'BA Một', 'BA', 'Quản lý Dev');
}

/** Tạo task giao cho BA Một rồi mở chi tiết task vừa tạo. */
async function createTask(page: Page, title: string) {
  await page.getByRole('link', { name: 'Task Center' }).click();
  await page.getByRole('button', { name: 'Tạo task' }).click();
  const form = page.getByRole('form', { name: 'Tạo task' });
  await form.getByLabel('Tiêu đề', { exact: true }).fill(title);
  await form
    .getByLabel('Mục tiêu', { exact: true })
    .fill('Phân tích tài liệu docs/requirements.md và viết báo cáo rủi ro');
  await form
    .getByLabel('Người nhận', { exact: true })
    .selectOption({ label: 'BA Một · AI Business Analyst' });
  await form.getByLabel('Hạn chót', { exact: true }).fill('2027-12-31T09:00');
  await form.getByLabel('Mức ưu tiên', { exact: true }).selectOption({ label: 'Cao' });
  await form
    .getByLabel('Acceptance criteria (mỗi dòng một tiêu chí)')
    .fill('Nêu đủ yêu cầu chức năng\nNêu các rủi ro chính');
  await form.getByLabel('Kết quả mong đợi', { exact: true }).fill('Báo cáo rủi ro');
  await form.getByRole('button', { name: 'Tạo và giao ngay' }).click();
  await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible();
}

/** Chờ trạng thái; tải lại trang nếu sự kiện realtime đến muộn để test không phụ thuộc thời điểm socket. */
async function waitForStatus(page: Page, label: string) {
  await expect(async () => {
    if ((await statusBadge(page).textContent())?.trim() !== label) await page.reload();
    await expect(statusBadge(page)).toHaveText(label, { timeout: 3_000 });
  }).toPass(SLOW);
}

async function decide(page: Page, button: string, reason: string | null) {
  const panel = page.getByRole('form', { name: 'Quyết định của Human Manager' });
  if (reason !== null) await panel.getByLabel('Lý do (bắt buộc)').fill(reason);
  await panel.getByRole('button', { name: button }).click();
}

test.describe('Q3, Q5: giao việc, review, phê duyệt, rework (US3)', () => {
  test('Q3: task chạy thật đến artifact, evidence từng criterion rồi Approve → completed', async ({
    page,
  }) => {
    await setupCompany(page);
    await createTask(page, 'Phân tích rủi ro Q3');

    // AI Manager xác nhận, BA thực thi, AI Manager review độc lập.
    await waitForStatus(page, 'Chờ Human Approval');
    await expect(page.getByRole('region', { name: 'Kế hoạch phân rã' })).toContainText(
      'xác nhận phân công',
    );

    // Artifact mở xem được và có nội dung.
    const artifacts = page.getByRole('region', { name: 'Artifact' });
    await artifacts.getByRole('button', { name: 'Mở' }).first().click();
    await expect(artifacts.locator('.artifact-content')).not.toBeEmpty();

    // Bằng chứng cho từng criterion.
    const evidence = page.getByRole('region', { name: 'Bằng chứng từng tiêu chí' });
    await expect(evidence.locator('.criterion-met')).toHaveCount(2);
    await expect(evidence).toContainText('Nêu đủ yêu cầu chức năng');
    await expect(evidence).toContainText('Nêu các rủi ro chính');

    // Phê duyệt cần lý do (FR-019).
    await decide(page, 'Phê duyệt', null);
    await expect(page.getByRole('alert')).toContainText('Hãy nhập lý do trước khi quyết định');
    await decide(page, 'Phê duyệt', 'Đạt yêu cầu');
    await waitForStatus(page, 'Hoàn thành');

    // Chuỗi truy vết SC-014 và lịch sử quyết định có người, lý do.
    const reviews = page.getByRole('region', { name: 'Lịch sử review và quyết định' });
    await expect(reviews).toContainText('ai_review');
    await expect(reviews).toContainText('human_approval');
    await expect(reviews).toContainText('Đạt yêu cầu');
    await expect(page.getByRole('region', { name: 'Chuỗi truy vết' })).toContainText('Review');

    // Người giao nhận thông báo hoàn thành.
    await page.getByRole('button', { name: /Mở hộp thông báo/ }).click();
    await expect(page.getByRole('region', { name: 'Thông báo' })).toContainText('Task hoàn thành');
  });

  test('Q5: rework tăng số vòng; lần thứ 3 bị chặn để người thật xử lý', async ({ page }) => {
    await setupCompany(page);
    await createTask(page, 'Rework đến giới hạn');

    for (let round = 1; round <= 3; round += 1) {
      await waitForStatus(page, 'Chờ Human Approval');
      await decide(page, 'Yêu cầu làm lại', `Bổ sung phần rủi ro lần ${round}`);
      if (round < 3) {
        await expect(page.locator('dl.profile')).toContainText(`Số vòng làm lại${round}`, SLOW);
      }
    }
    await waitForStatus(page, 'Bị chặn');
    await expect(page.locator('.banner-warn')).toContainText('giới hạn số vòng làm lại');
    const reviews = page.getByRole('region', { name: 'Lịch sử review và quyết định' });
    await expect(reviews).toContainText('Bổ sung phần rủi ro lần 3');
  });

  test('Q5: Reject → blocked; Resume chạy lại nhận lý do từ chối; Cancel từ chi tiết task', async ({
    page,
  }) => {
    page.on('dialog', (dialog) => void dialog.accept());
    await setupCompany(page);
    await createTask(page, 'Reject rồi resume');

    await waitForStatus(page, 'Chờ Human Approval');
    await decide(page, 'Từ chối', 'Sai hướng, hãy bổ sung phần rủi ro');
    await waitForStatus(page, 'Bị chặn');
    await expect(page.locator('.banner-warn')).toContainText('Human Manager đã từ chối');

    // Resume tạo run mới; kết quả mới mang lý do từ chối và chờ duyệt lại.
    await page.getByRole('button', { name: 'Tiếp tục' }).click();
    await waitForStatus(page, 'Chờ Human Approval');
    const artifacts = page.getByRole('region', { name: 'Artifact' });
    await artifacts.getByRole('button', { name: 'Mở' }).last().click();
    await expect(artifacts.locator('.artifact-content').last()).toContainText(
      'Sai hướng, hãy bổ sung phần rủi ro',
    );

    // Từ chối lần nữa rồi hủy task từ chi tiết.
    await decide(page, 'Từ chối', 'Vẫn chưa đạt');
    await waitForStatus(page, 'Bị chặn');
    await page.getByRole('button', { name: 'Hủy task' }).click();
    await waitForStatus(page, 'Đã hủy');
    await expect(page.getByRole('button', { name: 'Tiếp tục' })).toHaveCount(0);
  });
});
