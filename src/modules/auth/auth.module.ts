import { Module } from '@nestjs/common';

import { NoopProviderIdentityAdapter } from './noop-provider-identity.adapter';
import { ProviderAuthGuard } from './provider-auth.guard';
import { PROVIDER_IDENTITY_PORT } from './provider-identity.port';

@Module({
  providers: [
    NoopProviderIdentityAdapter,
    ProviderAuthGuard,
    {
      provide: PROVIDER_IDENTITY_PORT,
      useExisting: NoopProviderIdentityAdapter,
    },
  ],
  exports: [PROVIDER_IDENTITY_PORT, ProviderAuthGuard],
})
export class AuthModule {}
