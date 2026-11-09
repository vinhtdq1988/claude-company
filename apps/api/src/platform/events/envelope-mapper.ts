import { Injectable } from '@nestjs/common';
import type { DomainEvent, RealtimeEventType } from '@claude-company/contracts';

/** Ai được thấy envelope trên room công ty; gateway lọc theo ManagedScope của từng socket. */
export type Visibility =
  | { kind: 'all' }
  | { kind: 'employee'; employeeId: string }
  | { kind: 'assignee'; assigneeKind: 'ai' | 'human'; assigneeId: string };

export type EnvelopeSpec =
  | { room: 'company'; type: RealtimeEventType; payload: unknown; visibility: Visibility }
  | { room: 'user'; memberId: string; type: RealtimeEventType; payload: unknown };

export type EnvelopeMapper = (event: DomainEvent) => EnvelopeSpec[];

const SEQ_ADVANCED: EnvelopeSpec = {
  room: 'company',
  type: 'sync.seq_advanced',
  payload: {},
  visibility: { kind: 'all' },
};

/**
 * Ánh xạ domain_event → envelope realtime. Mỗi engine đăng ký mapper cho tiền tố loại sự kiện của mình.
 * D2: mỗi `domain_event.seq` phát ít nhất một envelope trên room công ty; event không có payload công khai
 * hoặc không đổi trạng thái phát `sync.seq_advanced {}`.
 */
@Injectable()
export class EnvelopeMapperRegistry {
  private readonly mappers: Array<{ prefix: string; mapper: EnvelopeMapper }> = [];

  register(prefix: string, mapper: EnvelopeMapper): void {
    this.mappers.push({ prefix, mapper });
  }

  map(event: DomainEvent): EnvelopeSpec[] {
    const specs = this.mappers
      .filter((m) => m.prefix === '*' || event.type.startsWith(m.prefix))
      .flatMap((m) => m.mapper(event));
    return specs.some((s) => s.room === 'company') ? specs : [...specs, SEQ_ADVANCED];
  }
}
