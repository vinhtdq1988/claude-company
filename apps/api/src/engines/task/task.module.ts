import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { TASK_ENGINE } from '../../platform/engine-tokens';
import { EnvelopeMapperRegistry } from '../../platform/events/envelope-mapper';
import { DecompositionService } from './decomposition.service';
import { mapTaskEvent } from './task-envelope';
import { TaskNotifications } from './task-notifications';
import { TaskTransitions } from './task-transitions';
import { TaskController } from './task.controller';
import { TaskRepository } from './task.repository';
import { TaskService } from './task.service';

/**
 * Binding thật của TaskEngine (thay stub rỗng của nền tảng). Employee/Organization Engine vẫn gọi qua
 * token `TASK_ENGINE`; TaskService lấy chúng muộn bằng ModuleRef nên không có vòng phụ thuộc.
 */
@Global()
@Module({
  controllers: [TaskController],
  providers: [
    TaskRepository,
    TaskTransitions,
    DecompositionService,
    TaskService,
    TaskNotifications,
    { provide: TASK_ENGINE, useExisting: TaskService },
  ],
  exports: [TASK_ENGINE, TaskService, TaskRepository],
})
export class TaskModule implements OnModuleInit {
  constructor(private readonly mappers: EnvelopeMapperRegistry) {}

  onModuleInit(): void {
    this.mappers.register('task.', mapTaskEvent);
  }
}
