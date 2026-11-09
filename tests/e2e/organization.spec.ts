import { expect, test, type Page } from '@playwright/test';

/**
 * Kịch bản Q1 (quickstart.md): đăng ký → tạo công ty từ template "Công ty phần mềm" → đổi tên QA →
 * thêm Team "Mobile" dưới Development → mở sơ đồ tổ chức. Cần stack đang chạy (`pnpm dev` hoặc Docker Compose)
 * và cơ cấu mẫu đã seed (`pnpm db:seed`); địa chỉ web đặt qua `E2E_BASE_URL`.
 */

const PASSWORD = 'mat-khau-manh-123';

const unitItem = (page: Page, name: string) =>
  page.locator('.org-item', { has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) });

test.describe('Q1: dựng công ty và cơ cấu tổ chức (US1)', () => {
  test('tạo công ty từ template, đổi tên phòng ban, thêm Team và xem sơ đồ', async ({ page }) => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const displayName = `CEO ${suffix}`;

    // Đăng ký: user mới chưa có công ty nên được đưa tới màn hình tạo công ty.
    await page.goto('/register');
    await page.getByLabel('Tên hiển thị').fill(displayName);
    await page.getByLabel('Email').fill(`ceo-${suffix}@example.com`);
    await page.getByLabel('Mật khẩu').fill(PASSWORD);
    await page.getByRole('button', { name: 'Tạo tài khoản' }).click();
    await expect(page).toHaveURL(/\/onboarding$/);

    // AS1: chọn cơ cấu mẫu → ba phòng ban Development, BA, QA.
    await page.getByLabel('Tên công ty').fill(`Công ty ${suffix}`);
    await expect(page.getByLabel('Công ty phần mềm')).toBeChecked();
    await page.getByRole('button', { name: 'Tạo công ty' }).click();
    await expect(page).toHaveURL(/\/c\/[^/]+\/org$/);

    const chart = page.getByLabel('Sơ đồ tổ chức').first();
    for (const name of ['Development', 'BA', 'QA']) {
      await expect(unitItem(page, name)).toBeVisible();
    }
    await expect(chart.locator('.org-item')).toHaveCount(3);

    // AS2: đổi tên QA thành Quality.
    await unitItem(page, 'QA').click();
    const panel = page.locator('.editor-panel');
    await panel.getByLabel('Tên').fill('Quality');
    await panel.getByRole('button', { name: 'Đổi tên' }).click();
    await expect(unitItem(page, 'Quality')).toBeVisible();
    await expect(unitItem(page, 'QA')).toHaveCount(0);

    // AS2: thêm Team Mobile vào Development.
    const addTeam = page.getByRole('form', { name: 'Thêm Team' });
    await addTeam.getByLabel('Department').selectOption({ label: 'Development' });
    await addTeam.getByLabel('Tên').fill('Mobile');
    await addTeam.getByRole('button', { name: 'Thêm' }).click();
    await expect(page.locator('.org-team', { hasText: 'Mobile' })).toBeVisible();

    // AS3: CEO gán chính mình làm manager của Development, sơ đồ hiển thị người quản lý.
    await unitItem(page, 'Development').click();
    await page.locator('.editor-panel').getByLabel('Gán manager').selectOption({
      label: displayName,
    });
    await expect(unitItem(page, 'Development')).toContainText(`Manager: ${displayName}`);

    // Tải lại trang: cấu trúc và manager vẫn đúng (dữ liệu nằm ở server, không chỉ ở client).
    await page.reload();
    await expect(unitItem(page, 'Quality')).toBeVisible();
    await expect(unitItem(page, 'Development')).toContainText(`Manager: ${displayName}`);
    await expect(page.locator('.org-team', { hasText: 'Mobile' })).toBeVisible();
  });

  test('AS4: xóa phòng ban còn đơn vị con bị chặn và nêu rõ cần xử lý gì', async ({ page }) => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    await page.goto('/register');
    await page.getByLabel('Tên hiển thị').fill(`CEO ${suffix}`);
    await page.getByLabel('Email').fill(`ceo-${suffix}@example.com`);
    await page.getByLabel('Mật khẩu').fill(PASSWORD);
    await page.getByRole('button', { name: 'Tạo tài khoản' }).click();

    // Tự thiết kế: bắt đầu từ trống.
    await page.getByLabel('Tên công ty').fill(`Công ty ${suffix}`);
    await page.getByLabel('Tự thiết kế (bắt đầu từ trống)').check();
    await page.getByRole('button', { name: 'Tạo công ty' }).click();
    await expect(page).toHaveURL(/\/c\/[^/]+\/org$/);
    await expect(page.getByText('Công ty chưa có đơn vị nào')).toBeVisible();

    const addUnit = page.getByRole('form', { name: 'Thêm đơn vị' });
    await addUnit.getByLabel('Loại đơn vị').selectOption('division');
    await addUnit.getByLabel('Tên').fill('Engineering');
    await addUnit.getByRole('button', { name: 'Thêm' }).click();
    await expect(unitItem(page, 'Engineering')).toBeVisible();

    await addUnit.getByLabel('Loại đơn vị').selectOption('department');
    await addUnit.getByLabel('Thuộc').selectOption({ label: 'Engineering' });
    await addUnit.getByLabel('Tên').fill('Backend');
    await addUnit.getByRole('button', { name: 'Thêm' }).click();
    await expect(unitItem(page, 'Backend')).toBeVisible();

    page.once('dialog', (dialog) => void dialog.accept());
    await unitItem(page, 'Engineering').click();
    await page.getByRole('button', { name: 'Xóa (lưu trữ)' }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Cần xử lý trước khi xóa');
    await expect(alert).toContainText('Đơn vị con: Backend');
    await expect(unitItem(page, 'Engineering')).toBeVisible();
  });
});
