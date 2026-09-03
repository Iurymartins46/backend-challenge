import { describe, expect, test } from 'bun:test';

import { GetWagerTransactionUseCase } from '../../../src/modules/wagering/application/get-wager-transaction.use-case';
import type { FinancialUnitOfWorkPort } from '../../../src/modules/wagering/application/ports';

describe('GetWagerTransactionUseCase', () => {
  test('uses the authenticated provider when reading an internal transaction id', async () => {
    const calls: Array<{ id: string; providerId: string }> = [];
    const unitOfWork = {
      transactions: {
        findById: () => Promise.resolve(null),
        findByIdAndProviderId: (id: string, providerId: string) => {
          calls.push({ id, providerId });
          return Promise.resolve(null);
        },
      },
    } as unknown as FinancialUnitOfWorkPort;
    const useCase = new GetWagerTransactionUseCase(unitOfWork);

    expect(await rejectionOf(useCase.byId('transaction-a', 'provider-b'))).toMatchObject({
      code: 'error.wager.transaction_not_found',
    });
    expect(calls).toEqual([{ id: 'transaction-a', providerId: 'provider-b' }]);
  });
});

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected the use case to reject.');
}
