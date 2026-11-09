import { Global, Module } from '@nestjs/common';
import { MEMORY_ENGINE } from '../../platform/engine-tokens';
import { MemoryService } from './memory.service';

@Global()
@Module({
  providers: [MemoryService, { provide: MEMORY_ENGINE, useExisting: MemoryService }],
  exports: [MEMORY_ENGINE, MemoryService],
})
export class MemoryModule {}
