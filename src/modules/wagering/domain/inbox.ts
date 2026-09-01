import { DomainInvariantError } from './errors';

export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt?: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  readonly receivedAt: Date;
  readonly processedAt?: Date;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new DomainInvariantError(`${field} must not be empty.`);
  }
}

function cloneDate(date: Date): Date {
  if (Number.isNaN(date.getTime())) {
    throw new DomainInvariantError('Inbox date must be valid.');
  }

  return new Date(date.getTime());
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    assertNonEmpty(props.messageId, 'Inbox message id');
    assertNonEmpty(props.consumerName, 'Inbox consumer name');
    assertNonEmpty(props.payloadHash, 'Inbox payload hash');

    const receivedAt = cloneDate(props.receivedAt ?? new Date());
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, receivedAt);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      cloneDate(state.receivedAt),
      state.processedAt === undefined ? undefined : cloneDate(state.processedAt),
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt === undefined ? undefined : new Date(this._processedAt.getTime());
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new DomainInvariantError('Inbox message is already processed.');
    }

    this._processedAt = cloneDate(at);
  }
}
