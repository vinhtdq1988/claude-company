export const SESSION_COOKIE = 'cc_sid';

/** Tách header Cookie thành map; bỏ qua giá trị sai định dạng. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    if (!key || key in out) continue;
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      /* bỏ qua cookie hỏng */
    }
  }
  return out;
}
