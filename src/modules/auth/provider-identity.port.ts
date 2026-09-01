export const PROVIDER_IDENTITY_PORT = Symbol('PROVIDER_IDENTITY_PORT');

export interface ProviderPrincipal {
  providerId: string;
  subject: string;
}

export interface ProviderIdentityPort {
  identify(request: unknown): Promise<ProviderPrincipal | null>;
}
