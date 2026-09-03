import { describe, expect, test } from 'bun:test';
import pino from 'pino';

import { LOG_REDACT_PATHS } from '../../src/infrastructure/logging/redaction';

describe('structured logging', () => {
  test('keeps operational identifiers and removes headers, payload and financial values', () => {
    const lines: string[] = [];
    const logger = pino(
      {
        base: undefined,
        timestamp: false,
        redact: { paths: [...LOG_REDACT_PATHS], remove: true },
      },
      { write: (line: string) => lines.push(line) },
    );

    logger.info({
      correlationId: 'correlation-1',
      messageId: 'message-1',
      transactionId: 'transaction-1',
      walletId: 'wallet-1',
      providerId: 'provider-a',
      req: {
        headers: { authorization: 'Bearer secret-token' },
        body: { money: { amount: '25.00', currency: 'BRL' } },
      },
      res: { headers: { 'set-cookie': 'session=secret' } },
    });

    expect(lines).toHaveLength(1);
    const serialized = lines[0] ?? '';
    const entry = JSON.parse(serialized) as Record<string, unknown>;
    expect(entry).toMatchObject({
      correlationId: 'correlation-1',
      messageId: 'message-1',
      transactionId: 'transaction-1',
      walletId: 'wallet-1',
      providerId: 'provider-a',
      req: {},
      res: { headers: {} },
    });
    expect(serialized).not.toContain('authorization');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('25.00');
    expect(serialized).not.toContain('money');
    expect(serialized).not.toContain('session=secret');
  });
});
