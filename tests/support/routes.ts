import type { INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { MEMBER_SCOPE, REQUIRE_SCOPE } from '../../apps/api/src/platform/tenancy/scope.decorators';
import { API_PREFIX } from '../../apps/api/src/app.setup';

export interface RouteInfo {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'ALL' | 'OPTIONS' | 'HEAD';
  /** Đường dẫn đầy đủ gồm tiền tố, ví dụ `/api/v1/companies/:companyId/members`. */
  path: string;
  controller: string;
  handler: string;
  hasScopeMetadata: boolean;
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'] as const;

const asArray = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : [v ?? '']);
const join = (...parts: string[]) =>
  `/${parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')}`;

/** Liệt kê mọi route từ metadata controller của NestJS (nguồn sự thật cho test phủ xác thực). */
export function listRoutes(app: INestApplication): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const metatype = wrapper.metatype;
      if (!metatype) continue;
      const prototype = metatype.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[name];
        if (typeof handler !== 'function' || name === 'constructor') continue;
        const methodIndex = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (methodIndex === undefined) continue;
        const basePaths = asArray(
          Reflect.getMetadata(PATH_METADATA, metatype) as string | string[] | undefined,
        );
        const subPaths = asArray(
          Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined,
        );
        for (const base of basePaths) {
          for (const sub of subPaths) {
            routes.push({
              method: METHODS[methodIndex] ?? 'GET',
              path: join(API_PREFIX, base, sub),
              controller: metatype.name,
              handler: name,
              hasScopeMetadata:
                Reflect.getMetadata(REQUIRE_SCOPE, handler) !== undefined ||
                Reflect.getMetadata(MEMBER_SCOPE, handler) !== undefined ||
                Reflect.getMetadata(REQUIRE_SCOPE, metatype) !== undefined ||
                Reflect.getMetadata(MEMBER_SCOPE, metatype) !== undefined,
            });
          }
        }
      }
    }
  }
  return routes;
}

/** Thay `:param` bằng giá trị; param chưa cho dùng UUID tùy ý. */
export function fillPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(
    /:(\w+)/g,
    (_m, name: string) => params[name] ?? '0197a000-0000-7000-8000-0000000000ff',
  );
}
