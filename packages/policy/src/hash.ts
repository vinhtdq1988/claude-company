import { createHash } from 'node:crypto';

/** JSON ổn định (khóa sắp xếp) để cùng một nội dung luôn cho cùng một hash. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Hash của payload hành động: dùng chung cho `approval_request.payload_hash` và bước kiểm tra trước khi thực thi. */
export const payloadHashOf = (payload: unknown): string => sha256(stableStringify(payload));
