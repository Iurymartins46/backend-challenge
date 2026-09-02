export const PROVIDER_IDENTITY_PORT = Symbol('PROVIDER_IDENTITY_PORT');

export interface ProviderPrincipal {
  readonly providerId: string;
  readonly subject: string;
  readonly scopes: readonly string[];
}

export interface ProviderIdentityPort {
  identify(request: unknown): Promise<ProviderPrincipal | null>;
}
