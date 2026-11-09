import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { createAdapter } from '@socket.io/redis-adapter';
import {
  subscribeRequestSchema,
  type DomainEvent,
  type EmployeeEngine,
  type ManagedScope,
  type OrganizationEngine,
  type RealtimeEnvelope,
  type RequestContext,
  type SubscribeResult,
} from '@claude-company/contracts';
import { withTenant } from '@claude-company/db';
import { domainEvent } from '@claude-company/db/schema/events';
import { asc, eq, gt, and, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { Server, type Namespace, type Socket } from 'socket.io';
import { parseCookies, SESSION_COOKIE } from '../auth/cookies';
import { SessionService } from '../auth/session.service';
import type { AppConfig } from '../config/config';
import { CONFIG, REDIS } from '../config/infra.providers';
import { EMPLOYEE_ENGINE, ORGANIZATION_ENGINE } from '../engine-tokens';
import { EnvelopeMapperRegistry, type EnvelopeSpec } from '../events/envelope-mapper';
import { toDomainEvent } from '../events/event-publisher';
import { DOMAIN_EVENT_CHANNEL } from '../events/outbox-relay';
import { runWithTenantTx } from '../tenancy/tenant-store';
import { canView, changesScope } from './visibility';

/** Số event tối đa phát lại khi client kết nối lại; vượt quá thì yêu cầu tải lại snapshot. */
export const REPLAY_LIMIT = 1000;

type SocketData = {
  userId: string;
  companyId?: string;
  memberId?: string;
  scope?: ManagedScope;
  /** Event có seq <= floor đã được phát (qua replay) nên bỏ qua khi nhận từ kênh live. */
  floor: number;
  /** Hàng đợi tuần tự theo socket: replay và live không chen nhau. */
  chain: Promise<void>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEvents = Record<string, (...args: any[]) => void>;
type RealtimeSocket = Socket<AnyEvents, AnyEvents, AnyEvents, SocketData>;

const companyRoom = (id: string) => `company:${id}`;
const userRoom = (id: string) => `user:${id}`;

/**
 * Socket.IO namespace `/realtime` (contracts/realtime-events.md): xác thực cookie khi handshake,
 * `subscribe { companyId, sinceSeq }`, phát lại sự kiện còn lưu hoặc trả `resync_required`.
 * Mỗi instance nhận domain_event từ Redis pub/sub và tự lọc, phát cho socket cục bộ của mình.
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeGateway.name);
  private io: Server | undefined;
  private nsp: Namespace | undefined;
  private subscriber: Redis | undefined;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionService,
    private readonly mappers: EnvelopeMapperRegistry,
    @Inject(EMPLOYEE_ENGINE) private readonly employees: Pick<EmployeeEngine, 'findMemberships'>,
    @Inject(ORGANIZATION_ENGINE)
    private readonly organization: Pick<OrganizationEngine, 'resolveManagedScope'>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const httpServer = this.adapterHost.httpAdapter.getHttpServer();
    const io = new Server(httpServer, {
      cors: { origin: this.config.WEB_ORIGIN, credentials: true },
    });
    io.adapter(createAdapter(this.redis.duplicate(), this.redis.duplicate()));
    const nsp = io.of('/realtime');
    nsp.use((socket, next) => void this.authenticate(socket as RealtimeSocket, next));
    nsp.on('connection', (socket) => this.onConnection(socket as RealtimeSocket));
    this.io = io;
    this.nsp = nsp;

    this.subscriber = this.redis.duplicate();
    await this.subscriber.subscribe(DOMAIN_EVENT_CHANNEL);
    this.subscriber.on('message', (_channel, message) => {
      try {
        this.onDomainEvent(JSON.parse(message) as DomainEvent);
      } catch (error) {
        this.logger.error(
          'Domain event không hợp lệ',
          error instanceof Error ? error : String(error),
        );
      }
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.subscriber?.disconnect();
    await this.io?.close();
  }

  /** Handshake: cookie phiên không hợp lệ thì ngắt kết nối. */
  private async authenticate(socket: RealtimeSocket, next: (err?: Error) => void): Promise<void> {
    try {
      const sid = parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE];
      const session = sid ? await this.sessions.get(sid) : null;
      if (!session) return next(new Error('unauthorized'));
      socket.data = { userId: session.userId, floor: 0, chain: Promise.resolve() };
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  }

  private onConnection(socket: RealtimeSocket): void {
    socket.on('subscribe', (raw: unknown, ack?: (r: unknown) => void) => {
      const reply = typeof ack === 'function' ? ack : () => undefined;
      this.enqueue(socket, async () => reply(await this.subscribe(socket, raw)));
    });
  }

  private enqueue(socket: RealtimeSocket, task: () => Promise<void>): void {
    socket.data.chain = socket.data.chain
      .then(task)
      .catch((error: unknown) =>
        this.logger.error('Realtime lỗi', error instanceof Error ? error : String(error)),
      );
  }

  private requestContext(companyId: string, memberId: string): RequestContext {
    return { companyId, actor: { kind: 'human', memberId }, traceId: 'realtime' };
  }

  private async subscribe(
    socket: RealtimeSocket,
    raw: unknown,
  ): Promise<SubscribeResult | { status: 'forbidden' }> {
    const parsed = subscribeRequestSchema.safeParse(raw);
    if (!parsed.success) return { status: 'forbidden' };
    const { companyId, sinceSeq } = parsed.data;

    const memberships = await this.employees.findMemberships(socket.data.userId);
    const membership = memberships.find((m) => m.companyId === companyId);
    if (!membership) return { status: 'forbidden' };

    // Rời company cũ nếu client đổi company trên cùng socket.
    if (socket.data.companyId && socket.data.companyId !== companyId) {
      await socket.leave(companyRoom(socket.data.companyId));
      if (socket.data.memberId) await socket.leave(userRoom(socket.data.memberId));
    }
    const ctx = this.requestContext(companyId, membership.memberId);
    const scope = await withTenant(
      companyId,
      (tx) =>
        runWithTenantTx(companyId, tx, () =>
          this.organization.resolveManagedScope(ctx, membership.memberId),
        ),
      {
        userId: socket.data.userId,
      },
    );

    socket.data.companyId = companyId;
    socket.data.memberId = membership.memberId;
    socket.data.scope = scope;
    await socket.join([companyRoom(companyId), userRoom(membership.memberId)]);

    const current = await this.maxSeq(companyId);
    if (sinceSeq === undefined) {
      socket.data.floor = current;
      return { status: 'ok', seq: current };
    }
    if (sinceSeq > current) return { status: 'resync_required' };

    const missed = await this.loadEventsAfter(companyId, sinceSeq);
    const first = missed[0];
    if (missed.length > REPLAY_LIMIT || (first && first.seq !== sinceSeq + 1)) {
      socket.data.floor = current;
      return { status: 'resync_required' };
    }
    socket.data.floor = sinceSeq;
    for (const event of missed) await this.deliver(socket, event);
    return { status: 'ok', seq: socket.data.floor };
  }

  private async maxSeq(companyId: string): Promise<number> {
    return withTenant(companyId, async (tx) => {
      const r = await tx.execute<{ max: string | null }>(
        sql`select max(seq) as max from domain_event where company_id = ${companyId}`,
      );
      return Number(r.rows[0]?.max ?? 0);
    });
  }

  private async loadEventsAfter(companyId: string, sinceSeq: number): Promise<DomainEvent[]> {
    const rows = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(domainEvent)
        .where(and(eq(domainEvent.companyId, companyId), gt(domainEvent.seq, sinceSeq)))
        .orderBy(asc(domainEvent.seq))
        .limit(REPLAY_LIMIT + 1),
    );
    return rows.map(toDomainEvent);
  }

  /** Nhận domain_event từ Redis: phát cho socket cục bộ thuộc company đó, theo thứ tự. */
  private onDomainEvent(event: DomainEvent): void {
    if (!this.nsp) return;
    for (const socket of this.nsp.sockets.values() as Iterable<RealtimeSocket>) {
      if (socket.data.companyId !== event.companyId) continue;
      this.enqueue(socket, async () => {
        if (event.seq <= socket.data.floor) return;
        await this.deliver(socket, event);
      });
    }
  }

  private async deliver(socket: RealtimeSocket, event: DomainEvent): Promise<void> {
    const { companyId, memberId } = socket.data;
    if (!companyId || !memberId) return;
    if (changesScope(event.type)) {
      const ctx = this.requestContext(companyId, memberId);
      socket.data.scope = await withTenant(
        companyId,
        (tx) =>
          runWithTenantTx(companyId, tx, () =>
            this.organization.resolveManagedScope(ctx, memberId),
          ),
        { userId: socket.data.userId },
      );
    }
    const scope = socket.data.scope;
    if (!scope) return;
    const viewer = { memberId, scope };

    const specs: EnvelopeSpec[] = this.mappers.map(event);
    let emittedCompany = false;
    for (const spec of specs) {
      if (spec.room === 'company') {
        if (!canView(viewer, spec.visibility)) continue;
        emittedCompany = true;
      } else if (spec.memberId !== memberId) {
        continue;
      }
      socket.emit(spec.type, this.envelope(event, spec.type, spec.payload));
    }
    // Phát thay thế để seq không có khoảng trống khi mọi envelope công ty bị lọc (D2).
    if (!emittedCompany) {
      socket.emit('sync.seq_advanced', this.envelope(event, 'sync.seq_advanced', {}));
    }
    socket.data.floor = Math.max(socket.data.floor, event.seq);
  }

  private envelope(event: DomainEvent, type: string, payload: unknown): RealtimeEnvelope<unknown> {
    return {
      seq: event.seq,
      companyId: event.companyId,
      type,
      occurredAt: event.occurredAt,
      payload,
    };
  }
}
