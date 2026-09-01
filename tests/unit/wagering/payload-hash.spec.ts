import { describe, expect, test } from 'bun:test';

import {
  canonicalizeJson,
  canonicalizeWagerPayload,
  hashWagerPayload,
  isTransientFinancialError,
} from '../../../src/modules/wagering/application';
import { WagerTransactionKind } from '../../../src/modules/wagering/domain';

const payload = {
  providerId: 'provider-a',
  externalTransactionId: 'external-1',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
} as const;

describe('wager payload canonicalization', () => {
  test('sorts object keys recursively using the RFC 8785 compact form', () => {
    expect(canonicalizeJson({ z: 'last', nested: { b: true, a: 'first' }, a: ['x', 'y'] })).toBe(
      '{"a":["x","y"],"nested":{"a":"first","b":true},"z":"last"}',
    );
  });

  test('produces the same business hash regardless of input key order', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      roundId: 'round-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      externalTransactionId: 'external-1',
      providerId: 'provider-a',
    } as const;

    expect(canonicalizeWagerPayload(payload)).toBe(canonicalizeWagerPayload(reordered));
    expect(hashWagerPayload(payload)).toBe(hashWagerPayload(reordered));
  });

  test('does not accept non-finite JSON numbers', () => {
    expect(() => canonicalizeJson({ value: Infinity })).toThrow(TypeError);
  });

  test('recognizes PostgreSQL lock failures without treating domain errors as transient', () => {
    expect(
      isTransientFinancialError(Object.assign(new Error('lock timeout'), { code: '55P03' })),
    ).toBe(true);
    expect(isTransientFinancialError(new Error('ordinary failure'))).toBe(false);
  });
});
