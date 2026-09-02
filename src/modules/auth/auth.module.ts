import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/configuration';

import { NoopProviderIdentityAdapter } from './noop-provider-identity.adapter';
import { OidcProviderIdentityAdapter } from './oidc-provider-identity.adapter';
import { ProviderAuthGuard } from './provider-auth.guard';
import { PROVIDER_IDENTITY_PORT } from './provider-identity.port';

@Module({
  providers: [
    NoopProviderIdentityAdapter,
    OidcProviderIdentityAdapter,
    ProviderAuthGuard,
    {
      provide: PROVIDER_IDENTITY_PORT,
      inject: [ConfigService, NoopProviderIdentityAdapter, OidcProviderIdentityAdapter],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        noop: NoopProviderIdentityAdapter,
        oidc: OidcProviderIdentityAdapter,
      ) => (config.get('auth.mode', { infer: true }) === 'oidc' ? oidc : noop),
    },
  ],
  exports: [PROVIDER_IDENTITY_PORT, ProviderAuthGuard],
})
export class AuthModule {}
