import { describe, expect, test } from 'bun:test';

import { validateEnvironment } from '../../src/config/environment';

describe('environment validation', () => {
  test('uses safe local defaults', () => {
    const config = validateEnvironment({});

    expect(config.PORT).toBe(3000);
    expect(config.AUTH_MODE).toBe('none');
    expect(config.OTEL_ENABLED).toBe(false);
    expect(config.SQS_COMMAND_QUEUE_NAME).toBe('wager-transactions.fifo');
    expect(config.SQS_OUTBOX_PUBLISHER_ENABLED).toBe(false);
    expect(config.SQS_OUTBOX_RETRY_JITTER_PERCENT).toBe(20);
  });

  test('validates outbox publisher operational limits', () => {
    expect(() =>
      validateEnvironment({
        SQS_OUTBOX_BATCH_SIZE: '11',
        SQS_OUTBOX_RETRY_JITTER_PERCENT: '101',
        SQS_OUTBOX_RETRY_BASE_DELAY_MS: '2000',
        SQS_OUTBOX_RETRY_MAX_DELAY_MS: '1000',
      }),
    ).toThrow(
      /SQS_OUTBOX_BATCH_SIZE.*SQS_OUTBOX_RETRY_JITTER_PERCENT.*SQS_OUTBOX_RETRY_MAX_DELAY_MS/,
    );
  });

  test('rejects invalid startup configuration with all errors', () => {
    expect(() =>
      validateEnvironment({
        PORT: 'not-a-port',
        AUTH_MODE: 'unsupported',
        OTEL_ENABLED: 'maybe',
        DATABASE_URL: 'not-a-url',
        SQS_COMMAND_QUEUE_NAME: 'not-fifo',
      }),
    ).toThrow(
      /Invalid environment configuration:.*PORT.*DATABASE_URL.*SQS_COMMAND_QUEUE_NAME.*AUTH_MODE.*OTEL_ENABLED/,
    );
  });
});
