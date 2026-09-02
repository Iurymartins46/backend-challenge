import { getTelemetryMetrics, type TelemetryMetrics } from '../telemetry/metrics';

export type SqsConsumerMetricName =
  | 'messagesReceived'
  | 'messagesAcked'
  | 'messagesProcessed'
  | 'messagesRejected'
  | 'messagesPendingReference'
  | 'duplicateMessages'
  | 'transientFailures'
  | 'permanentFailures'
  | 'dlqMetricRefreshFailures'
  | 'dlqMessages'
  | 'pollingFailures'
  | 'deleteFailures'
  | 'visibilityHeartbeats'
  | 'visibilityFailures';

export type SqsConsumerMetricsSnapshot = Readonly<Record<SqsConsumerMetricName, number>>;
type SqsConsumerCounterName = Exclude<SqsConsumerMetricName, 'dlqMessages'>;

const metricNames: readonly SqsConsumerMetricName[] = [
  'messagesReceived',
  'messagesAcked',
  'messagesProcessed',
  'messagesRejected',
  'messagesPendingReference',
  'duplicateMessages',
  'transientFailures',
  'permanentFailures',
  'dlqMetricRefreshFailures',
  'dlqMessages',
  'pollingFailures',
  'deleteFailures',
  'visibilityHeartbeats',
  'visibilityFailures',
];

/** Local diagnostics plus the last SQS-sourced DLQ depth; financial state remains in PostgreSQL. */
export class SqsConsumerMetrics {
  private readonly values = new Map<SqsConsumerMetricName, number>(
    metricNames.map((name) => [name, 0]),
  );

  constructor(private readonly telemetry: TelemetryMetrics = getTelemetryMetrics()) {
    this.telemetry.setGauge('wagering.sqs.messages.dlq', 0);
  }

  increment(name: SqsConsumerCounterName, value = 1): void {
    this.values.set(name, (this.values.get(name) ?? 0) + value);
    this.telemetry.increment(sqsMetricName(name), value);
  }

  setDlqMessages(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('DLQ message count must be a non-negative safe integer.');
    }
    this.values.set('dlqMessages', value);
    this.telemetry.setGauge('wagering.sqs.messages.dlq', value);
  }

  snapshot(): SqsConsumerMetricsSnapshot {
    return Object.fromEntries(
      metricNames.map((name) => [name, this.values.get(name) ?? 0]),
    ) as SqsConsumerMetricsSnapshot;
  }
}

function sqsMetricName(name: SqsConsumerCounterName): string {
  if (name === 'transientFailures') {
    return 'wagering.sqs.retries';
  }
  if (name === 'permanentFailures') {
    return 'wagering.sqs.consumer.permanent_failures';
  }
  if (name === 'dlqMetricRefreshFailures') {
    return 'wagering.sqs.dlq.metric_refresh_failures';
  }
  return `wagering.sqs.consumer.${name}`;
}
