import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { ORCHESTRATION_ENGINE } from '../../platform/engine-tokens';
import { EnvelopeMapperRegistry } from '../../platform/events/envelope-mapper';
import { OrchestrationRepository } from './orchestration.repository';
import { OrchestrationService } from './orchestration.service';
import { ParentTaskService } from './parent-task.service';
import { ReviewFlowService } from './review-flow.service';
import { TaskScheduler } from './scheduler.service';
import { TaskFlowListener } from './task-flow.listener';

/**
 * Binding thật của OrchestrationEngine. `TaskFlowListener` nhận `domain_event` từ EventBus ở cả api và worker
 * (relay chạy ở process nào thắng khóa company thì process đó phát), nên module này được nạp ở cả hai.
 */
@Global()
@Module({
  providers: [
    OrchestrationRepository,
    ReviewFlowService,
    TaskScheduler,
    ParentTaskService,
    OrchestrationService,
    TaskFlowListener,
    { provide: ORCHESTRATION_ENGINE, useExisting: OrchestrationService },
  ],
  exports: [ORCHESTRATION_ENGINE, OrchestrationService],
})
export class OrchestrationModule implements OnModuleInit {
  constructor(private readonly mappers: EnvelopeMapperRegistry) {}

  /** Chỉ `run.step_appended` và `usage.updated` ra kênh công ty (theo nhân viên); các sự kiện run khác chỉ giữ `seq`. */
  onModuleInit(): void {
    this.mappers.register('run.step_appended', (event) => {
      const p = event.payload as {
        runId: string;
        taskId: string;
        employeeId: string;
        seq: number;
        kind: string;
      };
      return [
        {
          room: 'company',
          type: 'run.step_appended',
          payload: {
            runId: p.runId,
            taskId: p.taskId,
            employeeId: p.employeeId,
            seq: p.seq,
            kind: p.kind,
          },
          visibility: { kind: 'employee', employeeId: p.employeeId },
        },
      ];
    });
    this.mappers.register('usage.updated', (event) => {
      const p = event.payload as {
        employeeId: string;
        taskId: string;
        tokensDelta: number;
        costDelta: number;
      };
      return [
        {
          room: 'company',
          type: 'usage.updated',
          payload: {
            employeeId: p.employeeId,
            taskId: p.taskId,
            tokensDelta: p.tokensDelta,
            costDelta: p.costDelta,
          },
          visibility: { kind: 'employee', employeeId: p.employeeId },
        },
      ];
    });
  }
}
