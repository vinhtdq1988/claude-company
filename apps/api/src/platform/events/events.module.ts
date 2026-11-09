import { Global, Module } from '@nestjs/common';
import { EnvelopeMapperRegistry } from './envelope-mapper';
import { EventBus } from './event-bus';
import { EventPublisher } from './event-publisher';
import { OutboxRelay } from './outbox-relay';

@Global()
@Module({
  providers: [EventPublisher, EventBus, EnvelopeMapperRegistry, OutboxRelay],
  exports: [EventPublisher, EventBus, EnvelopeMapperRegistry, OutboxRelay],
})
export class EventsModule {}
