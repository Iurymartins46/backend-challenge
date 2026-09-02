import { Logger } from '@nestjs/common';

import type {
  OutboxClaimInput,
  OutboxLeaseMutationInput,
  OutboxRetryMutationInput,
  FinancialUnitOfWorkPort,
} from '../../modules/wagering/application/ports';
import type { Clock, IdGenerator } from '../../modules/wagering/domain';
import type { OutboxMessage } from '../../modules/wagering/domain/outbox';
import { RetryExhaustedError } from '../../modules/wagering/domain/errors';
import type { RetryPolicy } from '../../modules/wagering/domain/retry-policy';
import { OutboxPublisherMetrics } from './outbox-publisher.metrics';
import type { SqsPublishOptions, SqsQueuePort } from './sqs-queue.port';

export interface OutboxPublisherOptions {
  readonly enabled: boolean;
  readonly eventsQueueName: string;
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly shutdownTimeoutMs: number;
  readonly retryPolicy: RetryPolicy;
  /** Test-only crash hook executed after claim commit and before SQS publish. */
  readonly beforePublish?: OutboxPublisherFailpoint;
}

export type OutboxPublisherFailpoint = (message: OutboxMessage) => Promise<void>;

export interface OutboxPublishBatchResult {
  readonly claimed: number;
  readonly published: number;
  readonly retried: number;
  readonly leaseLost: number;
}

type PublishOutcome = 'published' | 'retried' | 'lease-lost' | 'mark-failed';

export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);
  private readonly owner: string;
  private running = false;
  private loopPromise: Promise<void> | undefined;

  constructor(
    private readonly queue: SqsQueuePort,
    private readonly unitOfWork: FinancialUnitOfWorkPort,
    private readonly clock: Clock,
    idGenerator: IdGenerator,
    private readonly options: OutboxPublisherOptions,
    readonly metrics: OutboxPublisherMetrics = new OutboxPublisherMetrics(),
    private readonly afterPublishBeforeMark?: OutboxPublisherFailpoint,
  ) {
    this.owner = `outbox-publisher-${idGenerator.next()}`;
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
    await this.waitFor(this.loopPromise ?? Promise.resolve(), this.options.shutdownTimeoutMs);
    this.loopPromise = undefined;
  }

  /** Claims and drains one batch. It is also the controlled entry point for tests. */
  async publishOnce(): Promise<OutboxPublishBatchResult> {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + this.options.leaseDurationMs);
    const claimInput: OutboxClaimInput = {
      now,
      limit: this.options.batchSize,
      owner: this.owner,
      leaseUntil,
    };

    const claimed = await this.unitOfWork.transaction(async (unitOfWork) => {
      if (unitOfWork.outbox.claimDue === undefined) {
        throw new Error('The configured outbox repository cannot claim messages.');
      }

      return unitOfWork.outbox.claimDue(claimInput);
    });
    this.metrics.increment('claimBatches');
    this.metrics.increment('messagesClaimed', claimed.length);

    const outcomes = await Promise.all(claimed.map((message) => this.publishClaim(message)));
    const result = {
      claimed: claimed.length,
      published: outcomes.filter((outcome) => outcome === 'published').length,
      retried: outcomes.filter((outcome) => outcome === 'retried').length,
      leaseLost: outcomes.filter((outcome) => outcome === 'lease-lost').length,
    } satisfies OutboxPublishBatchResult;

    await this.refreshMetrics();
    return result;
  }

  private async publishClaim(message: OutboxMessage): Promise<PublishOutcome> {
    await this.options.beforePublish?.(message);

    let publishedToQueue = false;
    try {
      const publishOptions: SqsPublishOptions = {
        messageBody: JSON.stringify(message.payload),
        messageGroupId: message.aggregateId,
        messageDeduplicationId: message.id,
      };
      await this.queue.publish(this.options.eventsQueueName, publishOptions);
      publishedToQueue = true;
      await this.afterPublishBeforeMark?.(message);

      const marked = await this.unitOfWork.transaction(async (unitOfWork) => {
        if (unitOfWork.outbox.markPublishedIfOwned === undefined) {
          throw new Error('The configured outbox repository cannot mark messages as published.');
        }

        const input: OutboxLeaseMutationInput = {
          id: message.id,
          owner: this.owner,
          now: this.clock.now(),
        };
        return unitOfWork.outbox.markPublishedIfOwned(input);
      });

      if (!marked) {
        this.metrics.increment('leaseLost');
        this.logger.warn(`Outbox lease lost after publishing event ${message.id}.`);
        return 'lease-lost';
      }

      this.metrics.increment('messagesPublished');
      return 'published';
    } catch (error: unknown) {
      if (publishedToQueue) {
        this.metrics.increment('markFailures');
        this.logger.warn(
          `Outbox event ${message.id} was published but could not be marked; lease recovery will retry it: ${safeErrorMessage(error)}`,
        );
        return 'mark-failed';
      }

      this.metrics.increment('publishFailures');
      this.logger.warn(
        `Outbox event ${message.id} could not be published; scheduling retry: ${safeErrorMessage(error)}`,
      );
      return this.scheduleRetry(message);
    }
  }

  private async scheduleRetry(message: OutboxMessage): Promise<PublishOutcome> {
    const now = this.clock.now();
    let reachedOperationalLimit = false;
    try {
      try {
        message.scheduleRetry(now, this.options.retryPolicy);
      } catch (error: unknown) {
        if (!(error instanceof RetryExhaustedError)) {
          throw error;
        }

        reachedOperationalLimit = true;
        message.deferRetry(now, this.options.retryPolicy);
      }

      const saved = await this.unitOfWork.transaction(async (unitOfWork) => {
        if (unitOfWork.outbox.saveRetryIfOwned === undefined) {
          throw new Error('The configured outbox repository cannot schedule retries.');
        }

        const input: OutboxRetryMutationInput = {
          message,
          owner: this.owner,
          now,
        };
        return unitOfWork.outbox.saveRetryIfOwned(input);
      });

      if (!saved) {
        this.metrics.increment('leaseLost');
        return 'lease-lost';
      }

      this.metrics.increment('retryScheduled');
      if (reachedOperationalLimit) {
        this.metrics.increment('retryLimitReached');
      }
      return 'retried';
    } catch (error: unknown) {
      this.metrics.increment('retryFailures');
      this.logger.warn(
        `Outbox retry could not be persisted for event ${message.id}; lease recovery will retry it: ${safeErrorMessage(error)}`,
      );
      return 'mark-failed';
    }
  }

  private async refreshMetrics(): Promise<void> {
    const now = this.clock.now();
    try {
      const pendingMetrics = await this.unitOfWork.transaction(async (unitOfWork) => {
        if (unitOfWork.outbox.measurePending === undefined) {
          return undefined;
        }

        return unitOfWork.outbox.measurePending(now);
      });
      if (pendingMetrics !== undefined) {
        this.metrics.set('pendingMessages', pendingMetrics.pendingCount);
        this.metrics.set('lagMs', pendingMetrics.lagMs);
      }
    } catch (error: unknown) {
      this.logger.warn(`Outbox metrics refresh failed: ${safeErrorMessage(error)}`);
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.publishOnce();
      } catch (error: unknown) {
        this.metrics.increment('claimFailures');
        this.logger.warn(`Outbox polling failed: ${safeErrorMessage(error)}`);
      }

      if (this.running) {
        await delay(this.options.pollIntervalMs);
      }
    }
  }

  private async waitFor(promise: Promise<void>, timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) {
      return;
    }

    await Promise.race([promise, delay(timeoutMs)]);
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
