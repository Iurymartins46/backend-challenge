import { describe, expect, test } from 'bun:test';

import { validateEnvironment } from '../../src/config/environment';

describe('environment validation', () => {
  test('uses safe local defaults', () => {
    const config = validateEnvironment({});

    expect(config.PORT).toBe(3000);
    expect(config.AUTH_MODE).toBe('none');
    expect(config.OTEL_ENABLED).toBe(false);
    expect(config.SQS_COMMAND_QUEUE_NAME).toBe('wager-transactions.fifo');
  });

  test('rejects invalid startup configuration with all errors', () => {
    expect(() =>
      validateEnvironment({
        PORT: 'not-a-port',
        AUTH_MODE: 'oidc',
        OTEL_ENABLED: 'maybe',
        DATABASE_URL: 'not-a-url',
        SQS_COMMAND_QUEUE_NAME: 'not-fifo',
      }),
    ).toThrow(
      /Invalid environment configuration:.*PORT.*DATABASE_URL.*SQS_COMMAND_QUEUE_NAME.*AUTH_MODE.*OTEL_ENABLED/,
    );
  });
});
