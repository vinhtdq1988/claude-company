import type { ErrorBody, ErrorCode } from '@claude-company/contracts';

const BASE = '/api/v1';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Lỗi nghiệp vụ từ API, giữ nguyên `code` để giao diện ánh xạ sang thông điệp tiếng Việt. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK_ERROR',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type RequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
};

export interface ApiClientOptions {
  fetchFn?: typeof fetch;
  baseUrl?: string;
}

/**
 * Client REST: gửi cookie phiên (`credentials: include`), gắn `X-CSRF-Token` cho request ghi,
 * và chuyển lỗi `{ error: { code, message, details } }` thành `ApiError`.
 */
export class ApiClient {
  private csrfToken: string | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: ApiClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? ((...args) => fetch(...args));
    this.baseUrl = options.baseUrl ?? BASE;
  }

  /** Gọi sau khi đăng nhập/đăng ký/`/auth/me` để lưu token cho các request ghi. */
  setCsrfToken(token: string | null): void {
    this.csrfToken = token;
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (WRITE_METHODS.has(method) && this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;

    let response: Response;
    try {
      response = await this.fetchFn(this.buildUrl(path, options.query), {
        method,
        headers,
        credentials: 'include',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError(0, 'NETWORK_ERROR', 'Không kết nối được máy chủ');
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    const data: unknown = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const err = (data as Partial<ErrorBody> | undefined)?.error;
      throw new ApiError(
        response.status,
        err?.code ?? (response.status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL'),
        err?.message ?? response.statusText,
        err?.details ?? {},
      );
    }
    return data as T;
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, options);
  }
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body ?? {}, options);
  }
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', path, body ?? {}, options);
  }
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, body ?? {}, options);
  }
  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, undefined, options);
  }
}

/** Instance dùng chung cho toàn ứng dụng. */
export const api = new ApiClient();
