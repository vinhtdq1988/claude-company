import { Global, Module } from '@nestjs/common';
import type { Page, TaskEngine } from '@claude-company/contracts';
import { TASK_ENGINE } from '../engine-tokens';

const emptyPage = <T>(): Page<T> => ({ items: [], nextCursor: null });

/**
 * Stub TaskEngine: trả rỗng/0 để Organization và Employee dùng được trước khi có Task Engine (US3).
 * Thay bằng binding thật ở T097.
 */
export const emptyTaskEngine: Pick<
  TaskEngine,
  'list' | 'getStats' | 'markOverdue' | 'listCompaniesWithOpenTasks'
> &
  Partial<TaskEngine> = {
  list: async () => emptyPage(),
  getStats: async () => ({ completedTasks: 0, onTimeRate: 0, reworkRate: 0, activeTasks: 0 }),
  markOverdue: async () => [],
  listCompaniesWithOpenTasks: async () => [],
};

/** Binding mặc định, mỗi stub được gỡ khỏi module này khi story tương ứng cung cấp binding thật. */
@Global()
@Module({
  providers: [{ provide: TASK_ENGINE, useValue: emptyTaskEngine }],
  exports: [TASK_ENGINE],
})
export class EmptyEnginesModule {}
