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

describe('provider auth boundary', () => {
  test('explicitly allows requests while AUTH_MODE is none', () => {
    const config = {
      get: () => 'none',
    } as unknown as ConfigService<AppConfig, true>;
    const guard = new ProviderAuthGuard(new Reflector(), config);

    expect(guard.canActivate(executionContext())).toBe(true);
  });
});
