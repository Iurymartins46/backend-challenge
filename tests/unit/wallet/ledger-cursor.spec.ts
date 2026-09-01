import { describe, expect, test } from 'bun:test';

import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  InvalidLedgerCursorError,
} from '../../../src/modules/wallet/application';

describe('wallet ledger cursor', () => {
  test('round-trips a versioned opaque Base64URL cursor', () => {
    const position = {
      createdAt: new Date('2026-09-01T12:00:00.000Z'),
      id: '0192f299-345e-7d38-af88-e43f851a819d',
    };
    const cursor = encodeLedgerCursor(position);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeLedgerCursor(cursor)).toEqual(position);
  });

  test('rejects malformed, unversioned and non-canonical cursors', () => {
    expect(() => decodeLedgerCursor('not a cursor')).toThrow(InvalidLedgerCursorError);
    expect(() => decodeLedgerCursor('eyJ2ZXJzaW9uIjo5fQ')).toThrow(InvalidLedgerCursorError);
    expect(() =>
      decodeLedgerCursor('eyJ2ZXJzaW9uIjoxLCJjcmVhdGVkQXQiOiIyMDI2IiwiaWQiOiJ4In0'),
    ).toThrow(InvalidLedgerCursorError);
  });
});
