export type WalletReconciliationMetricName = 'checks' | 'divergences';

export type WalletReconciliationMetricsSnapshot = Readonly<
  Record<WalletReconciliationMetricName, number>
>;

const metricNames: readonly WalletReconciliationMetricName[] = ['checks', 'divergences'];

/** Process-local diagnostics; reconciliation never mutates persisted financial state. */
export class WalletReconciliationMetrics {
  private readonly values = new Map<WalletReconciliationMetricName, number>(
    metricNames.map((name) => [name, 0]),
  );

  constructor(private readonly telemetry: TelemetryMetrics = getTelemetryMetrics()) {}

  increment(name: WalletReconciliationMetricName): void {
    this.values.set(name, (this.values.get(name) ?? 0) + 1);
    this.telemetry.increment(`wagering.reconciliation.${name}`);
  }

  snapshot(): WalletReconciliationMetricsSnapshot {
    return Object.fromEntries(
      metricNames.map((name) => [name, this.values.get(name) ?? 0]),
    ) as WalletReconciliationMetricsSnapshot;
  }
}
import {
  getTelemetryMetrics,
  type TelemetryMetrics,
} from '../../../infrastructure/telemetry/metrics';
