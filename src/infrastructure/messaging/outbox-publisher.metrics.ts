import { getTelemetryMetrics, type TelemetryMetrics } from '../telemetry/metrics';

export type OutboxPublisherMetricName =
  | 'claimBatches'
  | 'messagesClaimed'
  | 'messagesPublished'
  | 'publishFailures'
  | 'retryScheduled'
  | 'retryLimitReached'
  | 'leaseLost'
  | 'claimFailures'
  | 'markFailures'
  | 'retryFailures'
  | 'pendingMessages'
  | 'lagMs';

export type OutboxPublisherMetricsSnapshot = Readonly<Record<OutboxPublisherMetricName, number>>;

const metricNames: readonly OutboxPublisherMetricName[] = [
  'claimBatches',
  'messagesClaimed',
  'messagesPublished',
  'publishFailures',
  'retryScheduled',
  'retryLimitReached',
  'leaseLost',
  'claimFailures',
  'markFailures',
  'retryFailures',
  'pendingMessages',
  'lagMs',
];

/** Process-local diagnostics; the outbox rows remain the source of truth. */
export class OutboxPublisherMetrics {
  private readonly values = new Map<OutboxPublisherMetricName, number>(
    metricNames.map((name) => [name, 0]),
  );

  constructor(private readonly telemetry: TelemetryMetrics = getTelemetryMetrics()) {
    this.telemetry.setGauge('wagering.outbox.pending.messages', 0);
    this.telemetry.setGauge('wagering.outbox.lag.ms', 0);
  }

  increment(name: OutboxPublisherMetricName, value = 1): void {
    this.values.set(name, (this.values.get(name) ?? 0) + value);
    this.telemetry.increment(`wagering.outbox.${name}`, value);
  }

  set(name: OutboxPublisherMetricName, value: number): void {
    this.values.set(name, value);
    if (name === 'pendingMessages') {
      this.telemetry.setGauge('wagering.outbox.pending.messages', value);
    } else if (name === 'lagMs') {
      this.telemetry.setGauge('wagering.outbox.lag.ms', value);
    }
  }

  snapshot(): OutboxPublisherMetricsSnapshot {
    return Object.fromEntries(
      metricNames.map((name) => [name, this.values.get(name) ?? 0]),
    ) as OutboxPublisherMetricsSnapshot;
  }
}
