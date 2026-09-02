export type AuthMode = 'none';
export type NodeEnvironment = 'development' | 'test' | 'production';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface RawEnvironment {
  [key: string]: unknown;
  NODE_ENV?: unknown;
  PORT?: unknown;
  HOST?: unknown;
  LOG_LEVEL?: unknown;
  DATABASE_URL?: unknown;
  DATABASE_LOCK_TIMEOUT_MS?: unknown;
  DATABASE_STATEMENT_TIMEOUT_MS?: unknown;
  AWS_REGION?: unknown;
  AWS_ACCESS_KEY_ID?: unknown;
  AWS_SECRET_ACCESS_KEY?: unknown;
  SQS_ENDPOINT?: unknown;
  SQS_COMMAND_QUEUE_NAME?: unknown;
  SQS_COMMAND_DLQ_NAME?: unknown;
  SQS_EVENTS_QUEUE_NAME?: unknown;
  SQS_CONSUMER_ENABLED?: unknown;
  SQS_CONSUMER_NAME?: unknown;
  SQS_CONSUMER_CONCURRENCY?: unknown;
  SQS_WAIT_TIME_SECONDS?: unknown;
  SQS_VISIBILITY_TIMEOUT_SECONDS?: unknown;
  SQS_VISIBILITY_HEARTBEAT_SECONDS?: unknown;
  SQS_SHUTDOWN_TIMEOUT_MS?: unknown;
  SQS_OUTBOX_PUBLISHER_ENABLED?: unknown;
  SQS_OUTBOX_BATCH_SIZE?: unknown;
  SQS_OUTBOX_POLL_INTERVAL_MS?: unknown;
  SQS_OUTBOX_LEASE_MS?: unknown;
  SQS_OUTBOX_SHUTDOWN_TIMEOUT_MS?: unknown;
  SQS_OUTBOX_MAX_ATTEMPTS?: unknown;
  SQS_OUTBOX_RETRY_BASE_DELAY_MS?: unknown;
  SQS_OUTBOX_RETRY_MAX_DELAY_MS?: unknown;
  SQS_OUTBOX_RETRY_JITTER_PERCENT?: unknown;
  PENDING_REFERENCE_WORKER_ENABLED?: unknown;
  PENDING_REFERENCE_BATCH_SIZE?: unknown;
  PENDING_REFERENCE_POLL_INTERVAL_MS?: unknown;
  PENDING_REFERENCE_LEASE_MS?: unknown;
  PENDING_REFERENCE_SHUTDOWN_TIMEOUT_MS?: unknown;
  PENDING_REFERENCE_MAX_ATTEMPTS?: unknown;
  PENDING_REFERENCE_TTL_MS?: unknown;
  PENDING_REFERENCE_RETRY_BASE_DELAY_MS?: unknown;
  PENDING_REFERENCE_RETRY_MAX_DELAY_MS?: unknown;
  PENDING_REFERENCE_RETRY_JITTER_PERCENT?: unknown;
  AUTH_MODE?: unknown;
  SWAGGER_ENABLED?: unknown;
  OTEL_ENABLED?: unknown;
  OTEL_SERVICE_NAME?: unknown;
  OTEL_SERVICE_VERSION?: unknown;
  OTEL_EXPORTER_OTLP_ENDPOINT?: unknown;
}

export interface ValidatedEnvironment {
  NODE_ENV: NodeEnvironment;
  PORT: number;
  HOST: string;
  LOG_LEVEL: LogLevel;
  DATABASE_URL: string;
  DATABASE_LOCK_TIMEOUT_MS: number;
  DATABASE_STATEMENT_TIMEOUT_MS: number;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  SQS_ENDPOINT: string;
  SQS_COMMAND_QUEUE_NAME: string;
  SQS_COMMAND_DLQ_NAME: string;
  SQS_EVENTS_QUEUE_NAME: string;
  SQS_CONSUMER_ENABLED: boolean;
  SQS_CONSUMER_NAME: string;
  SQS_CONSUMER_CONCURRENCY: number;
  SQS_WAIT_TIME_SECONDS: number;
  SQS_VISIBILITY_TIMEOUT_SECONDS: number;
  SQS_VISIBILITY_HEARTBEAT_SECONDS: number;
  SQS_SHUTDOWN_TIMEOUT_MS: number;
  SQS_OUTBOX_PUBLISHER_ENABLED: boolean;
  SQS_OUTBOX_BATCH_SIZE: number;
  SQS_OUTBOX_POLL_INTERVAL_MS: number;
  SQS_OUTBOX_LEASE_MS: number;
  SQS_OUTBOX_SHUTDOWN_TIMEOUT_MS: number;
  SQS_OUTBOX_MAX_ATTEMPTS: number;
  SQS_OUTBOX_RETRY_BASE_DELAY_MS: number;
  SQS_OUTBOX_RETRY_MAX_DELAY_MS: number;
  SQS_OUTBOX_RETRY_JITTER_PERCENT: number;
  PENDING_REFERENCE_WORKER_ENABLED: boolean;
  PENDING_REFERENCE_BATCH_SIZE: number;
  PENDING_REFERENCE_POLL_INTERVAL_MS: number;
  PENDING_REFERENCE_LEASE_MS: number;
  PENDING_REFERENCE_SHUTDOWN_TIMEOUT_MS: number;
  PENDING_REFERENCE_MAX_ATTEMPTS: number;
  PENDING_REFERENCE_TTL_MS: number;
  PENDING_REFERENCE_RETRY_BASE_DELAY_MS: number;
  PENDING_REFERENCE_RETRY_MAX_DELAY_MS: number;
  PENDING_REFERENCE_RETRY_JITTER_PERCENT: number;
  AUTH_MODE: AuthMode;
  SWAGGER_ENABLED: boolean;
  OTEL_ENABLED: boolean;
  OTEL_SERVICE_NAME: string;
  OTEL_SERVICE_VERSION: string;
  OTEL_EXPORTER_OTLP_ENDPOINT: string;
}

const defaults = {
  NODE_ENV: 'development',
  PORT: '3000',
  HOST: '0.0.0.0',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgres://wagering:wagering@localhost:5432/wagering',
  DATABASE_LOCK_TIMEOUT_MS: '5000',
  DATABASE_STATEMENT_TIMEOUT_MS: '30000',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  SQS_ENDPOINT: 'http://localhost:4566',
  SQS_COMMAND_QUEUE_NAME: 'wager-transactions.fifo',
  SQS_COMMAND_DLQ_NAME: 'wager-transactions-dlq.fifo',
  SQS_EVENTS_QUEUE_NAME: 'wager-events.fifo',
  // The application process opts into consuming explicitly; Compose enables it for the worker.
  SQS_CONSUMER_ENABLED: 'false',
  SQS_CONSUMER_NAME: 'wager-command-consumer',
  SQS_CONSUMER_CONCURRENCY: '4',
  SQS_WAIT_TIME_SECONDS: '20',
  SQS_VISIBILITY_TIMEOUT_SECONDS: '30',
  SQS_VISIBILITY_HEARTBEAT_SECONDS: '10',
  SQS_SHUTDOWN_TIMEOUT_MS: '10000',
  SQS_OUTBOX_PUBLISHER_ENABLED: 'false',
  SQS_OUTBOX_BATCH_SIZE: '10',
  SQS_OUTBOX_POLL_INTERVAL_MS: '1000',
  SQS_OUTBOX_LEASE_MS: '30000',
  SQS_OUTBOX_SHUTDOWN_TIMEOUT_MS: '10000',
  SQS_OUTBOX_MAX_ATTEMPTS: '10',
  SQS_OUTBOX_RETRY_BASE_DELAY_MS: '1000',
  SQS_OUTBOX_RETRY_MAX_DELAY_MS: '300000',
  SQS_OUTBOX_RETRY_JITTER_PERCENT: '20',
  PENDING_REFERENCE_WORKER_ENABLED: 'false',
  PENDING_REFERENCE_BATCH_SIZE: '10',
  PENDING_REFERENCE_POLL_INTERVAL_MS: '1000',
  PENDING_REFERENCE_LEASE_MS: '30000',
  PENDING_REFERENCE_SHUTDOWN_TIMEOUT_MS: '10000',
  PENDING_REFERENCE_MAX_ATTEMPTS: '10',
  PENDING_REFERENCE_TTL_MS: '1800000',
  PENDING_REFERENCE_RETRY_BASE_DELAY_MS: '2000',
  PENDING_REFERENCE_RETRY_MAX_DELAY_MS: '300000',
  PENDING_REFERENCE_RETRY_JITTER_PERCENT: '20',
  AUTH_MODE: 'none',
  SWAGGER_ENABLED: 'true',
  OTEL_ENABLED: 'false',
  OTEL_SERVICE_NAME: 'distributed-wagering-processor',
  OTEL_SERVICE_VERSION: '0.1.0',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
} as const;

function valueOrDefault(value: unknown, key: keyof typeof defaults): string {
  if (value === undefined || value === null || value === '') {
    return defaults[key];
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return `${value}`;
  }

  return defaults[key];
}

function parseBoolean(value: string, key: string, errors: string[]): boolean {
  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  errors.push(`${key} must be true or false`);
  return false;
}

function parseUrl(value: string, key: string, errors: string[]): string {
  try {
    new URL(value);
    return value;
  } catch {
    errors.push(`${key} must be a valid URL`);
    return value;
  }
}

function parsePositiveInteger(value: string, key: string, errors: string[]): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    errors.push(`${key} must be a positive integer`);
  }

  return parsed;
}

function parseNonNegativeInteger(value: string, key: string, errors: string[]): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    errors.push(`${key} must be a non-negative integer`);
  }

  return parsed;
}

function parseIntegerInRange(
  value: string,
  key: string,
  minimum: number,
  maximum: number,
  errors: string[],
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    errors.push(`${key} must be an integer between ${minimum} and ${maximum}`);
  }

  return parsed;
}

function parseNonEmptyString(value: string, key: string, errors: string[]): string {
  if (value.trim().length === 0) {
    errors.push(`${key} must not be empty`);
  }

  return value;
}

function parseFifoQueueName(value: string, key: string, errors: string[]): string {
  if (!/^[A-Za-z0-9_-]{1,75}\.fifo$/.test(value)) {
    errors.push(`${key} must be a valid FIFO queue name ending in .fifo`);
  }

  return value;
}

export function validateEnvironment(raw: RawEnvironment): ValidatedEnvironment {
  const errors: string[] = [];
  const nodeEnvironment = valueOrDefault(raw.NODE_ENV, 'NODE_ENV');
  const portValue = valueOrDefault(raw.PORT, 'PORT');
  const port = Number(portValue);

  if (!['development', 'test', 'production'].includes(nodeEnvironment)) {
    errors.push('NODE_ENV must be development, test or production');
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('PORT must be an integer between 1 and 65535');
  }

  const logLevel = valueOrDefault(raw.LOG_LEVEL, 'LOG_LEVEL');
  const validLogLevels: LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
  if (!validLogLevels.includes(logLevel as LogLevel)) {
    errors.push(`LOG_LEVEL must be one of ${validLogLevels.join(', ')}`);
  }

  const databaseUrl = parseUrl(
    valueOrDefault(raw.DATABASE_URL, 'DATABASE_URL'),
    'DATABASE_URL',
    errors,
  );
  const databaseLockTimeoutMs = parsePositiveInteger(
    valueOrDefault(raw.DATABASE_LOCK_TIMEOUT_MS, 'DATABASE_LOCK_TIMEOUT_MS'),
    'DATABASE_LOCK_TIMEOUT_MS',
    errors,
  );
  const databaseStatementTimeoutMs = parsePositiveInteger(
    valueOrDefault(raw.DATABASE_STATEMENT_TIMEOUT_MS, 'DATABASE_STATEMENT_TIMEOUT_MS'),
    'DATABASE_STATEMENT_TIMEOUT_MS',
    errors,
  );
  const sqsEndpoint = parseUrl(
    valueOrDefault(raw.SQS_ENDPOINT, 'SQS_ENDPOINT'),
    'SQS_ENDPOINT',
    errors,
  );
  const otelEndpoint = parseUrl(
    valueOrDefault(raw.OTEL_EXPORTER_OTLP_ENDPOINT, 'OTEL_EXPORTER_OTLP_ENDPOINT'),
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    errors,
  );
  const commandQueueName = parseFifoQueueName(
    valueOrDefault(raw.SQS_COMMAND_QUEUE_NAME, 'SQS_COMMAND_QUEUE_NAME'),
    'SQS_COMMAND_QUEUE_NAME',
    errors,
  );
  const commandDlqName = parseFifoQueueName(
    valueOrDefault(raw.SQS_COMMAND_DLQ_NAME, 'SQS_COMMAND_DLQ_NAME'),
    'SQS_COMMAND_DLQ_NAME',
    errors,
  );
  const eventsQueueName = parseFifoQueueName(
    valueOrDefault(raw.SQS_EVENTS_QUEUE_NAME, 'SQS_EVENTS_QUEUE_NAME'),
    'SQS_EVENTS_QUEUE_NAME',
    errors,
  );
  const sqsConsumerEnabled = parseBoolean(
    valueOrDefault(raw.SQS_CONSUMER_ENABLED, 'SQS_CONSUMER_ENABLED'),
    'SQS_CONSUMER_ENABLED',
    errors,
  );
  const sqsConsumerName = parseNonEmptyString(
    valueOrDefault(raw.SQS_CONSUMER_NAME, 'SQS_CONSUMER_NAME'),
    'SQS_CONSUMER_NAME',
    errors,
  );
  const sqsConsumerConcurrency = parsePositiveInteger(
    valueOrDefault(raw.SQS_CONSUMER_CONCURRENCY, 'SQS_CONSUMER_CONCURRENCY'),
    'SQS_CONSUMER_CONCURRENCY',
    errors,
  );
  const sqsWaitTimeSeconds = parseIntegerInRange(
    valueOrDefault(raw.SQS_WAIT_TIME_SECONDS, 'SQS_WAIT_TIME_SECONDS'),
    'SQS_WAIT_TIME_SECONDS',
    0,
    20,
    errors,
  );
  const sqsVisibilityTimeoutSeconds = parsePositiveInteger(
    valueOrDefault(raw.SQS_VISIBILITY_TIMEOUT_SECONDS, 'SQS_VISIBILITY_TIMEOUT_SECONDS'),
    'SQS_VISIBILITY_TIMEOUT_SECONDS',
    errors,
  );
  const sqsVisibilityHeartbeatSeconds = parsePositiveInteger(
    valueOrDefault(raw.SQS_VISIBILITY_HEARTBEAT_SECONDS, 'SQS_VISIBILITY_HEARTBEAT_SECONDS'),
    'SQS_VISIBILITY_HEARTBEAT_SECONDS',
    errors,
  );
  const sqsShutdownTimeoutMs = parsePositiveInteger(
    valueOrDefault(raw.SQS_SHUTDOWN_TIMEOUT_MS, 'SQS_SHUTDOWN_TIMEOUT_MS'),
    'SQS_SHUTDOWN_TIMEOUT_MS',
    errors,
  );
  const sqsOutboxPublisherEnabled = parseBoolean(
    valueOrDefault(raw.SQS_OUTBOX_PUBLISHER_ENABLED, 'SQS_OUTBOX_PUBLISHER_ENABLED'),
    'SQS_OUTBOX_PUBLISHER_ENABLED',
    errors,
  );
  const sqsOutboxBatchSize = parseIntegerInRange(
    valueOrDefault(raw.SQS_OUTBOX_BATCH_SIZE, 'SQS_OUTBOX_BATCH_SIZE'),
    'SQS_OUTBOX_BATCH_SIZE',
    1,
    10,
    errors,
  );
  const sqsOutboxPollIntervalMs = parsePositiveInteger(
    valueOrDefault(raw.SQS_OUTBOX_POLL_INTERVAL_MS, 'SQS_OUTBOX_POLL_INTERVAL_MS'),
    'SQS_OUTBOX_POLL_INTERVAL_MS',
    errors,
  );
  const sqsOutboxLeaseMs = parsePositiveInteger(
    valueOrDefault(raw.SQS_OUTBOX_LEASE_MS, 'SQS_OUTBOX_LEASE_MS'),
    'SQS_OUTBOX_LEASE_MS',
    errors,
  );
  const sqsOutboxShutdownTimeoutMs = parsePositiveInteger(
    valueOrDefault(raw.SQS_OUTBOX_SHUTDOWN_TIMEOUT_MS, 'SQS_OUTBOX_SHUTDOWN_TIMEOUT_MS'),
    'SQS_OUTBOX_SHUTDOWN_TIMEOUT_MS',
    errors,
  );
  const sqsOutboxMaxAttempts = parsePositiveInteger(
    valueOrDefault(raw.SQS_OUTBOX_MAX_ATTEMPTS, 'SQS_OUTBOX_MAX_ATTEMPTS'),
    'SQS_OUTBOX_MAX_ATTEMPTS',
    errors,
  );
  const sqsOutboxRetryBaseDelayMs = parseNonNegativeInteger(
    valueOrDefault(raw.SQS_OUTBOX_RETRY_BASE_DELAY_MS, 'SQS_OUTBOX_RETRY_BASE_DELAY_MS'),
    'SQS_OUTBOX_RETRY_BASE_DELAY_MS',
    errors,
  );
  const sqsOutboxRetryMaxDelayMs = parsePositiveInteger(
    valueOrDefault(raw.SQS_OUTBOX_RETRY_MAX_DELAY_MS, 'SQS_OUTBOX_RETRY_MAX_DELAY_MS'),
    'SQS_OUTBOX_RETRY_MAX_DELAY_MS',
    errors,
  );
  const sqsOutboxRetryJitterPercent = parseIntegerInRange(
    valueOrDefault(raw.SQS_OUTBOX_RETRY_JITTER_PERCENT, 'SQS_OUTBOX_RETRY_JITTER_PERCENT'),
    'SQS_OUTBOX_RETRY_JITTER_PERCENT',
    0,
    100,
    errors,
  );
  const pendingReferenceWorkerEnabled = parseBoolean(
    valueOrDefault(raw.PENDING_REFERENCE_WORKER_ENABLED, 'PENDING_REFERENCE_WORKER_ENABLED'),
    'PENDING_REFERENCE_WORKER_ENABLED',
    errors,
  );
  const pendingReferenceBatchSize = parseIntegerInRange(
    valueOrDefault(raw.PENDING_REFERENCE_BATCH_SIZE, 'PENDING_REFERENCE_BATCH_SIZE'),
    'PENDING_REFERENCE_BATCH_SIZE',
    1,
    100,
    errors,
  );
  const pendingReferencePollIntervalMs = parsePositiveInteger(
    valueOrDefault(raw.PENDING_REFERENCE_POLL_INTERVAL_MS, 'PENDING_REFERENCE_POLL_INTERVAL_MS'),
    'PENDING_REFERENCE_POLL_INTERVAL_MS',
    errors,
  );
  const pendingReferenceLeaseMs = parsePositiveInteger(
    valueOrDefault(raw.PENDING_REFERENCE_LEASE_MS, 'PENDING_REFERENCE_LEASE_MS'),
    'PENDING_REFERENCE_LEASE_MS',
    errors,
  );
  const pendingReferenceShutdownTimeoutMs = parsePositiveInteger(
    valueOrDefault(
      raw.PENDING_REFERENCE_SHUTDOWN_TIMEOUT_MS,
      'PENDING_REFERENCE_SHUTDOWN_TIMEOUT_MS',
    ),
    'PENDING_REFERENCE_SHUTDOWN_TIMEOUT_MS',
    errors,
  );
  const pendingReferenceMaxAttempts = parsePositiveInteger(
    valueOrDefault(raw.PENDING_REFERENCE_MAX_ATTEMPTS, 'PENDING_REFERENCE_MAX_ATTEMPTS'),
    'PENDING_REFERENCE_MAX_ATTEMPTS',
    errors,
  );
  const pendingReferenceTtlMs = parsePositiveInteger(
    valueOrDefault(raw.PENDING_REFERENCE_TTL_MS, 'PENDING_REFERENCE_TTL_MS'),
    'PENDING_REFERENCE_TTL_MS',
    errors,
  );
  const pendingReferenceRetryBaseDelayMs = parsePositiveInteger(
    valueOrDefault(
      raw.PENDING_REFERENCE_RETRY_BASE_DELAY_MS,
      'PENDING_REFERENCE_RETRY_BASE_DELAY_MS',
    ),
    'PENDING_REFERENCE_RETRY_BASE_DELAY_MS',
    errors,
  );
  const pendingReferenceRetryMaxDelayMs = parsePositiveInteger(
    valueOrDefault(
      raw.PENDING_REFERENCE_RETRY_MAX_DELAY_MS,
      'PENDING_REFERENCE_RETRY_MAX_DELAY_MS',
    ),
    'PENDING_REFERENCE_RETRY_MAX_DELAY_MS',
    errors,
  );
  const pendingReferenceRetryJitterPercent = parseIntegerInRange(
    valueOrDefault(
      raw.PENDING_REFERENCE_RETRY_JITTER_PERCENT,
      'PENDING_REFERENCE_RETRY_JITTER_PERCENT',
    ),
    'PENDING_REFERENCE_RETRY_JITTER_PERCENT',
    0,
    100,
    errors,
  );

  if (sqsVisibilityHeartbeatSeconds >= sqsVisibilityTimeoutSeconds) {
    errors.push(
      'SQS_VISIBILITY_HEARTBEAT_SECONDS must be lower than SQS_VISIBILITY_TIMEOUT_SECONDS',
    );
  }

  if (sqsOutboxRetryMaxDelayMs < sqsOutboxRetryBaseDelayMs) {
    errors.push('SQS_OUTBOX_RETRY_MAX_DELAY_MS must be greater than or equal to the base delay');
  }
  if (pendingReferenceRetryMaxDelayMs < pendingReferenceRetryBaseDelayMs) {
    errors.push(
      'PENDING_REFERENCE_RETRY_MAX_DELAY_MS must be greater than or equal to the base delay',
    );
  }

  if (new Set([commandQueueName, commandDlqName, eventsQueueName]).size !== 3) {
    errors.push('SQS command, DLQ and events queue names must be distinct');
  }
  const authMode = valueOrDefault(raw.AUTH_MODE, 'AUTH_MODE');

  if (authMode !== 'none') {
    errors.push('AUTH_MODE is limited to none until the OIDC phase is implemented');
  }

  const swaggerEnabled = parseBoolean(
    valueOrDefault(raw.SWAGGER_ENABLED, 'SWAGGER_ENABLED'),
    'SWAGGER_ENABLED',
    errors,
  );
  const otelEnabled = parseBoolean(
    valueOrDefault(raw.OTEL_ENABLED, 'OTEL_ENABLED'),
    'OTEL_ENABLED',
    errors,
  );

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration: ${errors.join('; ')}`);
  }

  return {
    NODE_ENV: nodeEnvironment as NodeEnvironment,
    PORT: port,
    HOST: valueOrDefault(raw.HOST, 'HOST'),
    LOG_LEVEL: logLevel as LogLevel,
    DATABASE_URL: databaseUrl,
    DATABASE_LOCK_TIMEOUT_MS: databaseLockTimeoutMs,
    DATABASE_STATEMENT_TIMEOUT_MS: databaseStatementTimeoutMs,
    AWS_REGION: valueOrDefault(raw.AWS_REGION, 'AWS_REGION'),
    AWS_ACCESS_KEY_ID: valueOrDefault(raw.AWS_ACCESS_KEY_ID, 'AWS_ACCESS_KEY_ID'),
    AWS_SECRET_ACCESS_KEY: valueOrDefault(raw.AWS_SECRET_ACCESS_KEY, 'AWS_SECRET_ACCESS_KEY'),
    SQS_ENDPOINT: sqsEndpoint,
    SQS_COMMAND_QUEUE_NAME: commandQueueName,
    SQS_COMMAND_DLQ_NAME: commandDlqName,
    SQS_EVENTS_QUEUE_NAME: eventsQueueName,
    SQS_CONSUMER_ENABLED: sqsConsumerEnabled,
    SQS_CONSUMER_NAME: sqsConsumerName,
    SQS_CONSUMER_CONCURRENCY: sqsConsumerConcurrency,
    SQS_WAIT_TIME_SECONDS: sqsWaitTimeSeconds,
    SQS_VISIBILITY_TIMEOUT_SECONDS: sqsVisibilityTimeoutSeconds,
    SQS_VISIBILITY_HEARTBEAT_SECONDS: sqsVisibilityHeartbeatSeconds,
    SQS_SHUTDOWN_TIMEOUT_MS: sqsShutdownTimeoutMs,
    SQS_OUTBOX_PUBLISHER_ENABLED: sqsOutboxPublisherEnabled,
    SQS_OUTBOX_BATCH_SIZE: sqsOutboxBatchSize,
    SQS_OUTBOX_POLL_INTERVAL_MS: sqsOutboxPollIntervalMs,
    SQS_OUTBOX_LEASE_MS: sqsOutboxLeaseMs,
    SQS_OUTBOX_SHUTDOWN_TIMEOUT_MS: sqsOutboxShutdownTimeoutMs,
    SQS_OUTBOX_MAX_ATTEMPTS: sqsOutboxMaxAttempts,
    SQS_OUTBOX_RETRY_BASE_DELAY_MS: sqsOutboxRetryBaseDelayMs,
    SQS_OUTBOX_RETRY_MAX_DELAY_MS: sqsOutboxRetryMaxDelayMs,
    SQS_OUTBOX_RETRY_JITTER_PERCENT: sqsOutboxRetryJitterPercent,
    PENDING_REFERENCE_WORKER_ENABLED: pendingReferenceWorkerEnabled,
    PENDING_REFERENCE_BATCH_SIZE: pendingReferenceBatchSize,
    PENDING_REFERENCE_POLL_INTERVAL_MS: pendingReferencePollIntervalMs,
    PENDING_REFERENCE_LEASE_MS: pendingReferenceLeaseMs,
    PENDING_REFERENCE_SHUTDOWN_TIMEOUT_MS: pendingReferenceShutdownTimeoutMs,
    PENDING_REFERENCE_MAX_ATTEMPTS: pendingReferenceMaxAttempts,
    PENDING_REFERENCE_TTL_MS: pendingReferenceTtlMs,
    PENDING_REFERENCE_RETRY_BASE_DELAY_MS: pendingReferenceRetryBaseDelayMs,
    PENDING_REFERENCE_RETRY_MAX_DELAY_MS: pendingReferenceRetryMaxDelayMs,
    PENDING_REFERENCE_RETRY_JITTER_PERCENT: pendingReferenceRetryJitterPercent,
    AUTH_MODE: authMode as AuthMode,
    SWAGGER_ENABLED: swaggerEnabled,
    OTEL_ENABLED: otelEnabled,
    OTEL_SERVICE_NAME: valueOrDefault(raw.OTEL_SERVICE_NAME, 'OTEL_SERVICE_NAME'),
    OTEL_SERVICE_VERSION: valueOrDefault(raw.OTEL_SERVICE_VERSION, 'OTEL_SERVICE_VERSION'),
    OTEL_EXPORTER_OTLP_ENDPOINT: otelEndpoint,
  };
}

export function environmentFromProcess(): ValidatedEnvironment {
  return validateEnvironment(process.env);
}
