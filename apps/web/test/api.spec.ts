import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from '../src/lib/api';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function setup(response: Response | Error) {
  const fetchFn = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response.clone(); // mỗi lần gọi cần một Response chưa đọc
  });
  return {
    fetchFn,
    client: new ApiClient({ fetchFn: fetchFn as unknown as typeof fetch, baseUrl: '/api/v1' }),
  };
}

const lastInit = (
  fetchFn: ReturnType<typeof vi.fn>,
): RequestInit & { headers: Record<string, string> } =>
  (fetchFn.mock.calls.at(-1) as unknown[])[1] as RequestInit & { headers: Record<string, string> };

describe('ApiClient', () => {
  it('gửi cookie phiên (credentials: include) và ghép query', async () => {
    const { client, fetchFn } = setup(json(200, { ok: true }));
    await client.get('/companies', { query: { limit: 10, cursor: undefined } });
    expect((fetchFn.mock.calls[0] as unknown[])[0]).toBe('/api/v1/companies?limit=10');
    expect(lastInit(fetchFn).credentials).toBe('include');
  });

  it('gắn X-CSRF-Token cho request ghi nhưng không cho request đọc', async () => {
    const { client, fetchFn } = setup(json(200, {}));
    client.setCsrfToken('tok-123');
    await client.post('/x', { a: 1 });
    expect(lastInit(fetchFn).headers['X-CSRF-Token']).toBe('tok-123');
    for (const method of ['put', 'patch', 'delete'] as const) {
      await client[method]('/x');
      expect(lastInit(fetchFn).headers['X-CSRF-Token'], method).toBe('tok-123');
    }
    await client.get('/x');
    expect(lastInit(fetchFn).headers['X-CSRF-Token']).toBeUndefined();
  });

  it('xóa token thì không gửi header', async () => {
    const { client, fetchFn } = setup(json(200, {}));
    client.setCsrfToken('tok');
    client.setCsrfToken(null);
    await client.post('/x');
    expect(lastInit(fetchFn).headers['X-CSRF-Token']).toBeUndefined();
  });

  it('ánh xạ lỗi nghiệp vụ sang ApiError giữ nguyên code và details', async () => {
    const { client } = setup(
      json(409, {
        error: {
          code: 'ORG_UNIT_NOT_EMPTY',
          message: 'còn nhân viên',
          details: { employees: ['e1'] },
        },
      }),
    );
    const error = await client.delete('/org-units/1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'ORG_UNIT_NOT_EMPTY',
      details: { employees: ['e1'] },
    });
  });

  it('401 không có thân lỗi → UNAUTHENTICATED; 5xx không có thân → INTERNAL', async () => {
    const e401 = await setup(new Response('', { status: 401 }))
      .client.get('/me')
      .catch((e: unknown) => e);
    expect(e401).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    const e500 = await setup(new Response('', { status: 500 }))
      .client.get('/x')
      .catch((e: unknown) => e);
    expect(e500).toMatchObject({ status: 500, code: 'INTERNAL' });
  });

  it('204 trả undefined; lỗi mạng thành NETWORK_ERROR', async () => {
    expect(
      await setup(new Response(null, { status: 204 })).client.post('/auth/logout'),
    ).toBeUndefined();
    const error = await setup(new TypeError('fetch failed'))
      .client.get('/x')
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });
});
