import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { COMMUNICATION_ENGINE } from '../../platform/engine-tokens';
import { EnvelopeMapperRegistry } from '../../platform/events/envelope-mapper';
import { CommunicationService } from './communication.service';
import { NotificationController } from './notification.controller';
import { NotificationRouter } from './notification-routing';

@Global()
@Module({
  controllers: [NotificationController],
  providers: [
    NotificationRouter,
    CommunicationService,
    { provide: COMMUNICATION_ENGINE, useExisting: CommunicationService },
  ],
  exports: [COMMUNICATION_ENGINE, CommunicationService],
})
export class CommunicationModule implements OnModuleInit {
  constructor(private readonly mappers: EnvelopeMapperRegistry) {}

  /** `notification.created` chỉ đi tới room `user:{memberId}` của người nhận (không qua kênh công ty). */
  onModuleInit(): void {
    this.mappers.register('notification.created', (event) => {
      const p = event.payload as {
        notificationId: string;
        memberId: string;
        type: string;
        title: string;
        taskId?: string;
        approvalRequestId?: string;
      };
      return [
        {
          room: 'user',
          memberId: p.memberId,
          type: 'notification.created',
          payload: {
            notificationId: p.notificationId,
            type: p.type,
            title: p.title,
            taskId: p.taskId,
            approvalRequestId: p.approvalRequestId,
          },
        },
      ];
    });
  }
}
