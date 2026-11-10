import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { NotificationController } from '../../src/engines/communication/notification.controller';
import { EmployeeController } from '../../src/engines/employee/employee.controller';
import { HumanMemberController } from '../../src/engines/employee/human-member.controller';
import { WorkspaceController } from '../../src/engines/employee/workspace.controller';
import { GamificationController } from '../../src/engines/gamification/gamification.controller';
import { OfficeController } from '../../src/engines/office-simulation/office.controller';
import { RunController } from '../../src/engines/orchestration/run.controller';
import { OrganizationController } from '../../src/engines/organization/organization.controller';
import { ApprovalController } from '../../src/engines/permission/approval.controller';
import { TaskController } from '../../src/engines/task/task.controller';
import { AuthController } from '../../src/platform/auth/auth.controller';
import {
  ROUTES,
  buildOpenApiDocument,
  registerOpenApi,
  renderDocsHtml,
  type RouteDoc,
} from '../../src/platform/http/openapi';
import { BudgetController } from '../../src/platform/usage-budget/budget.controller';
import { DashboardController } from '../../src/platform/usage-budget/dashboard.controller';

const CONTROLLERS = [
  AuthController,
  OrganizationController,
  EmployeeController,
  HumanMemberController,
  WorkspaceController,
  TaskController,
  ApprovalController,
  RunController,
  BudgetController,
  DashboardController,
  OfficeController,
  NotificationController,
  GamificationController,
];

const METHOD_NAMES: Partial<Record<number, RouteDoc['method']>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

const join = (...parts: string[]) =>
  `/${parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')}`.replace(/:(\w+)/g, '{$1}');

/** Route thật của controller, đọc từ metadata decorator của NestJS (không cần dựng app). */
function actualRoutes(): string[] {
  const routes: string[] = [];
  for (const controller of CONTROLLERS) {
    const base = String(Reflect.getMetadata('path', controller) ?? '');
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = (controller.prototype as unknown as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata('method', handler) as number | undefined;
      if (method === undefined) continue;
      const verb = METHOD_NAMES[method];
      if (!verb) throw new Error(`Phương thức HTTP chưa được hỗ trợ ở ${controller.name}.${name}`);
      routes.push(`${verb} ${join(base, String(Reflect.getMetadata('path', handler) ?? ''))}`);
    }
  }
  return routes.sort();
}

describe('OpenAPI (T192)', () => {
  it('bảng route khớp đúng với route thật của các controller (thêm/xóa route phải cập nhật tài liệu)', () => {
    const documented = ROUTES.map((r) => `${r.method} ${r.path}`).sort();
    expect(documented).toEqual(actualRoutes());
  });

  it('không có route nào bị khai báo trùng', () => {
    const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe('tài liệu sinh ra', () => {
    type Parameter = { name: string; in: string; required: boolean };
    type Operation = {
      operationId: string;
      security?: unknown[];
      parameters: Parameter[];
      requestBody: {
        content: Record<string, { schema: { type: string; required: string[] } }>;
      };
    };
    const doc = buildOpenApiDocument() as {
      openapi: string;
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, Operation>>;
      components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
    };
    const operation = (path: string, method: string): Operation => {
      const found = doc.paths[path]?.[method];
      if (!found) throw new Error(`Không có ${method} ${path} trong tài liệu`);
      return found;
    };

    it('là OpenAPI 3.1 với server /api/v1', () => {
      expect(doc.openapi).toBe('3.1.0');
      expect(doc.servers).toEqual([{ url: '/api/v1' }]);
    });

    it('mọi route có mặt, tham số đường dẫn được khai báo từ chính đường dẫn', () => {
      expect(Object.keys(doc.paths)).toContain('/companies/{companyId}/tasks/{id}');
      const op = operation('/companies/{companyId}/tasks/{id}', 'get');
      expect(op.parameters.map((p) => p.name)).toEqual(['companyId', 'id']);
      expect(op.parameters.every((p) => p.in === 'path' && p.required)).toBe(true);
    });

    it('thân request lấy từ schema Zod của contracts: trường bắt buộc và kiểu khớp validation thật', () => {
      const create = operation('/companies/{companyId}/tasks', 'post');
      const schema = create.requestBody.content['application/json']!.schema;
      expect(schema.type).toBe('object');
      expect(schema.required).toEqual(
        expect.arrayContaining(['title', 'objective', 'assignee', 'deadline']),
      );
      expect(schema).not.toHaveProperty('$schema');
    });

    it('query được khai báo thành tham số, có phân biệt bắt buộc', () => {
      const list = operation('/companies/{companyId}/runs', 'get');
      const names = list.parameters.map((p) => p.name);
      expect(names).toEqual(expect.arrayContaining(['companyId', 'taskId', 'employeeId', 'limit']));
      expect(list.parameters.find((p) => p.name === 'taskId')?.required).toBe(false);
    });

    it('chỉ đăng ký và đăng nhập là công khai; route còn lại dùng security mặc định (cookie + CSRF)', () => {
      const publicOps = Object.entries(doc.paths).flatMap(([path, ops]) =>
        Object.entries(ops)
          .filter(([, op]) => Array.isArray(op.security) && op.security.length === 0)
          .map(([method]) => `${method} ${path}`),
      );
      expect(publicOps.sort()).toEqual(['post /auth/login', 'post /auth/register']);
      expect(Object.keys(doc.components.securitySchemes).sort()).toEqual([
        'cookieAuth',
        'csrfHeader',
      ]);
    });

    it('mọi $ref đều trỏ tới schema có thật', () => {
      const refs = [
        ...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g),
      ].map((m) => m[1]);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(doc.components.schemas).toHaveProperty(ref as string);
    });

    it('ErrorBody liệt kê đủ mã lỗi, gồm RATE_LIMITED', () => {
      const errorBody = doc.components.schemas.ErrorBody as {
        properties: { error: { properties: { code: { enum: string[] } } } };
      };
      expect(errorBody.properties.error.properties.code.enum).toEqual(
        expect.arrayContaining(['FORBIDDEN', 'NOT_FOUND', 'RATE_LIMITED', 'VALIDATION_FAILED']),
      );
    });

    it('operationId duy nhất', () => {
      const ids = Object.values(doc.paths).flatMap((ops) =>
        Object.values(ops).map((op) => op.operationId as string),
      );
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('registerOpenApi', () => {
    const appWith = (get: ReturnType<typeof vi.fn>) =>
      ({ getHttpAdapter: () => ({ get }) }) as unknown as Parameters<typeof registerOpenApi>[0];

    it('production: không đăng ký route tài liệu nào', () => {
      const get = vi.fn();
      registerOpenApi(appWith(get), { NODE_ENV: 'production' });
      expect(get).not.toHaveBeenCalled();
    });

    it.each(['development', 'test'] as const)(
      '%s: phục vụ /api/v1/docs và openapi.json',
      (NODE_ENV) => {
        const get = vi.fn();
        registerOpenApi(appWith(get), { NODE_ENV });
        expect(get.mock.calls.map((c) => c[0])).toEqual([
          '/api/v1/docs',
          '/api/v1/docs/openapi.json',
        ]);
      },
    );
  });

  describe('trang tài liệu', () => {
    it('liệt kê route theo nhóm và không chứa script hay style (chạy được dưới CSP default-src none)', () => {
      const html = renderDocsHtml();
      expect(html).toContain('GET /api/v1/companies/{companyId}/runs');
      expect(html).toContain('openapi.json');
      expect(html).not.toMatch(/<script|<style|style=/i);
    });

    it('thoát ký tự HTML trong mô tả', () => {
      const html = renderDocsHtml([
        { method: 'get', path: '/x', tag: '<b>tag</b>', summary: '<img src=x onerror=alert(1)>' },
      ]);
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img');
      expect(html).toContain('&lt;b&gt;tag&lt;/b&gt;');
    });
  });
});
