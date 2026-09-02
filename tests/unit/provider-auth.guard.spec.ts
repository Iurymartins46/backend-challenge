import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { describe, expect, test } from 'bun:test';

import type { AppConfig } from '../../src/config/configuration';
import { ProviderAuthGuard } from '../../src/modules/auth/provider-auth.guard';

function executionContext(): ExecutionContext {
  return {
    getClass: () => class TestController {},
    getHandler: () => function testHandler() {},
  } as unknown as ExecutionContext;
}

function oidcExecutionContext(request: unknown): ExecutionContext {
  return {
    getClass: () => class TestController {},
    getHandler: () => function testHandler() {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('provider auth boundary', () => {
  test('explicitly allows requests while AUTH_MODE is none', async () => {
    const config = {
      get: () => 'none',
    } as unknown as ConfigService<AppConfig, true>;
    const identity = { identify: () => Promise.resolve(null) };
    const guard = new ProviderAuthGuard(new Reflector(), config, identity);

    expect(await guard.canActivate(executionContext())).toBe(true);
  });

  test('rejects an OIDC principal whose provider differs from the operation provider', async () => {
    const config = { get: () => 'oidc' } as unknown as ConfigService<AppConfig, true>;
    const identity = {
      identify: () =>
        Promise.resolve({ providerId: 'provider-a', subject: 'subject', scopes: ['wager:write'] }),
    };
    const guard = new ProviderAuthGuard(new Reflector(), config, identity);

    await expectHttpStatus(
      guard.canActivate(oidcExecutionContext({ body: { providerId: 'provider-b' }, headers: {} })),
      403,
    );
  });

  test('rejects an OIDC principal missing a route scope', async () => {
    const reflector = {
      getAllAndOverride: (key: string) => (key === 'provider-scopes' ? ['wager:write'] : undefined),
    } as unknown as Reflector;
    const config = { get: () => 'oidc' } as unknown as ConfigService<AppConfig, true>;
    const identity = {
      identify: () => Promise.resolve({ providerId: 'provider-a', subject: 'subject', scopes: [] }),
    };
    const guard = new ProviderAuthGuard(reflector, config, identity);

    await expectHttpStatus(
      guard.canActivate(oidcExecutionContext({ body: { providerId: 'provider-a' }, headers: {} })),
      403,
    );
  });
});

async function expectHttpStatus(promise: Promise<unknown>, status: number): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected HTTP ${status} rejection.`);
  } catch (error: unknown) {
    expect(error).toMatchObject({ status });
  }
}
