import { describe, expect, test } from 'bun:test';

import { DatabaseHealthCheck } from '../../src/infrastructure/database/database-health.check';

describe('database health check', () => {
  test('requires the financial schema in addition to a database connection', async () => {
    const dataSource = {
      isInitialized: true,
      query: () => Promise.resolve([{ wallets: null }]),
    };
    const check = new DatabaseHealthCheck(dataSource as never);

    await expectFailure(check.check(), 'financial database schema is not ready');
  });

  test('accepts an initialized database with the wallets table', async () => {
    const dataSource = {
      isInitialized: true,
      query: () => Promise.resolve([{ wallets: 'wallets' }]),
    };
    const check = new DatabaseHealthCheck(dataSource as never);

    await check.check();
  });
});

async function expectFailure(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toHaveProperty('message', expect.stringContaining(message));
    return;
  }
  throw new Error('Expected the health check to fail.');
}
