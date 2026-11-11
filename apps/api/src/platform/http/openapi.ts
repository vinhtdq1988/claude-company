import type { INestApplication } from '@nestjs/common';
import {
  addMemberSchema,
  approvalDecisionSchema,
  approvalListQuerySchema,
  assignManagerSchema,
  createAssistantRequestSchema,
  createCompanySchema,
  createEmployeeSchema,
  createOrgUnitSchema,
  createTaskSchema,
  createTeamSchema,
  createWorkspaceSchema,
  updateWorkspaceSettingsSchema,
  dashboardQuerySchema,
  employeeFilterQuerySchema,
  ERROR_HTTP_STATUS,
  loginSchema,
  putBudgetPolicySchema,
  registerSchema,
  runListQuerySchema,
  setTeamMembersSchema,
  taskDecisionSchema,
  taskDraftPatchSchema,
  taskListQuerySchema,
  taskMessageBodySchema,
  taskTransitionSchema,
  updateEmployeeSchema,
  updateOrgUnitSchema,
  updateTeamSchema,
  usageQuerySchema,
} from '@claude-company/contracts';
import type { Request, Response } from 'express';
import { z, type ZodType } from 'zod';
import type { AppConfig } from '../config/config';
import { API_PREFIX } from './prefix';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export type RouteDoc = {
  method: Method;
  /** Dạng OpenAPI: `/companies/{companyId}/tasks/{id}`, không gồm tiền tố `/api/v1`. */
  path: string;
  tag: string;
  summary: string;
  query?: ZodType;
  body?: ZodType;
  /** Không cần session và CSRF (chỉ đăng ký và đăng nhập). */
  public?: boolean;
};

const notificationListQuery = z.object({
  unread: z.enum(['true', 'false']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const C = '/companies/{companyId}';

/**
 * Bảng route của API REST, nguồn duy nhất cho tài liệu OpenAPI. Schema request lấy thẳng từ `packages/contracts`
 * (cùng schema mà `ZodValidationPipe` dùng) nên tài liệu không thể lệch với validation. Test `openapi.spec.ts` đối
 * chiếu bảng này với route thật của các controller: thêm hoặc xóa route mà quên cập nhật bảng thì test fail.
 */
export const ROUTES: readonly RouteDoc[] = [
  // Auth
  {
    method: 'post',
    path: '/auth/register',
    tag: 'Auth',
    summary: 'Đăng ký tài khoản và mở phiên',
    body: registerSchema,
    public: true,
  },
  {
    method: 'post',
    path: '/auth/login',
    tag: 'Auth',
    summary: 'Đăng nhập (giới hạn tần suất)',
    body: loginSchema,
    public: true,
  },
  { method: 'post', path: '/auth/logout', tag: 'Auth', summary: 'Đăng xuất' },
  {
    method: 'get',
    path: '/auth/me',
    tag: 'Auth',
    summary: 'Phiên hiện tại, CSRF token và các công ty đang tham gia',
  },

  // Organization
  {
    method: 'post',
    path: '/companies',
    tag: 'Organization',
    summary: 'Tạo công ty (kèm cơ cấu mẫu tùy chọn)',
    body: createCompanySchema,
  },
  { method: 'get', path: '/org-templates', tag: 'Organization', summary: 'Danh sách cơ cấu mẫu' },
  { method: 'get', path: C, tag: 'Organization', summary: 'Thông tin công ty' },
  {
    method: 'get',
    path: `${C}/org-chart`,
    tag: 'Organization',
    summary: 'Sơ đồ tổ chức trong phạm vi người xem',
  },
  {
    method: 'post',
    path: `${C}/org-units`,
    tag: 'Organization',
    summary: 'Tạo Division hoặc Department',
    body: createOrgUnitSchema,
  },
  {
    method: 'patch',
    path: `${C}/org-units/{id}`,
    tag: 'Organization',
    summary: 'Sửa đơn vị',
    body: updateOrgUnitSchema,
  },
  {
    method: 'delete',
    path: `${C}/org-units/{id}`,
    tag: 'Organization',
    summary: 'Lưu trữ đơn vị (chặn nếu còn nhân viên hoặc task)',
  },
  {
    method: 'post',
    path: `${C}/teams`,
    tag: 'Organization',
    summary: 'Tạo team',
    body: createTeamSchema,
  },
  {
    method: 'patch',
    path: `${C}/teams/{id}`,
    tag: 'Organization',
    summary: 'Sửa team',
    body: updateTeamSchema,
  },
  { method: 'delete', path: `${C}/teams/{id}`, tag: 'Organization', summary: 'Lưu trữ team' },
  {
    method: 'put',
    path: `${C}/teams/{id}/members`,
    tag: 'Organization',
    summary: 'Đặt danh sách thành viên team',
    body: setTeamMembersSchema,
  },
  {
    method: 'put',
    path: `${C}/management-assignments`,
    tag: 'Organization',
    summary: 'Gán người quản lý cho đơn vị hoặc team',
    body: assignManagerSchema,
  },

  // Employees
  { method: 'get', path: '/role-templates', tag: 'Employees', summary: 'Danh sách role template' },
  { method: 'get', path: '/models', tag: 'Employees', summary: 'Danh sách model và đơn giá' },
  {
    method: 'get',
    path: `${C}/employees`,
    tag: 'Employees',
    summary: 'Danh sách AI Employee trong phạm vi',
    query: employeeFilterQuerySchema,
  },
  {
    method: 'post',
    path: `${C}/employees`,
    tag: 'Employees',
    summary: 'Tuyển AI Employee',
    body: createEmployeeSchema,
  },
  { method: 'get', path: `${C}/employees/{id}`, tag: 'Employees', summary: 'Employee Profile' },
  {
    method: 'patch',
    path: `${C}/employees/{id}`,
    tag: 'Employees',
    summary: 'Sửa AI Employee',
    body: updateEmployeeSchema,
  },
  {
    method: 'post',
    path: `${C}/employees/{id}/suspend`,
    tag: 'Employees',
    summary: 'Tạm ngưng AI Employee',
  },
  {
    method: 'post',
    path: `${C}/employees/{id}/resume`,
    tag: 'Employees',
    summary: 'Kích hoạt lại AI Employee',
  },
  {
    method: 'delete',
    path: `${C}/employees/{id}`,
    tag: 'Employees',
    summary: 'Lưu trữ AI Employee',
  },
  {
    method: 'get',
    path: `${C}/members`,
    tag: 'Employees',
    summary: 'Danh sách thành viên là người thật',
  },
  {
    method: 'post',
    path: `${C}/members`,
    tag: 'Employees',
    summary: 'Thêm Manager (chỉ CEO)',
    body: addMemberSchema,
  },
  {
    method: 'delete',
    path: `${C}/members/{id}`,
    tag: 'Employees',
    summary: 'Vô hiệu hóa thành viên',
  },
  { method: 'get', path: `${C}/workspaces`, tag: 'Employees', summary: 'Danh sách workspace' },
  {
    method: 'post',
    path: `${C}/workspaces`,
    tag: 'Employees',
    summary: 'Đăng ký workspace',
    body: createWorkspaceSchema,
  },
  {
    method: 'get',
    path: `${C}/workspaces/settings`,
    tag: 'Employees',
    summary: 'Thư mục gốc cho phép của workspace',
  },
  {
    method: 'put',
    path: `${C}/workspaces/settings`,
    tag: 'Employees',
    summary: 'Đặt thư mục gốc của workspace (chỉ CEO)',
    body: updateWorkspaceSettingsSchema,
  },

  // Tasks
  {
    method: 'get',
    path: `${C}/tasks`,
    tag: 'Tasks',
    summary: 'Task Board: danh sách task trong phạm vi',
    query: taskListQuerySchema,
  },
  { method: 'post', path: `${C}/tasks`, tag: 'Tasks', summary: 'Tạo task', body: createTaskSchema },
  {
    method: 'get',
    path: `${C}/tasks/{id}`,
    tag: 'Tasks',
    summary: 'Chi tiết task, artifact, bằng chứng, review',
  },
  {
    method: 'patch',
    path: `${C}/tasks/{id}`,
    tag: 'Tasks',
    summary: 'Sửa task nháp (chỉ draft; chờ đề xuất của CEO AI Assistant thì 409 PROPOSAL_PENDING)',
    body: taskDraftPatchSchema,
  },
  {
    method: 'post',
    path: `${C}/tasks/{id}/transitions`,
    tag: 'Tasks',
    summary: 'Chuyển trạng thái: assign, cancel, resume',
    body: taskTransitionSchema,
  },
  {
    method: 'post',
    path: `${C}/tasks/{id}/decisions`,
    tag: 'Tasks',
    summary: 'Human Manager duyệt, từ chối hoặc yêu cầu làm lại',
    body: taskDecisionSchema,
  },
  {
    method: 'get',
    path: `${C}/tasks/{id}/executed-actions`,
    tag: 'Tasks',
    summary: 'Hành động nhạy cảm đã thực thi (có nhãn dry-run)',
  },
  {
    method: 'get',
    path: `${C}/tasks/{id}/operations`,
    tag: 'Tasks',
    summary: 'Thao tác điều hành của CEO AI Assistant trên task (trạng thái từng thao tác)',
  },
  {
    method: 'get',
    path: `${C}/tasks/{id}/messages`,
    tag: 'Tasks',
    summary: 'Trao đổi gắn với task',
  },
  {
    method: 'post',
    path: `${C}/tasks/{id}/messages`,
    tag: 'Tasks',
    summary: 'Gửi trao đổi gắn với task',
    body: taskMessageBodySchema,
  },
  {
    method: 'get',
    path: `${C}/artifacts/{id}/content`,
    tag: 'Tasks',
    summary: 'Nội dung artifact',
  },

  // CEO AI Assistant (chỉ CEO)
  {
    method: 'get',
    path: `${C}/ceo-assistant`,
    tag: 'CEO AI Assistant',
    summary: 'Trợ lý hiện có và khả năng tạo mới',
  },
  {
    method: 'post',
    path: `${C}/ceo-assistant/requests`,
    tag: 'CEO AI Assistant',
    summary: 'Gửi yêu cầu điều hành bằng ngôn ngữ tự nhiên (tạo task nháp chờ đề xuất)',
    body: createAssistantRequestSchema,
  },

  // Approvals
  {
    method: 'get',
    path: `${C}/approvals`,
    tag: 'Approvals',
    summary: 'Hộp phê duyệt trong phạm vi',
    query: approvalListQuerySchema,
  },
  {
    method: 'get',
    path: `${C}/approvals/{id}`,
    tag: 'Approvals',
    summary: 'Chi tiết yêu cầu phê duyệt',
  },
  {
    method: 'post',
    path: `${C}/approvals/{id}/decision`,
    tag: 'Approvals',
    summary: 'Duyệt hoặc từ chối (bắt buộc lý do và payloadHash)',
    body: approvalDecisionSchema,
  },

  // Execution history
  {
    method: 'get',
    path: `${C}/runs`,
    tag: 'Runs',
    summary: 'Lịch sử thực thi trong phạm vi',
    query: runListQuerySchema,
  },
  {
    method: 'get',
    path: `${C}/runs/{id}`,
    tag: 'Runs',
    summary: 'Chi tiết run: bước, tool invocation, lỗi, usage',
  },

  // Budget & Dashboard
  {
    method: 'get',
    path: `${C}/budget-policies/{scopeKind}/{scopeId}`,
    tag: 'Budget',
    summary: 'Chính sách ngân sách của một phạm vi',
  },
  {
    method: 'put',
    path: `${C}/budget-policies/{scopeKind}/{scopeId}`,
    tag: 'Budget',
    summary: 'Đặt chính sách ngân sách',
    body: putBudgetPolicySchema,
  },
  {
    method: 'get',
    path: `${C}/usage`,
    tag: 'Budget',
    summary: 'Token và chi phí trong phạm vi',
    query: usageQuerySchema,
  },
  {
    method: 'get',
    path: `${C}/dashboard`,
    tag: 'Budget',
    summary: 'Company Dashboard',
    query: dashboardQuerySchema,
  },

  // Virtual Office, notifications, milestones
  {
    method: 'get',
    path: `${C}/office/snapshot`,
    tag: 'Office',
    summary: 'Snapshot Virtual Office trong phạm vi người xem',
  },
  {
    method: 'get',
    path: `${C}/employees/{id}/profile-view`,
    tag: 'Office',
    summary: 'Dữ liệu Employee Profile cho Virtual Office',
  },
  {
    method: 'get',
    path: `${C}/notifications`,
    tag: 'Notifications',
    summary: 'Thông báo của chính người xem',
    query: notificationListQuery,
  },
  {
    method: 'post',
    path: `${C}/notifications/read-all`,
    tag: 'Notifications',
    summary: 'Đánh dấu đã đọc tất cả',
  },
  {
    method: 'post',
    path: `${C}/notifications/{id}/read`,
    tag: 'Notifications',
    summary: 'Đánh dấu đã đọc một thông báo',
  },
  { method: 'get', path: `${C}/milestones`, tag: 'Notifications', summary: 'Achievement đã đạt' },
];

type JsonSchema = Record<string, unknown>;

function toJsonSchema(schema: ZodType): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
    io: 'input',
  }) as JsonSchema;
  return rest;
}

function pathParameters(path: string): Array<Record<string, unknown>> {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
    name: m[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
}

function queryParameters(schema: ZodType): Array<Record<string, unknown>> {
  const json = toJsonSchema(schema) as {
    properties?: Record<string, JsonSchema>;
    required?: string[];
  };
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([name, property]) => ({
    name,
    in: 'query',
    required: required.has(name),
    schema: property,
  }));
}

const ERROR_CODES = Object.keys(ERROR_HTTP_STATUS);

/** Tài liệu OpenAPI 3.1 của API. Thuần và tất định: cùng bảng route cho cùng kết quả. */
export function buildOpenApiDocument(
  routes: readonly RouteDoc[] = ROUTES,
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const parameters = [
      ...pathParameters(route.path),
      ...(route.query ? queryParameters(route.query) : []),
    ];
    const operation: Record<string, unknown> = {
      tags: [route.tag],
      summary: route.summary,
      operationId: `${route.method}${route.path.replace(/\{(\w+)\}/g, '_$1').replace(/[^\w]+/g, '_')}`,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: toJsonSchema(route.body) } },
            },
          }
        : {}),
      ...(route.public ? { security: [] } : {}),
      responses: {
        '2XX': { description: 'Thành công' },
        '4XX': {
          description:
            'Lỗi do yêu cầu: 401 chưa đăng nhập, 403 ngoài phạm vi hoặc CSRF, 404, 409, 422, 429',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } },
        },
      },
    };
    (paths[route.path] ??= {})[route.method] = operation;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Claude Company API',
      version: '1.0.0',
      description:
        'API REST của Claude Company v1.0 (MVP). Mọi route (trừ đăng ký và đăng nhập) cần cookie phiên; route ghi cần thêm header X-CSRF-Token. Phạm vi quản lý được cưỡng chế phía server: ngoài phạm vi trả 403, người ngoài công ty nhận 404. Tài liệu này chỉ có ở môi trường không phải production.',
    },
    servers: [{ url: `/${API_PREFIX}` }],
    security: [{ cookieAuth: [], csrfHeader: [] }],
    tags: [...new Set(routes.map((r) => r.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'cc_sid' },
        csrfHeader: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' },
      },
      schemas: {
        ErrorBody: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'details'],
              properties: {
                code: { type: 'string', enum: ERROR_CODES },
                message: { type: 'string' },
                details: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
      },
    },
  };
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/**
 * Trang tài liệu tự chứa (không script, không style, không tài nguyên ngoài) để chạy được dưới CSP `default-src 'none'`.
 * Liệt kê route theo nhóm; chi tiết schema ở `openapi.json`.
 */
export function renderDocsHtml(routes: readonly RouteDoc[] = ROUTES): string {
  const byTag = new Map<string, RouteDoc[]>();
  for (const route of routes) byTag.set(route.tag, [...(byTag.get(route.tag) ?? []), route]);
  const sections = [...byTag.entries()]
    .map(
      ([tag, items]) =>
        `<h2>${escapeHtml(tag)}</h2>\n<ul>\n${items
          .map(
            (r) =>
              `<li><code>${r.method.toUpperCase()} /${API_PREFIX}${escapeHtml(r.path)}</code> – ${escapeHtml(r.summary)}${r.public ? ' (công khai)' : ''}</li>`,
          )
          .join('\n')}\n</ul>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="vi">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Claude Company API</title></head>
<body>
<h1>Claude Company API v1.0</h1>
<p>Đặc tả OpenAPI 3.1: <a href="/${API_PREFIX}/docs/openapi.json">openapi.json</a>. Route ghi cần cookie phiên và header X-CSRF-Token.</p>
${sections}
</body>
</html>
`;
}

/** Phục vụ `/api/v1/docs` và `/api/v1/docs/openapi.json`; production không đăng ký route nào. */
export function registerOpenApi(app: INestApplication, config: Pick<AppConfig, 'NODE_ENV'>): void {
  if (config.NODE_ENV === 'production') return;
  const document = JSON.stringify(buildOpenApiDocument());
  const html = renderDocsHtml();
  const http = app.getHttpAdapter();
  http.get(`/${API_PREFIX}/docs`, (_req: Request, res: Response) => {
    res.type('html').send(html);
  });
  http.get(`/${API_PREFIX}/docs/openapi.json`, (_req: Request, res: Response) => {
    res.type('application/json').send(document);
  });
}
