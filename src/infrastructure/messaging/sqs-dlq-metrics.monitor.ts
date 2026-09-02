import { Logger } from '@nestjs/common';

import type { SqsQueuePort } from './sqs-queue.port';
import type { SqsConsumerMetrics } from './sqs-consumer.metrics';

export interface SqsDlqMetricsMonitorOptions {
  readonly enabled: boolean;
  readonly queueName: string;
  readonly refreshIntervalMs: number;
}

/** Refreshes the actual SQS DLQ depth independently from command processing. */
export class SqsDlqMetricsMonitor {
  private readonly logger = new Logger(SqsDlqMetricsMonitor.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshing = false;

  constructor(
    private readonly queue: SqsQueuePort,
    private readonly metrics: SqsConsumerMetrics,
    private readonly options: SqsDlqMetricsMonitorOptions,
  ) {}

  onModuleInit(): void {
    if (!this.options.enabled || this.timer !== undefined) {
      return;
    }

    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.options.refreshIntervalMs);
    timerUnref(this.timer);
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      return;
    }

    this.refreshing = true;
    try {
      const count = await this.queue.getApproximateMessageCount(this.options.queueName);
      this.metrics.setDlqMessages(count.total);
    } catch (error: unknown) {
      this.metrics.increment('dlqMetricRefreshFailures');
      this.logger.warn(`Unable to refresh SQS DLQ depth: ${safeErrorMessage(error)}`);
    } finally {
      this.refreshing = false;
    }
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function timerUnref(timer: ReturnType<typeof setInterval>): void {
  const maybeUnref = timer as ReturnType<typeof setInterval> & { unref?: () => void };
  maybeUnref.unref?.();
}
