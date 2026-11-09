import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';

/** Chỉ API nạp module này; worker không có gateway. */
@Module({ providers: [RealtimeGateway] })
export class RealtimeModule {}
