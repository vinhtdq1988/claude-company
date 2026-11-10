// egress-proxy: lối ra internet duy nhất của worker (R4). Chỉ cho phép đường hầm HTTPS (CONNECT) tới các host
// trong allowlist (mặc định chỉ host API model) trên cổng 443; mọi thứ khác bị từ chối 403.
import { createServer } from 'node:http';
import { connect } from 'node:net';

/** Danh sách host dạng `a.com,b.com`; so khớp chính xác, không khớp hậu tố để không thể lách bằng `a.com.evil.io`. */
export function parseAllowlist(value) {
  return new Set(
    String(value ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Tách `host:port` của yêu cầu CONNECT; trả `null` nếu sai dạng. */
export function parseTarget(authority) {
  const match = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(String(authority ?? ''));
  if (!match) return null;
  return { host: match[1].toLowerCase(), port: Number(match[2]) };
}

export function isAllowed(target, allowlist, allowedPorts = [443]) {
  return target !== null && allowlist.has(target.host) && allowedPorts.includes(target.port);
}

export function createEgressProxy({
  allowlist,
  allowedPorts = [443],
  log = () => {},
  dial = connect,
}) {
  const server = createServer((request, response) => {
    // Yêu cầu HTTP thường (không phải CONNECT) không được hỗ trợ: tránh trở thành proxy mở.
    log({ event: 'denied', method: request.method, reason: 'plain_http' });
    response.writeHead(403, { 'content-type': 'text/plain' });
    response.end('egress-proxy: chỉ cho phép CONNECT tới host trong allowlist\n');
  });

  server.on('connect', (request, clientSocket, head) => {
    const target = parseTarget(request.url);
    if (!isAllowed(target, allowlist, allowedPorts)) {
      log({ event: 'denied', method: 'CONNECT', target: request.url });
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = dial(target.port, target.host, () => {
      log({ event: 'allowed', target: request.url });
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on('error', (error) => {
      log({ event: 'upstream_error', target: request.url, message: error.message });
      if (!clientSocket.destroyed)
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      close();
    });
    clientSocket.on('error', close);
    clientSocket.on('close', close);
  });
  return server;
}

if (process.argv[1]?.endsWith('proxy.mjs')) {
  const allowlist = parseAllowlist(process.env.EGRESS_ALLOWLIST ?? 'api.anthropic.com');
  if (allowlist.size === 0) throw new Error('EGRESS_ALLOWLIST không được rỗng');
  const server = createEgressProxy({
    allowlist,
    log: (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry })),
  });
  server.listen(Number(process.env.PORT ?? 3128), '0.0.0.0');
  console.log(JSON.stringify({ event: 'listening', allowlist: [...allowlist] }));
}
