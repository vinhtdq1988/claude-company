import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'cc:isPublic';

/** Route không cần session và CSRF (chỉ `/auth/register`, `/auth/login`). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
