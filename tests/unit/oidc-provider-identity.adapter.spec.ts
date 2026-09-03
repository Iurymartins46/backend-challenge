import type { ConfigService } from '@nestjs/config';
import { generateKeyPairSync, sign, type JsonWebKey, type KeyObject } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';

import type { AppConfig } from '../../src/config/configuration';
import { OidcProviderIdentityAdapter } from '../../src/modules/auth/oidc-provider-identity.adapter';

const issuer = 'https://identity.example.test/realms/wagering';
const jwksUri = `${issuer}/protocol/openid-connect/certs`;
const audience = 'wagering-api';
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('OIDC provider identity adapter', () => {
  test('validates issuer, audience, RS256 signature, expiration and provider claim', async () => {
    const key = rsaKey('key-1');
    mockJwks([key.publicJwk]);
    const adapter = new OidcProviderIdentityAdapter(oidcConfig());

    const principal = await adapter.identify({
      headers: {
        authorization: `Bearer ${token(key.privateKey, {
          provider_id: 'provider-a',
          scope: 'profile email',
          wagering_scopes: 'wager:read wager:write',
        })}`,
      },
    });
    expect(principal).toEqual({
      providerId: 'provider-a',
      subject: 'service-account-provider-a',
      scopes: ['wager:read', 'wager:write'],
    });
  });

  test('rejects expired, wrong issuer, wrong audience and tampered tokens', async () => {
    const key = rsaKey('key-1');
    mockJwks([key.publicJwk]);
    const adapter = new OidcProviderIdentityAdapter(oidcConfig());

    for (const claims of [
      { exp: Math.floor(Date.now() / 1000) - 1 },
      { iss: 'https://other.example.test/realms/wagering' },
      { aud: 'another-api' },
    ]) {
      await expectHttpStatus(
        adapter.identify({ headers: { authorization: `Bearer ${token(key.privateKey, claims)}` } }),
        401,
      );
    }

    const valid = token(key.privateKey, {});
    const [header, payload, encodedSignature] = valid.split('.');
    if (header === undefined || payload === undefined || encodedSignature === undefined) {
      throw new Error('Expected a JWT with three parts.');
    }
    const signature = Buffer.from(encodedSignature, 'base64url');
    signature[0] = (signature[0] ?? 0) ^ 1;
    const tampered = `${header}.${payload}.${signature.toString('base64url')}`;
    expect(Buffer.from(tampered.split('.')[2] ?? '', 'base64url')).not.toEqual(
      Buffer.from(encodedSignature, 'base64url'),
    );
    await expectHttpStatus(
      adapter.identify({ headers: { authorization: `Bearer ${tampered}` } }),
      401,
    );
  });

  test('refreshes JWKS once when a new kid appears after key rotation', async () => {
    const first = rsaKey('key-1');
    const second = rsaKey('key-2');
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(
        Response.json({ keys: calls === 1 ? [first.publicJwk] : [second.publicJwk] }),
      );
    }) as unknown as typeof fetch;
    const adapter = new OidcProviderIdentityAdapter(oidcConfig());

    expect(
      await adapter.identify({
        headers: { authorization: `Bearer ${token(first.privateKey, {})}` },
      }),
    ).toBeDefined();
    expect(
      await adapter.identify({
        headers: { authorization: `Bearer ${token(second.privateKey, {}, second.kid)}` },
      }),
    ).toBeDefined();
    expect(calls).toBe(2);
  });

  test('returns a retryable error when JWKS cannot be refreshed', async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error('network unavailable'))) as unknown as typeof fetch;
    const adapter = new OidcProviderIdentityAdapter(oidcConfig());
    const key = rsaKey('key-1');

    await expectHttpStatus(
      adapter.identify({ headers: { authorization: `Bearer ${token(key.privateKey, {})}` } }),
      503,
    );
  });
});

function oidcConfig(): ConfigService<AppConfig, true> {
  return {
    get: (path: string) => {
      if (path === 'auth.oidc') {
        return {
          issuer,
          jwksUri,
          audience,
          providerIdClaim: 'provider_id',
          jwksCacheTtlMs: 300_000,
          requestTimeoutMs: 100,
        };
      }
      return 'oidc';
    },
  } as unknown as ConfigService<AppConfig, true>;
}

function rsaKey(kid: string): {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: JsonWebKey;
} {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    kid,
    privateKey: pair.privateKey,
    publicJwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' },
  };
}

function token(privateKey: KeyObject, overrides: Record<string, unknown>, kid = 'key-1'): string {
  const header = base64url({ alg: 'RS256', kid, typ: 'JWT' });
  const payload = base64url({
    iss: issuer,
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 60,
    sub: 'service-account-provider-a',
    provider_id: 'provider-a',
    scope: 'wager:read wager:write',
    ...overrides,
  });
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString(
    'base64url',
  );
  return `${header}.${payload}.${signature}`;
}

function mockJwks(keys: JsonWebKey[]): void {
  globalThis.fetch = (() => Promise.resolve(Response.json({ keys }))) as unknown as typeof fetch;
}

async function expectHttpStatus(promise: Promise<unknown>, status: number): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected HTTP ${status} rejection.`);
  } catch (error: unknown) {
    expect(error).toMatchObject({ status });
  }
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
