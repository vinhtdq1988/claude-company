const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential|csrf/i;
const SENSITIVE_VALUE = [
  /sk-ant-[\w-]{8,}/g, // khóa Anthropic
  /(?<=:\/\/[^:/\s]+:)[^@\s]+(?=@)/g, // mật khẩu trong URL kết nối
  /\bBearer\s+[\w.~+/=-]{8,}/gi,
];

export const REDACTED = '[REDACTED]';

function redactString(value: string): string {
  return SENSITIVE_VALUE.reduce((acc, re) => acc.replace(re, REDACTED), value);
}

/** Che secret trong dữ liệu log: theo tên khóa nhạy cảm và theo mẫu giá trị. Không sửa đối tượng gốc. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[Truncated]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack && redactString(value.stack),
    };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}
