import { createHash } from 'node:crypto';

import type { MoneyProps } from '../domain/money';
import type { WagerTransactionKind } from '../domain/wager-transaction';

export interface WagerBusinessPayload {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
}

type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** RFC 8785 JSON Canonicalization Scheme for the values used by wager payloads. */
export function canonicalizeJson(value: JsonValue): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('RFC 8785 cannot canonicalize a non-finite number.');
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const arrayValue = value as readonly JsonValue[];
    return `[${arrayValue.map((item) => canonicalizeJson(item)).join(',')}]`;
  }

  const keys = Object.keys(value).sort(compareUtf16CodeUnits);
  const objectValue = value as { readonly [key: string]: JsonValue };
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(objectValue[key] as JsonValue)}`).join(',')}}`;
}

function compareUtf16CodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

export function canonicalizeWagerPayload(payload: WagerBusinessPayload): string {
  return canonicalizeJson({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: {
      amount: payload.money.amount,
      currency: payload.money.currency,
    },
    ...(payload.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: payload.referenceExternalTransactionId }),
  });
}

export function hashWagerPayload(payload: WagerBusinessPayload): string {
  return createHash('sha256').update(canonicalizeWagerPayload(payload), 'utf8').digest('hex');
}
