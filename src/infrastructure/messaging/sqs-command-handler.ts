import type { Clock } from '../../modules/wagering/domain';
import type {
  ProcessWagerTransactionInput,
  WagerTransactionSubmissionView,
} from '../../modules/wagering/application/transaction.types';
import type { ProcessWagerTransactionUseCase } from '../../modules/wagering/application';
import {
  parseWagerTransactionCommandEnvelope,
  toProcessWagerTransactionInput,
  type SqsWagerCommandEnvelope,
} from './sqs-command-envelope';
import type { SqsTransportMessage } from './sqs-queue.port';

export interface WagerTransactionProcessor {
  execute(input: ProcessWagerTransactionInput): Promise<WagerTransactionSubmissionView>;
}

export interface SqsCommandHandlingResult {
  readonly envelope: SqsWagerCommandEnvelope;
  readonly result: WagerTransactionSubmissionView;
}

export class SqsWagerCommandHandler {
  constructor(
    private readonly processor: WagerTransactionProcessor | ProcessWagerTransactionUseCase,
    private readonly consumerName: string,
    private readonly clock: Clock,
  ) {}

  async handle(message: SqsTransportMessage): Promise<SqsCommandHandlingResult> {
    const envelope = parseWagerTransactionCommandEnvelope(message.body, this.clock.now());
    const result = await this.processor.execute(
      toProcessWagerTransactionInput(envelope, this.consumerName),
    );

    return { envelope, result };
  }
}
