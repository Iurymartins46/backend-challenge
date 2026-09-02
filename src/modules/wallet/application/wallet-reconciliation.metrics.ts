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

  increment(name: WalletReconciliationMetricName): void {
    this.values.set(name, (this.values.get(name) ?? 0) + 1);
  }

  snapshot(): WalletReconciliationMetricsSnapshot {
    return Object.fromEntries(
      metricNames.map((name) => [name, this.values.get(name) ?? 0]),
    ) as WalletReconciliationMetricsSnapshot;
  }
}
