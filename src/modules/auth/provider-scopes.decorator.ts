import { SetMetadata } from '@nestjs/common';

export const PROVIDER_SCOPES = 'provider-scopes';

export const ProviderScopes = (...scopes: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PROVIDER_SCOPES, scopes);
