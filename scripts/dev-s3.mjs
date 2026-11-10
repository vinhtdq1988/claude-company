// S3 giả tối giản cho chạy local khi không có MinIO (dự án MinIO mã nguồn mở đã ngừng phân phối bản cài).
//
// Chỉ hỗ trợ đúng các lệnh mà `StorageService` dùng: HeadBucket, CreateBucket, PutObject, GetObject (kiểu path-style).
// Đối tượng lưu thành file dưới thư mục dữ liệu. KHÔNG kiểm tra chữ ký hay quyền truy cập: chỉ dùng cho dev, bind
// 127.0.0.1. Chạy riêng: node scripts/dev-s3.mjs <thư-mục-dữ-liệu> [cổng]
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

/** Giải mã thân `aws-chunked` (SDK dùng khi gửi kèm checksum trailer): `<hex>[;ext]\r\n<data>\r\n ... 0\r\n`. */
export function decodeAwsChunked(buffer) {
  const parts = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd < 0) break;
    const size = Number.parseInt(
      buffer.subarray(offset, lineEnd).toString('latin1').split(';')[0],
      16,
    );
    if (!Number.isFinite(size) || size === 0) break;
    parts.push(buffer.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

const xmlError = (code, message) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;

export function startS3Mock({ dir, port, host = '127.0.0.1' }) {
  const root = resolve(dir);

  const send = (res, status, body = '', headers = {}) => {
    res.writeHead(status, { 'Content-Length': Buffer.byteLength(body), ...headers });
    res.end(body);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const [bucket, ...rest] = decodeURIComponent(url.pathname).replace(/^\/+/, '').split('/');
      const key = rest.join('/');
      if (!bucket) return send(res, 400, xmlError('InvalidRequest', 'Thiếu bucket'));
      const bucketDir = join(root, bucket);
      if (!resolve(bucketDir).startsWith(root + sep))
        return send(res, 400, xmlError('InvalidBucketName', bucket));

      if (!key) {
        if (req.method === 'PUT') {
          await mkdir(bucketDir, { recursive: true });
          return send(res, 200, '', { Location: `/${bucket}` });
        }
        if (req.method === 'HEAD') {
          const exists = await stat(bucketDir).then(
            () => true,
            () => false,
          );
          return send(res, exists ? 200 : 404);
        }
        return send(res, 501, xmlError('NotImplemented', 'Chỉ hỗ trợ HeadBucket và CreateBucket'));
      }

      const file = resolve(bucketDir, key);
      if (!file.startsWith(resolve(bucketDir) + sep))
        return send(res, 400, xmlError('InvalidArgument', 'Khóa không hợp lệ'));

      if (req.method === 'PUT') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = Buffer.concat(chunks);
        const streaming = String(req.headers['x-amz-content-sha256'] ?? '').startsWith(
          'STREAMING-',
        );
        if (streaming || String(req.headers['content-encoding'] ?? '').includes('aws-chunked')) {
          body = decodeAwsChunked(body);
        }
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, body);
        await writeFile(
          `${file}.meta.json`,
          JSON.stringify({
            contentType: req.headers['content-type'] ?? 'application/octet-stream',
          }),
        );
        return send(res, 200, '', { ETag: '"mock"' });
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        let data;
        try {
          data = await readFile(file);
        } catch {
          return send(
            res,
            404,
            req.method === 'HEAD' ? '' : xmlError('NoSuchKey', 'Không có đối tượng'),
          );
        }
        const meta = await readFile(`${file}.meta.json`, 'utf8').then(JSON.parse, () => ({}));
        res.writeHead(200, {
          'Content-Type': meta.contentType ?? 'application/octet-stream',
          'Content-Length': data.length,
          ETag: '"mock"',
        });
        return res.end(req.method === 'HEAD' ? undefined : data);
      }
      return send(res, 501, xmlError('NotImplemented', `${req.method} chưa hỗ trợ`));
    } catch (error) {
      return send(res, 500, xmlError('InternalError', String(error)));
    }
  });

  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => done(server));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write('Dùng: node scripts/dev-s3.mjs <thư-mục-dữ-liệu> [cổng]\n');
    process.exit(1);
  }
  const port = Number(process.argv[3] ?? 59000);
  await startS3Mock({ dir, port });
  process.stdout.write(
    `S3 giả đang chạy tại http://127.0.0.1:${port} (dữ liệu: ${resolve(dir)})\n`,
  );
}
