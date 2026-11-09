import type { Membership, RequestContext } from '@claude-company/contracts';

export type SessionData = { userId: string; csrfToken: string; createdAt: number };

declare module 'express-serve-static-core' {
  interface Request {
    /** Do SessionGuard gắn sau khi xác thực cookie `cc_sid`. */
    session?: SessionData & { sid: string };
    /** Do TenantGuard gắn khi đường dẫn có `companyId`. */
    requestContext?: RequestContext;
    membership?: Membership;
  }
}
