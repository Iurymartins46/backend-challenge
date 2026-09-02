import { Logger } from '@nestjs/common';

import type {
  FinancialUnitOfWorkPort,
  PendingReferenceClaim,
  PendingReferenceClaimInput,
} from '../../modules/wagering/application/ports';
import type {
  ProcessWagerTransactionUseCase,
  HttpWagerTransactionKind,
  ProcessWagerTransactionInput,
} from '../../modules/wagering/application';
import type { Clock, IdGenerator, RetryPolicy } from '../../modules/wagering/domain';
import { WagerTransactionStatus } from '../../modules/wagering/domain';
import { PendingReferenceWorkerMetrics } from './pending-reference-worker.metrics';
import { withTelemetrySpan } from '../telemetry';

export interface PendingReferenceWorkerOptions {
  readonly enabled: boolean;
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly shutdownTimeoutMs: number;
  readonly maxAttempts: number;
  readonly ttlMs: number;
  readonly retryPolicy: RetryPolicy;
}

export interface PendingReferenceWorkerBatchResult {
  readonly claimed: number;
  readonly processed: number;
  readonly rescheduled: number;
  readonly expired: number;
  readonly leaseLost: number;
}

type ClaimOutcome = 'processed' | 'rescheduled' | 'expired' | 'lease-lost' | 'failed';

/**
 * Durable scheduler for REFUND/ROLLBACK commands that arrived before their reference.
 * It deliberately delegates the financial transition to ProcessWagerTransactionUseCase.
 */
export class PendingReferenceWorker {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private readonly owner: string;
  private running = false;
  private loopPromise: Promise<void> | undefined;

  constructor(
    private readonly processor: ProcessWagerTransactionUseCase,
    private readonly unitOfWork: FinancialUnitOfWorkPort,
    private readonly clock: Clock,
    idGenerator: IdGenerator,
    private readonly options: PendingReferenceWorkerOptions,
    readonly metrics: PendingReferenceWorkerMetrics = new PendingReferenceWorkerMetrics(),
  ) {
    this.owner = `pending-reference-worker-${idGenerator.next()}`;
  }

  onModuleInit(): void {
    if (this.options.enabled) {
      this.start();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running || !this.options.enabled) {
      return;
    }

    this.running = true;
    this.loopPromise = this.pollLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    await Promise.race([
      this.loopPromise ?? Promise.resolve(),
      delay(this.options.shutdownTimeoutMs),
    ]);
    this.loopPromise = undefined;
  }

  /** Claims and processes one durable batch. Kept public for deterministic tests. */
  async processOnce(): Promise<PendingReferenceWorkerBatchResult> {
    const now = this.clock.now();
    const claimInput: PendingReferenceClaimInput = {
      now,
      limit: this.options.batchSize,
      owner: this.owner,
      leaseUntil: new Date(now.getTime() + this.options.leaseDurationMs),
    };
    const claims = await this.unitOfWork.transaction(async (unitOfWork) => {
      if (unitOfWork.transactions.claimPendingReferenceDue === undefined) {
        throw new Error('The configured transaction repository cannot claim pending references.');
      }
      return unitOfWork.transactions.claimPendingReferenceDue(claimInput);
    });

    this.metrics.increment('claimBatches');
    this.metrics.increment('claims', claims.length);
    this.metrics.increment('attempts', claims.length);

    const outcomes = await Promise.all(claims.map((claim) => this.processClaim(claim)));
    await this.refreshMetrics();
    return {
      claimed: claims.length,
      processed: outcomes.filter((outcome) => outcome === 'processed').length,
      rescheduled: outcomes.filter((outcome) => outcome === 'rescheduled').length,
      expired: outcomes.filter((outcome) => outcome === 'expired').length,
      leaseLost: outcomes.filter((outcome) => outcome === 'lease-lost').length,
    };
  }

  private async processClaim(claim: PendingReferenceClaim): Promise<ClaimOutcome> {
    return withTelemetrySpan(
      'pending_reference.process',
      {
        'wager.transaction.id': claim.transaction.id,
        'wager.wallet.id': claim.transaction.walletId,
        'wager.kind': claim.transaction.kind,
      },
      () => this.processClaimInternal(claim),
    );
  }

  private async processClaimInternal(claim: PendingReferenceClaim): Promise<ClaimOutcome> {
    const now = this.clock.now();
    const expiresNow =
      claim.attempts >= this.options.maxAttempts ||
      now.getTime() - claim.transaction.createdAt.getTime() >= this.options.ttlMs;

    try {
      const result = await this.processor.execute({
        ...toProcessInput(claim),
        expirePendingReference: expiresNow,
        source: 'worker',
      });

      if (result.status === WagerTransactionStatus.Processed) {
        await this.releaseClaim(claim, now);
        this.metrics.increment('processed');
        return 'processed';
      }
      if (result.status === WagerTransactionStatus.Rejected) {
        await this.releaseClaim(claim, now);
        if (expiresNow && result.failureCode === 'error.wager.reference_not_found') {
          this.metrics.increment('expired');
          return 'expired';
        }
        this.metrics.increment('processed');
        return 'processed';
      }
      if (result.status !== WagerTransactionStatus.PendingReference) {
        await this.releaseClaim(claim, now);
        this.metrics.increment('processed');
        return 'processed';
      }

      const retryAt = this.options.retryPolicy.nextAttemptAt(now, claim.attempts);
      claim.transaction.schedulePendingReferenceRetry(retryAt);
      const scheduled = await this.unitOfWork.transaction(async (unitOfWork) => {
        if (unitOfWork.transactions.schedulePendingReferenceRetryIfOwned === undefined) {
          throw new Error(
            'The configured transaction repository cannot schedule pending references.',
          );
        }
        return unitOfWork.transactions.schedulePendingReferenceRetryIfOwned({
          transaction: claim.transaction,
          owner: this.owner,
          now,
        });
      });
      if (!scheduled) {
        this.metrics.increment('leaseLost');
        return 'lease-lost';
      }

      this.metrics.increment('rescheduled');
      return 'rescheduled';
    } catch (error: unknown) {
      this.metrics.increment('processingFailures');
      this.logger.warn(
        `Pending reference ${claim.transaction.id} could not be processed; lease recovery will retry it: ${safeErrorMessage(error)}`,
      );
      return 'failed';
    }
  }

  private async releaseClaim(claim: PendingReferenceClaim, now: Date): Promise<void> {
    const released = await this.unitOfWork.transaction(async (unitOfWork) => {
      if (unitOfWork.transactions.releasePendingReferenceClaimIfOwned === undefined) {
        throw new Error('The configured transaction repository cannot release pending references.');
      }
      return unitOfWork.transactions.releasePendingReferenceClaimIfOwned({
        transactionId: claim.transaction.id,
        owner: this.owner,
        now,
      });
    });
    if (!released) {
      this.metrics.increment('leaseLost');
    }
  }

  private async refreshMetrics(): Promise<void> {
    try {
      const pending = await this.unitOfWork.transaction(async (unitOfWork) => {
        if (unitOfWork.transactions.measurePendingReferences === undefined) {
          return undefined;
        }
        return unitOfWork.transactions.measurePendingReferences(this.clock.now());
      });
      if (pending !== undefined) {
        this.metrics.set('pendingReferences', pending.pendingCount);
        this.metrics.set('pendingAttempts', pending.attempts);
      }
    } catch (error: unknown) {
      this.logger.warn(`Pending-reference metrics refresh failed: ${safeErrorMessage(error)}`);
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.processOnce();
      } catch (error: unknown) {
        this.metrics.increment('claimFailures');
        this.logger.warn(`Pending-reference polling failed: ${safeErrorMessage(error)}`);
      }

      if (this.running) {
        await delay(this.options.pollIntervalMs);
      }
    }
  }
}

function toProcessInput(claim: PendingReferenceClaim): ProcessWagerTransactionInput {
  const transaction = claim.transaction;
  return {
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind as HttpWagerTransactionKind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    correlationId: transaction.id,
    causationId: transaction.id,
    source: 'worker',
  };
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
