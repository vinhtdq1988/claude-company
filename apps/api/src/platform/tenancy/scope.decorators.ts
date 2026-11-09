import { SetMetadata } from '@nestjs/common';
import type { AppPermission, ScopeRef } from '@claude-company/contracts';
import type { Request } from 'express';

export const REQUIRE_SCOPE = 'cc:requireScope';
export const MEMBER_SCOPE = 'cc:memberScope';

export type RequireScopeMeta = {
  permission: AppPermission;
  /** Xác định đối tượng cần kiểm tra phạm vi từ request; mặc định là toàn công ty. */
  target?: (req: Request) => ScopeRef;
};

/**
 * Route cần quyền `permission` trên một đối tượng. Không có `target` nghĩa là cấp công ty:
 * quyền `*.read` mở cho mọi thành viên (dữ liệu trả về được lọc theo phạm vi), quyền khác chỉ CEO.
 * Đặt ở platform để mọi engine dùng được mà không import nội bộ của engine permission.
 */
export const RequireScope = (
  permission: AppPermission,
  target?: (req: Request) => ScopeRef,
): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_SCOPE, { permission, target } satisfies RequireScopeMeta);

/** Route chỉ cần là thành viên của công ty (ví dụ notification của chính mình). */
export const MemberScope = (): MethodDecorator & ClassDecorator => SetMetadata(MEMBER_SCOPE, true);
