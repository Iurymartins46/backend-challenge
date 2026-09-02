import { Logger } from '@nestjs/common';

import { isTransientFinancialError } from '../../modules/wagering/application/process-wager-transaction.use-case';
import { WagerTransactionStatus } from '../../modules/wagering/domain/wager-transaction';
import { DependencyUnavailableError, DomainError } from '../../modules/wagering/domain/errors';
import { SqsConsumerMetrics } from './sqs-consumer.metrics';
import type { SqsQueuePort, SqsTransportMessage } from './sqs-queue.port';
import type { SqsCommandHandlingResult } from './sqs-command-handler';

export interface SqsCommandConsumerOptions {
  readonly enabled: boolean;
  readonly queueName: string;
  readonly consumerName: string;
  readonly concurrency: number;
  readonly waitTimeSeconds: number;
  readonly visibilityTimeoutSeconds: number;
  readonly visibilityHeartbeatSeconds: number;
  readonly shutdownTimeoutMs: number;
}

type ActiveMessage = {
  readonly message: SqsTransportMessage;
  readonly heartbeat: ReturnType<typeof setInterval>;
};

export type SqsMessageFailureClass = 'transient' | 'permanent';

export interface SqsCommandHandlerPort {
  handle(message: SqsTransportMessage): Promise<SqsCommandHandlingResult>;
}

export class SqsCommandConsumer {
  private readonly logger = new Logger(SqsCommandConsumer.name);
  private readonly inFlight = new Set<Promise<void>>();
  private readonly activeMessages = new Map<string, ActiveMessage>();
  private running = false;
  private pollPromise: Promise<void> | undefined;
  private abortController: AbortController | undefined;

  constructor(
    private readonly queue: SqsQueuePort,
    private readonly handler: SqsCommandHandlerPort,
    private readonly options: SqsCommandConsumerOptions,
    readonly metrics: SqsConsumerMetrics = new SqsConsumerMetrics(),
  ) {}

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
    this.abortController = new AbortController();
    this.pollPromise = this.pollLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    this.abortController?.abort();
    const deadline = Date.now() + this.options.shutdownTimeoutMs;

    await this.waitFor(this.pollPromise ?? Promise.resolve(), Math.max(0, deadline - Date.now()));

    await this.waitForInFlight(Math.max(0, deadline - Date.now()));

    if (this.inFlight.size > 0) {
      await this.releaseUnfinishedMessages();
    }

    this.pollPromise = undefined;
    this.abortController = undefined;
  }

  /** Receives and drains one batch. Useful for controlled integration tests. */
  async pollOnce(): Promise<number> {
    const messages = await this.queue.receive(this.options.queueName, {
      maxNumberOfMessages: Math.min(this.options.concurrency, 10),
      waitTimeSeconds: this.options.waitTimeSeconds,
      visibilityTimeoutSeconds: this.options.visibilityTimeoutSeconds,
      signal: this.abortController?.signal,
    });

    await Promise.all(messages.map((message) => this.processMessage(message)));
    return messages.length;
  }

  /** Processes one received message and deletes it only after the use case resolves. */
  async processMessage(message: SqsTransportMessage): Promise<void> {
    this.metrics.increment('messagesReceived');
    if (message.receiptHandle.trim().length === 0) {
      this.recordFailure('permanent', new Error('SQS message has no receipt handle.'));
      return;
    }

    const active = this.startHeartbeat(message);
    let financialWorkCommitted = false;
    try {
      const handled = await this.handler.handle(message);
      financialWorkCommitted = true;
      this.recordResult(handled.result.status, handled.result.idempotentReplay);

      // The handler returns only after the financial transaction committed.
      await this.queue.delete(this.options.queueName, message.receiptHandle);
      this.metrics.increment('messagesAcked');
    } catch (error: unknown) {
      if (financialWorkCommitted) {
        this.metrics.increment('deleteFailures');
      }
      this.recordFailure(
        financialWorkCommitted ? 'transient' : classifySqsMessageFailure(error),
        error,
      );
      // No DeleteMessage here. SQS visibility/redrive owns retry and DLQ delivery.
    } finally {
      clearInterval(active.heartbeat);
      this.activeMessages.delete(message.receiptHandle);
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        while (this.running && this.inFlight.size >= this.options.concurrency) {
          await Promise.race(this.inFlight);
        }

        if (!this.running) {
          return;
        }

        const capacity = this.options.concurrency - this.inFlight.size;
        const messages = await this.queue.receive(this.options.queueName, {
          maxNumberOfMessages: Math.min(capacity, 10),
          waitTimeSeconds: this.options.waitTimeSeconds,
          visibilityTimeoutSeconds: this.options.visibilityTimeoutSeconds,
          signal: this.abortController?.signal,
        });

        for (const message of messages) {
          const task = this.processMessage(message);
          this.inFlight.add(task);
          void task.then(
            () => this.inFlight.delete(task),
            () => this.inFlight.delete(task),
          );
        }
      } catch (error: unknown) {
        if (!this.running && isAbortError(error)) {
          return;
        }

        this.metrics.increment('pollingFailures');
        this.logger.warn(
          `SQS polling failed; retrying without acknowledging messages: ${safeErrorMessage(error)}`,
        );
        await delay(250);
      }
    }
  }

  private startHeartbeat(message: SqsTransportMessage): ActiveMessage {
    const heartbeat = setInterval(() => {
      void this.queue
        .changeVisibility(
          this.options.queueName,
          message.receiptHandle,
          this.options.visibilityTimeoutSeconds,
        )
        .then(() => this.metrics.increment('visibilityHeartbeats'))
        .catch((error: unknown) => {
          this.metrics.increment('visibilityFailures');
          this.logger.warn(`SQS visibility heartbeat failed: ${safeErrorMessage(error)}`);
        });
    }, this.options.visibilityHeartbeatSeconds * 1000);
    timerUnref(heartbeat);

    const active = { message, heartbeat };
    this.activeMessages.set(message.receiptHandle, active);
    return active;
  }

  private async waitForInFlight(timeoutMs: number): Promise<void> {
    if (this.inFlight.size === 0 || timeoutMs <= 0) {
      return;
    }

    await this.waitFor(Promise.allSettled(this.inFlight), timeoutMs);
  }

  private async releaseUnfinishedMessages(): Promise<void> {
    const activeMessages = [...this.activeMessages.values()];
    await Promise.allSettled(
      activeMessages.map(({ message, heartbeat }) => {
        clearInterval(heartbeat);
        return this.queue.changeVisibility(this.options.queueName, message.receiptHandle, 0);
      }),
    );
  }

  private async waitFor<T>(promise: Promise<T>, timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) {
      return;
    }

    await Promise.race([promise, delay(timeoutMs)]);
  }

  private recordResult(status: WagerTransactionStatus, replay: boolean): void {
    if (replay) {
      this.metrics.increment('duplicateMessages');
    }

    if (status === WagerTransactionStatus.Processed) {
      this.metrics.increment('messagesProcessed');
    } else if (status === WagerTransactionStatus.Rejected) {
      this.metrics.increment('messagesRejected');
    } else if (status === WagerTransactionStatus.PendingReference) {
      this.metrics.increment('messagesPendingReference');
    }
  }

  private recordFailure(failureClass: SqsMessageFailureClass, error: unknown): void {
    this.metrics.increment(
      failureClass === 'transient' ? 'transientFailures' : 'permanentFailures',
    );
    const message = safeErrorMessage(error);
    if (failureClass === 'transient') {
      this.logger.warn(`Transient SQS command failure; message will be redelivered: ${message}`);
    } else {
      this.logger.warn(
        `Permanent SQS command failure; message will be redriven to DLQ: ${message}`,
      );
    }
  }
}

export function classifySqsMessageFailure(error: unknown): SqsMessageFailureClass {
  if (error instanceof DependencyUnavailableError || isTransientFinancialError(error)) {
    return 'transient';
  }

  if (error instanceof DomainError) {
    return 'permanent';
  }

  return 'permanent';
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function timerUnref(timer: ReturnType<typeof setInterval>): void {
  const maybeUnref = timer as ReturnType<typeof setInterval> & { unref?: () => void };
  maybeUnref.unref?.();
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
