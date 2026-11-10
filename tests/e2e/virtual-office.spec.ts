import { expect, test, type Page } from '@playwright/test';

/**
 * Kịch bản Q8 (Virtual Office realtime) và phần "nhân viên Waiting Approval trên Virtual Office" của Q6 trong
 * quickstart.md (US5, SC-005, SC-007), với `MODEL_PROVIDER=fake`. Cần stack đang chạy (api, worker, Redis, MinIO) và dữ
 * liệu seed; địa chỉ web đặt qua `E2E_BASE_URL`. Canvas PixiJS không đọc được bằng DOM nên trạng thái được kiểm chứng
 * qua danh sách nhân viên (cùng store, cùng nguồn sự kiện) và nhãn "Trạng thái có thể đã cũ".
 */

const PASSWORD = 'mat-khau-manh-123';
const SLOW = { timeout: 90_000 };
const REALTIME = { timeout: 3_000 }; // SC-005: trạng thái đổi trong ≤ 3 giây

const hireForm = (page: Page) => page.getByRole('form', { name: 'Tuyển AI Employee' });
const row = (page: Page, name: string) =>
  page.getByTestId('office-roster').locator('li', { hasText: name });

async function setupCompany(page: Page): Promise<string> {
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
  const companyId = /\/c\/([^/]+)\//.exec(page.url())![1]!;

  await hire(page, 'AI Manager', 'Quản lý Dev', 'Development', ceo, false);
  await hire(page, 'AI Business Analyst', 'BA Một', 'BA', 'Quản lý Dev', true);
  return companyId;
}

async function hire(
  page: Page,
  template: string,
  name: string,
  unit: string,
  manager: string,
  withEmail: boolean,
) {
  await page.getByRole('link', { name: 'AI Employee' }).click();
  await page.getByRole('button', { name: 'Tuyển AI Employee' }).click();
  const form = hireForm(page);
  await form.getByLabel('Mẫu vai trò').selectOption({ label: template });
  await form.getByLabel('Tên', { exact: true }).fill(name);
  await form.getByLabel('Department', { exact: true }).selectOption({ label: unit });
  await form.getByLabel('Manager trực tiếp').selectOption({ label: manager });
  if (withEmail) await form.getByRole('checkbox', { name: /email\.send/ }).check();
  await form.getByRole('button', { name: 'Tuyển dụng' }).click();
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
}

/** Tuyển thêm nhân viên qua API (cùng phiên) để có đủ 10 AI Employee cho SC-007. */
async function hireMoreViaApi(page: Page, companyId: string, total: number) {
  const me = await (await page.request.get('/api/v1/auth/me')).json();
  const csrf = me.csrfToken as string;
  const memberId = me.memberships[0].memberId as string;
  const chart = await (await page.request.get(`/api/v1/companies/${companyId}/org-chart`)).json();
  const flatten = (
    nodes: Array<{ id: string; name: string; children: unknown[] }>,
  ): Array<{ id: string; name: string }> =>
    nodes.flatMap((n) => [n, ...flatten(n.children as never)]);
  const home = flatten(chart.roots).find((n) => n.name === 'Development')!.id;
  const existing = await (
    await page.request.get(`/api/v1/companies/${companyId}/employees`)
  ).json();
  for (let i = existing.length; i < total; i += 1) {
    const res = await page.request.post(`/api/v1/companies/${companyId}/employees`, {
      headers: { 'X-CSRF-Token': csrf },
      data: {
        name: `Nhân viên ${i}`,
        avatarKey: 'developer',
        position: 'AI Developer',
        homeOrgUnitId: home,
        kind: 'employee',
        roleTemplateKey: null,
        personality: 'cẩn thận',
        skills: [],
        seniority: 'middle',
        modelId: existing[0].modelId,
        runtimeKind: 'claude_agent_sdk',
        systemPrompt: 'Bạn là AI Developer.',
        toolGrants: ['workspace.read', 'artifact.publish'],
        workspaceId: null,
        manager: { kind: 'human', id: memberId },
        maxConcurrentTasks: 2,
      },
    });
    expect(res.status()).toBe(201);
  }
}

async function createEmailTask(page: Page, title: string) {
  await page.getByRole('link', { name: 'Task Center' }).click();
  await page.getByRole('button', { name: 'Tạo task' }).click();
  const form = page.getByRole('form', { name: 'Tạo task' });
  await form.getByLabel('Tiêu đề', { exact: true }).fill(title);
  await form
    .getByLabel('Mục tiêu', { exact: true })
    .fill('Viết báo cáo tóm tắt rồi gửi email tóm tắt cho khách hàng');
  await form
    .getByLabel('Người nhận', { exact: true })
    .selectOption({ label: 'BA Một · AI Business Analyst' });
  await form.getByLabel('Hạn chót', { exact: true }).fill('2027-12-31T09:00');
  await form.getByLabel('Mức ưu tiên', { exact: true }).selectOption({ label: 'Cao' });
  await form.getByLabel('Acceptance criteria (mỗi dòng một tiêu chí)').fill('Có báo cáo tóm tắt');
  await form.getByLabel('Kết quả mong đợi', { exact: true }).fill('Báo cáo tóm tắt');
  await form.getByRole('button', { name: 'Tạo và giao ngay' }).click();
  await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible();
}

test.describe('Q8: Virtual Office realtime (US5)', () => {
  test('Q8 + phần Q6: trạng thái đổi trong ≤ 3 giây, mất mạng thì báo cũ rồi tự đồng bộ, Profile < 1 giây', async ({
    page,
    context,
  }) => {
    const companyId = await setupCompany(page);
    await hireMoreViaApi(page, companyId, 10);

    // Mở office ở tab riêng.
    const office = await context.newPage();
    await office.goto(`/c/${companyId}/office`);
    await expect(office.getByRole('heading', { name: 'Virtual Office', level: 1 })).toBeVisible();
    await expect(office.getByTestId('office-roster').locator('li')).toHaveCount(10);
    await expect(row(office, 'BA Một')).toHaveAttribute('data-state', 'idle');
    await expect(office.getByTestId('office-stale')).toHaveCount(0);

    // Giao task có chỉ thị gửi email: nhân viên chuyển trạng thái đúng lúc có sự kiện thật.
    await createEmailTask(page, 'Báo cáo và gửi email');
    await expect(row(office, 'BA Một')).not.toHaveAttribute('data-state', 'idle', SLOW);

    // Phần Q6: yêu cầu phê duyệt xuất hiện → nhân viên Waiting Approval trên office trong ≤ 3 giây.
    await page.getByRole('link', { name: 'Human Approval' }).click();
    await expect(page.locator('article.approval').first()).toBeVisible(SLOW);
    await expect(row(office, 'BA Một')).toHaveAttribute('data-state', 'waiting_approval', REALTIME);
    await expect(row(office, 'BA Một').getByTestId('roster-state')).toHaveText('Waiting Approval');

    // Mất mạng 10 giây: hiện nhãn "đã cũ"; có mạng lại thì tự đồng bộ.
    await context.setOffline(true);
    await expect(office.getByTestId('office-stale')).toBeVisible({ timeout: 15_000 });
    await office.waitForTimeout(10_000);
    await context.setOffline(false);
    await expect(office.getByTestId('office-stale')).toHaveCount(0, SLOW);
    await expect(row(office, 'BA Một')).toHaveAttribute('data-state', 'waiting_approval');

    // Quyết định phê duyệt trong lúc office mở: trạng thái rời Waiting Approval.
    const card = page.locator('article.approval').first();
    await card.locator('form.decision').getByLabel('Lý do của bạn').fill('Nội dung ổn');
    await card
      .locator('form.decision')
      .getByRole('button', { name: 'Duyệt và cho thực thi' })
      .click();
    await expect(row(office, 'BA Một')).not.toHaveAttribute('data-state', 'waiting_approval', {
      timeout: 15_000,
    });

    // Mở Employee Profile < 1 giây với 10 nhân viên, đủ mục FR-038.
    const started = Date.now();
    await row(office, 'BA Một').getByRole('button').click();
    const panel = office.getByRole('complementary', { name: 'Employee Profile' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Trao đổi gần đây' })).toBeVisible();
    expect(Date.now() - started).toBeLessThan(1_000);
    for (const heading of ['Kết quả mới nhất', 'Lịch sử review', 'Chi phí AI', 'Vướng mắc']) {
      await expect(panel.getByRole('heading', { name: heading })).toBeVisible();
    }
    await expect(panel.getByText('Task hiện tại')).toBeVisible();
    await expect(panel.getByText('Tool đang dùng')).toBeVisible();
    await expect(panel.getByText('Tháng này')).toBeVisible();
    await expect(panel.getByText('Tổng cộng')).toBeVisible();
  });
});
