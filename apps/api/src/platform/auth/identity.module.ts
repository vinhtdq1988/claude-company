import { Global, Module } from '@nestjs/common';
import { IDENTITY_DIRECTORY } from '../engine-tokens';
import { IdentityService } from './identity.service';

/** Tách khỏi AuthModule để worker cũng hỏi được IdentityDirectory mà không nạp auth HTTP. */
@Global()
@Module({
  providers: [IdentityService, { provide: IDENTITY_DIRECTORY, useExisting: IdentityService }],
  exports: [IDENTITY_DIRECTORY, IdentityService],
})
export class IdentityModule {}
