import type { WalletLedgerCursorPosition } from '../../wagering/application/ports/financial-repositories';

const LEDGER_CURSOR_VERSION = 1;

interface EncodedLedgerCursor {
  readonly version: typeof LEDGER_CURSOR_VERSION;
  readonly createdAt: string;
  readonly id: string;
}

export class InvalidLedgerCursorError extends Error {
  constructor() {
    super('The ledger cursor is invalid.');
    this.name = new.target.name;
  }
}

export function encodeLedgerCursor(position: WalletLedgerCursorPosition): string {
  const payload: EncodedLedgerCursor = {
    version: LEDGER_CURSOR_VERSION,
    createdAt: position.createdAt.toISOString(),
    id: position.id,
  };

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeLedgerCursor(cursor: string): WalletLedgerCursorPosition {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new InvalidLedgerCursorError();
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!isEncodedLedgerCursor(parsed)) {
      throw new InvalidLedgerCursorError();
    }

    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== parsed.createdAt) {
      throw new InvalidLedgerCursorError();
    }

    return { createdAt, id: parsed.id };
  } catch (error: unknown) {
    if (error instanceof InvalidLedgerCursorError) {
      throw error;
    }

    throw new InvalidLedgerCursorError();
  }
}

function isEncodedLedgerCursor(value: unknown): value is EncodedLedgerCursor {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === LEDGER_CURSOR_VERSION &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.id === 'string' &&
    candidate.id.length > 0
  );
}
