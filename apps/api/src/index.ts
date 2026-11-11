// Điểm xuất của @claude-company/api: worker dùng lại module engine + platform qua file này.
// Các module engine được export dần theo từng user story.
export { AppModule } from './app.module';
export { PlatformModule } from './platform/platform.module';
export { PermissionModule } from './engines/permission/permission.module';
export { EmployeeModule } from './engines/employee/employee.module';
export { OrganizationModule } from './engines/organization/organization.module';
export { TaskModule } from './engines/task/task.module';
export { CommunicationModule } from './engines/communication/communication.module';
export { MemoryModule } from './engines/memory/memory.module';
export { OrchestrationModule } from './engines/orchestration/orchestration.module';
export { OfficeSimulationModule } from './engines/office-simulation/office-simulation.module';
export { GamificationModule } from './engines/gamification/gamification.module';
export * from './platform/engine-tokens';
export { CONFIG, DATABASE, REDIS } from './platform/config/infra.providers';
export { loadConfig, type AppConfig } from './platform/config/config';
export { EventPublisher } from './platform/events/event-publisher';
export { EventBus } from './platform/events/event-bus';
export { EnvelopeMapperRegistry } from './platform/events/envelope-mapper';
export { StorageService } from './platform/storage/storage.service';
export {
  QueueService,
  QUEUE_NAME,
  TaskLock,
  JOB_NAMES,
  type JobName,
  type JobPayload,
} from './platform/queue/queues';
export { inTenant } from './platform/tenancy/tenant-store';
export * from './platform/usage-budget/cost';
export type { DashboardReader } from './platform/usage-budget/dashboard.service';
