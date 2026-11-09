import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { AppConfig } from '../config/config';
import { CONFIG } from '../config/infra.providers';

export type StoredObject = { key: string; checksumSha256: string; sizeBytes: number };

/** Lưu trữ tương thích S3 (MinIO khi chạy local) cho artifact và file đầu ra. */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.bucket = config.S3_BUCKET;
    this.client = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  /**
   * Ghi đối tượng và trả `checksum_sha256`, `size_bytes` (tính trên nội dung đã ghi).
   * Khóa mặc định `<companyId>/<uuid>` để object luôn nằm dưới tiền tố của công ty.
   */
  async put(input: {
    companyId: string;
    body: Buffer | Uint8Array | string;
    contentType?: string;
    key?: string;
  }): Promise<StoredObject> {
    const body =
      typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : Buffer.from(input.body);
    const key = input.key ?? `${input.companyId}/${randomUUID()}`;
    if (!key.startsWith(`${input.companyId}/`))
      throw new Error('Khóa object phải nằm dưới tiền tố của công ty');
    const checksumSha256 = createHash('sha256').update(body).digest('hex');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: input.contentType ?? 'application/octet-stream',
        ContentLength: body.length,
      }),
    );
    return { key, checksumSha256, sizeBytes: body.length };
  }

  async getStream(key: string): Promise<Readable> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!out.Body) throw new Error(`Không đọc được object ${key}`);
    return out.Body as Readable;
  }

  async getBuffer(key: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.getStream(key))
      chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  }
}
