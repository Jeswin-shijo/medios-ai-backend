import { Global, Module } from '@nestjs/common';
import { SupportBridge } from './support-bridge';

/** Global and without dependencies, so Calls and Patient Support share one bridge. */
@Global()
@Module({ providers: [SupportBridge], exports: [SupportBridge] })
export class SupportBridgeModule {}
