import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Kịch bản Q2 (quickstart.md): tạo AI Manager, AI Developer, AI BA, AI QA và một nhân viên tùy chỉnh,
 * gán vào Team "Mobile", thử lưu khi không chọn manager. Cần stack đang chạy (`pnpm dev` hoặc Docker Compose)
 * và dữ liệu seed (`pnpm db:seed`: cơ cấu mẫu, mẫu vai trò, bảng giá model); địa chỉ web đặt qua `E2E_BASE_URL`.
 */

const PASSWORD = 'mat-khau-manh-123';

const unitItem = (page: Page, name: string) =>
  page.locator('.org-item', { has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) });

const hireForm = (page: Page): Locator => page.getByRole('form', { name: 'Tuyển AI Employee' });

async function openEmployees(page: Page) {
  await page.getByRole('link', { name: 'AI Employee' }).click();
  await expect(page.getByRole('heading', { name: 'AI Employee', level: 2 })).toBeVisible();
}

async function openHireForm(page: Page) {
  await page.getByRole('button', { name: 'Tuyển AI Employee' }).click();
  await expect(hireForm(page)).toBeVisible();
}

type Hire = { template: string; name: string; unit: string; manager?: string };

/** Điền biểu mẫu từ mẫu vai trò; không bấm lưu để test tự quyết định. */
async function fillHireForm(page: Page, { template, name, unit, manager }: Hire) {
  const form = hireForm(page);
  await form.getByLabel('Mẫu vai trò').selectOption({ label: template });
  await form.getByLabel('Tên', { exact: true }).fill(name);
  await form.getByLabel('Department', { exact: true }).selectOption({ label: unit });
  if (manager) await form.getByLabel('Manager trực tiếp').selectOption({ label: manager });
}

async function hire(page: Page, spec: Hire) {
  await openEmployees(page);
  await openHireForm(page);
  await fillHireForm(page, spec);
  await hireForm(page).getByRole('button', { name: 'Tuyển dụng' }).click();
  await expect(page.getByRole('heading', { name: spec.name, level: 2 })).toBeVisible();
}

test.describe('Q2: tuyển AI Employee (US2)', () => {
  test('tạo nhân viên từ mẫu và tùy chỉnh, gán vào Team, bắt buộc manager', async ({ page }) => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const ceo = `CEO ${suffix}`;

    // Dựng công ty từ cơ cấu mẫu và thêm Team Mobile dưới Development (tiền đề của Q2).
    await page.goto('/register');
    await page.getByLabel('Tên hiển thị').fill(ceo);
    await page.getByLabel('Email').fill(`ceo-${suffix}@example.com`);
    await page.getByLabel('Mật khẩu').fill(PASSWORD);
    await page.getByRole('button', { name: 'Tạo tài khoản' }).click();
    await page.getByLabel('Tên công ty').fill(`Công ty ${suffix}`);
    await page.getByRole('button', { name: 'Tạo công ty' }).click();
    await expect(page).toHaveURL(/\/c\/[^/]+\/org$/);

    const addTeam = page.getByRole('form', { name: 'Thêm Team' });
    await addTeam.getByLabel('Department').selectOption({ label: 'Development' });
    await addTeam.getByLabel('Tên').fill('Mobile');
    await addTeam.getByRole('button', { name: 'Thêm' }).click();
    await expect(page.locator('.org-team', { hasText: 'Mobile' })).toBeVisible();

    // US2-AS2: lưu khi không chọn manager bị chặn, không tạo nhân viên.
    await openEmployees(page);
    await openHireForm(page);
    await fillHireForm(page, {
      template: 'AI Developer',
      name: 'Dev thiếu manager',
      unit: 'Development',
    });
    await hireForm(page).getByRole('button', { name: 'Tuyển dụng' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Mỗi AI Employee phải có một manager trực tiếp',
    );
    await hireForm(page).getByRole('button', { name: 'Hủy' }).click();
    await expect(page.getByText('Chưa có AI Employee nào')).toBeVisible();

    // US2-AS1: mẫu điền sẵn; AI Manager trước để các nhân viên khác trỏ vào được.
    await openHireForm(page);
    await fillHireForm(page, {
      template: 'AI Manager',
      name: 'Quản lý Dev',
      unit: 'Development',
      manager: ceo,
    });
    // Mẫu AI Manager khóa runtime ở Messages API.
    await expect(hireForm(page).getByLabel('Runtime')).toBeDisabled();
    await hireForm(page).getByRole('button', { name: 'Tuyển dụng' }).click();
    await expect(page.getByRole('heading', { name: 'Quản lý Dev', level: 2 })).toBeVisible();

    await hire(page, {
      template: 'AI Developer',
      name: 'Dev Một',
      unit: 'Development',
      manager: 'Quản lý Dev',
    });
    await hire(page, { template: 'AI Business Analyst', name: 'BA Một', unit: 'BA', manager: ceo });
    await hire(page, { template: 'AI QA Engineer', name: 'QA Một', unit: 'QA', manager: ceo });

    // Nhân viên tùy chỉnh, không theo mẫu.
    await openEmployees(page);
    await openHireForm(page);
    const form = hireForm(page);
    await form.getByLabel('Mẫu vai trò').selectOption({ label: 'Tùy chỉnh (không theo mẫu)' });
    await form.getByLabel('Tên', { exact: true }).fill('Chuyên gia dữ liệu');
    await form.getByLabel('Chức danh').fill('Data Analyst');
    await form.getByLabel('Department', { exact: true }).selectOption({ label: 'BA' });
    await form.getByLabel('Chỉ dẫn vai trò (system prompt)').fill('Bạn phân tích dữ liệu.');
    await form.getByLabel('Manager trực tiếp').selectOption({ label: ceo });
    await form.getByRole('button', { name: 'Tuyển dụng' }).click();
    await expect(page.getByRole('heading', { name: 'Chuyên gia dữ liệu', level: 2 })).toBeVisible();

    // Hồ sơ hiển thị đủ thuộc tính FR-009 và manager trực tiếp.
    await openEmployees(page);
    await page.getByRole('button', { name: 'Dev Một' }).click();
    const profile = page.locator('dl.profile');
    await expect(profile).toContainText('AI Developer');
    await expect(profile).toContainText('Claude Agent SDK');
    await expect(profile).toContainText('Quản lý Dev');
    await expect(profile).toContainText('workspace.shell');

    // Danh sách có đủ năm nhân viên và lọc theo Department hoạt động.
    await page.getByRole('button', { name: '← Danh sách AI Employee' }).click();
    await expect(page.locator('.data-table tbody tr')).toHaveCount(5);
    await page.getByLabel('Department', { exact: true }).selectOption({ label: 'BA' });
    await expect(page.locator('.data-table tbody tr')).toHaveCount(2);
    await page.getByLabel('Department', { exact: true }).selectOption({ label: 'Tất cả' });

    // FR-007: gán AI Manager, AI Developer và AI QA vào Team Mobile.
    await page.getByRole('link', { name: 'Sơ đồ tổ chức' }).click();
    await page.locator('.org-team', { hasText: 'Mobile' }).click();
    const members = page.getByRole('form', { name: 'Thành viên của Team' });
    for (const name of ['Quản lý Dev', 'Dev Một', 'QA Một']) {
      await members.getByLabel(name, { exact: true }).check();
    }
    await members.getByRole('button', { name: 'Lưu thành viên' }).click();
    await expect(members.getByText('Đã lưu thành viên.')).toBeVisible();
    await expect(page.locator('.org-team', { hasText: 'Mobile' })).toContainText('3 nhân viên');

    // Mở lại hồ sơ: hiển thị Team đã gán; tải lại trang dữ liệu vẫn còn.
    await page.reload();
    await expect(page.locator('.org-team', { hasText: 'Mobile' })).toContainText('3 nhân viên');
    await openEmployees(page);
    await page.getByRole('button', { name: 'Dev Một' }).click();
    await expect(page.locator('dl.profile')).toContainText('Mobile');
  });

  test('AS4: lưu trữ nhân viên và đổi model chỉ ảnh hưởng một người', async ({ page }) => {
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

    await hire(page, {
      template: 'AI Developer',
      name: 'Dev A',
      unit: 'Development',
      manager: ceo,
    });
    await hire(page, {
      template: 'AI Developer',
      name: 'Dev B',
      unit: 'Development',
      manager: ceo,
    });

    // Đổi model của Dev B sang model khác trong danh mục.
    await page.getByRole('button', { name: 'Chỉnh sửa' }).click();
    const edit = page.getByRole('form', { name: 'Chỉnh sửa hồ sơ' });
    await edit.getByLabel('Model').selectOption('claude-sonnet-5-5');
    await edit.getByRole('button', { name: 'Lưu thay đổi' }).click();
    await expect(page.locator('dl.profile')).toContainText('claude-sonnet-5-5');

    await page.getByRole('button', { name: '← Danh sách AI Employee' }).click();
    await page.getByRole('button', { name: 'Dev A' }).click();
    await expect(page.locator('dl.profile')).toContainText('claude-opus-5-5');
    await expect(page.locator('dl.profile')).not.toContainText('claude-sonnet-5-5');

    // Lưu trữ Dev A (chưa có task): biến mất khỏi danh sách.
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Lưu trữ' }).click();
    await expect(page.locator('.data-table tbody tr')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Dev A' })).toHaveCount(0);
  });
});
