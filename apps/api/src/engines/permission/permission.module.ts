import { Global, Module } from '@nestjs/common';
import { PERMISSION_ENGINE } from '../../platform/engine-tokens';
import { PermissionService } from './permission.service';
import { ScopeGuard } from './scope.guard';

@Global()
@Module({
  providers: [
    PermissionService,
    ScopeGuard,
    { provide: PERMISSION_ENGINE, useExisting: PermissionService },
  ],
  exports: [PERMISSION_ENGINE, ScopeGuard],
})
export class PermissionModule {}
