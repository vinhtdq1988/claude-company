/** Che secret trước khi ghi `run_step.payload` / log: key API, token, mật khẩu, khóa riêng, credential trong URL. */
const MASK = '[REDACTED]';

const SECRET_KEY = /(secret|token|passw(or)?d|api[-_]?key|authorization|credential|private[-_]?key)/i;

const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK],
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, MASK],
  [/\bsk-[A-Za-z0-9]{20,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${MASK}@`],
  [
    /\b((?:[A-Z_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD)[A-Z_]*)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/g,
    `$1${MASK}`,
  ],
];

export function redactString(text: string): string {
  return PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

/** Sao chép sâu giá trị JSON đã che secret. Chuỗi bị che theo mẫu; thuộc tính tên nhạy cảm bị che toàn bộ. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 12) return MASK as unknown as T;
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) && v !== null && v !== undefined ? MASK : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
