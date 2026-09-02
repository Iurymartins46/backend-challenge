import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

import { ErrorCode } from '../../common/http/error-codes';
import type { AppConfig } from '../../config/configuration';
import type { ProviderIdentityPort, ProviderPrincipal } from './provider-identity.port';

interface JwtHeader {
  readonly alg?: unknown;
  readonly kid?: unknown;
}

interface JwtClaims {
  readonly iss?: unknown;
  readonly aud?: unknown;
  readonly exp?: unknown;
  readonly nbf?: unknown;
  readonly sub?: unknown;
  readonly scope?: unknown;
  readonly [claim: string]: unknown;
}

interface JwksResponse {
  readonly keys?: unknown;
}

interface CachedJwks {
  readonly keys: ReadonlyMap<string, KeyObject>;
  readonly expiresAt: number;
}

interface RequestWithHeaders {
  readonly headers?: Record<string, string | string[] | undefined>;
}

@Injectable()
export class OidcProviderIdentityAdapter implements ProviderIdentityPort {
  private cache: CachedJwks | undefined;
  private refreshInFlight: Promise<CachedJwks> | undefined;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async identify(request: unknown): Promise<ProviderPrincipal | null> {
    const token = bearerToken(request);
    if (token === undefined) {
      return null;
    }

    const claims = await this.verifyJwt(token);
    const providerId = stringClaim(claims[this.oidcConfig().providerIdClaim]);
    const subject = stringClaim(claims.sub);
    if (providerId === undefined || subject === undefined) {
      throw invalidToken();
    }

    return {
      providerId,
      subject,
      scopes: scopeClaim(claims.wagering_scopes ?? claims.scope),
    };
  }

  private async verifyJwt(token: string): Promise<JwtClaims> {
    const [encodedHeader, encodedPayload, encodedSignature, ...extraParts] = token.split('.');
    if (
      encodedHeader === undefined ||
      encodedPayload === undefined ||
      encodedSignature === undefined ||
      extraParts.length > 0
    ) {
      throw invalidToken();
    }

    const header = decodeJson<JwtHeader>(encodedHeader);
    const claims = decodeJson<JwtClaims>(encodedPayload);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length === 0) {
      throw invalidToken();
    }

    this.validateClaims(claims);
    const key = await this.keyFor(header.kid);
    const signature = Buffer.from(encodedSignature, 'base64url');
    const isValid = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8'),
      key,
      signature,
    );
    if (!isValid) {
      throw invalidToken();
    }

    return claims;
  }

  private validateClaims(claims: JwtClaims): void {
    const config = this.oidcConfig();
    const now = Math.floor(Date.now() / 1000);
    const audience = audienceClaim(claims.aud);

    if (
      claims.iss !== config.issuer ||
      !audience.includes(config.audience) ||
      typeof claims.exp !== 'number' ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= now ||
      (claims.nbf !== undefined &&
        (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf > now))
    ) {
      throw invalidToken();
    }
  }

  private async keyFor(kid: string): Promise<KeyObject> {
    const cached = this.cache;
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      const key = cached.keys.get(kid);
      if (key !== undefined) {
        return key;
      }
    }

    const refreshed = await this.fetchJwks();
    const key = refreshed.keys.get(kid);
    if (key === undefined) {
      throw invalidToken();
    }
    return key;
  }

  private async fetchJwks(): Promise<CachedJwks> {
    if (this.refreshInFlight !== undefined) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.requestJwks();
    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  private async requestJwks(): Promise<CachedJwks> {
    const config = this.oidcConfig();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetch(config.jwksUri, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw identityProviderUnavailable();
      }

      const payload = (await response.json()) as JwksResponse;
      if (!Array.isArray(payload.keys)) {
        throw identityProviderUnavailable();
      }

      const keys = new Map<string, KeyObject>();
      for (const candidate of payload.keys) {
        const key = publicKeyFromJwk(candidate);
        if (key !== undefined) {
          keys.set(key.kid, key.value);
        }
      }
      if (keys.size === 0) {
        throw identityProviderUnavailable();
      }

      const cached = { keys, expiresAt: Date.now() + config.jwksCacheTtlMs };
      this.cache = cached;
      return cached;
    } catch (error: unknown) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      throw identityProviderUnavailable();
    } finally {
      clearTimeout(timeout);
    }
  }

  private oidcConfig(): AppConfig['auth']['oidc'] {
    return this.config.get('auth.oidc', { infer: true });
  }
}

function bearerToken(request: unknown): string | undefined {
  const authorization = (request as RequestWithHeaders).headers?.authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  const match = value?.match(/^Bearer ([^\s]+)$/i);
  return match?.[1];
}

function decodeJson<T>(value: string): T {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
  } catch {
    throw invalidToken();
  }
}

function audienceClaim(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    return [value];
  }
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function scopeClaim(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    return value.split(' ').filter((scope) => scope.length > 0);
  }
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function publicKeyFromJwk(
  value: unknown,
): { readonly kid: string; readonly value: KeyObject } | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { kty?: unknown }).kty !== 'RSA' ||
    typeof (value as { kid?: unknown }).kid !== 'string'
  ) {
    return undefined;
  }

  try {
    return {
      kid: (value as { kid: string }).kid,
      value: createPublicKey({ key: value as JsonWebKey, format: 'jwk' }),
    };
  } catch {
    return undefined;
  }
}

function invalidToken(): UnauthorizedException {
  return new UnauthorizedException({
    message: 'The bearer access token is invalid.',
    errors: [{ code: ErrorCode.AuthTokenInvalid, detail: 'The bearer access token is invalid.' }],
  });
}

function identityProviderUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: 'The identity provider key set is temporarily unavailable.',
    errors: [
      {
        code: ErrorCode.AuthIdentityProviderUnavailable,
        detail: 'The identity provider key set is temporarily unavailable.',
      },
    ],
  });
}
