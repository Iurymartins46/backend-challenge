import { Injectable } from '@nestjs/common';

import type { ProviderIdentityPort } from './provider-identity.port';

@Injectable()
export class NoopProviderIdentityAdapter implements ProviderIdentityPort {
  identify(): Promise<null> {
    return Promise.resolve(null);
  }
}
