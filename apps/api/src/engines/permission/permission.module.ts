import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { PERMISSION_ENGINE } from '../../platform/engine-tokens';
import { EnvelopeMapperRegistry } from '../../platform/events/envelope-mapper';
import { ApprovalController } from './approval.controller';
import { ApprovalListener } from './approval.listener';
import { ApprovalRepository } from './approval.repository';
import { ApprovalService } from './approval.service';
import { PermissionService } from './permission.service';
import { ScopeGuard } from './scope.guard';

@Global()
@Module({
  controllers: [ApprovalController],
  providers: [
    ApprovalRepository,
    ApprovalService,
    ApprovalListener,
    PermissionService,
    ScopeGuard,
    { provide: PERMISSION_ENGINE, useExisting: PermissionService },
  ],
  exports: [PERMISSION_ENGINE, ScopeGuard],
})
export class PermissionModule implements OnModuleInit {
  constructor(private readonly mappers: EnvelopeMapperRegistry) {}

  /** `approval.requested`/`approval.decided` chỉ đi tới room `user:{memberId}` của người duyệt (realtime-events.md). */
  onModuleInit(): void {
    this.mappers.register('approval.requested', (event) => {
      const p = event.payload as {
        approvalRequestId: string;
        taskId: string;
        employeeId: string;
        actionType: string;
        approverMemberId?: string;
      };
      if (!p.approverMemberId) return [];
      return [
        {
          room: 'user',
          memberId: p.approverMemberId,
          type: 'approval.requested',
          payload: {
            approvalRequestId: p.approvalRequestId,
            taskId: p.taskId,
            employeeId: p.employeeId,
            actionType: p.actionType,
          },
        },
      ];
    });
    this.mappers.register('approval.decided', (event) => {
      const p = event.payload as {
        approvalRequestId: string;
        decision: 'approve' | 'reject';
        approverMemberId?: string;
      };
      if (!p.approverMemberId) return [];
      return [
        {
          room: 'user',
          memberId: p.approverMemberId,
          type: 'approval.decided',
          payload: { approvalRequestId: p.approvalRequestId, decision: p.decision },
        },
      ];
    });
  }
}
