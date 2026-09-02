import type { ValidatedEnvironment } from './environment';
import { validateEnvironment } from './environment';

export interface AppConfig {
  app: {
    environment: ValidatedEnvironment['NODE_ENV'];
    host: string;
    port: number;
  };
  auth: {
    mode: ValidatedEnvironment['AUTH_MODE'];
    oidc: {
      issuer: string;
      jwksUri: string;
      audience: string;
      providerIdClaim: string;
      jwksCacheTtlMs: number;
      requestTimeoutMs: number;
    };
  };
  database: {
    url: string;
    lockTimeoutMs: number;
    statementTimeoutMs: number;
  };
  logging: {
    level: ValidatedEnvironment['LOG_LEVEL'];
  };
  messaging: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    commandQueueName: string;
    commandDlqName: string;
    eventsQueueName: string;
    consumerEnabled: boolean;
    consumerName: string;
    consumerConcurrency: number;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
    visibilityHeartbeatSeconds: number;
    shutdownTimeoutMs: number;
    outbox: {
      enabled: boolean;
      batchSize: number;
      pollIntervalMs: number;
      leaseDurationMs: number;
      shutdownTimeoutMs: number;
      maxAttempts: number;
      retryBaseDelayMs: number;
      retryMaxDelayMs: number;
      retryJitterRatio: number;
    };
    pendingReference: {
      enabled: boolean;
      batchSize: number;
      pollIntervalMs: number;
      leaseDurationMs: number;
      shutdownTimeoutMs: number;
      maxAttempts: number;
      ttlMs: number;
      retryBaseDelayMs: number;
      retryMaxDelayMs: number;
      retryJitterRatio: number;
    };
  };
  observability: {
    enabled: boolean;
    serviceName: string;
    serviceVersion: string;
    exporterEndpoint: string;
  };
  health: {
    timeoutMs: number;
  };
  swagger: {
    enabled: boolean;
  };
}

export function configuration(): AppConfig {
  const env = validateEnvironment(process.env);

  return {
    app: {
      environment: env.NODE_ENV,
      host: env.HOST,
      port: env.PORT,
    },
    auth: {
      mode: env.AUTH_MODE,
      oidc: {
        issuer: env.OIDC_ISSUER,
        jwksUri: env.OIDC_JWKS_URI,
        audience: env.OIDC_AUDIENCE,
        providerIdClaim: env.OIDC_PROVIDER_ID_CLAIM,
        jwksCacheTtlMs: env.OIDC_JWKS_CACHE_TTL_MS,
        requestTimeoutMs: env.OIDC_REQUEST_TIMEOUT_MS,
      },
    },
    database: {
      url: env.DATABASE_URL,
      lockTimeoutMs: env.DATABASE_LOCK_TIMEOUT_MS,
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    },
    logging: {
      level: env.LOG_LEVEL,
    },
    messaging: {
      region: env.AWS_REGION,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      endpoint: env.SQS_ENDPOINT,
      commandQueueName: env.SQS_COMMAND_QUEUE_NAME,
      commandDlqName: env.SQS_COMMAND_DLQ_NAME,
      eventsQueueName: env.SQS_EVENTS_QUEUE_NAME,
      consumerEnabled: env.SQS_CONSUMER_ENABLED,
      consumerName: env.SQS_CONSUMER_NAME,
      consumerConcurrency: env.SQS_CONSUMER_CONCURRENCY,
      waitTimeSeconds: env.SQS_WAIT_TIME_SECONDS,
      visibilityTimeoutSeconds: env.SQS_VISIBILITY_TIMEOUT_SECONDS,
      visibilityHeartbeatSeconds: env.SQS_VISIBILITY_HEARTBEAT_SECONDS,
      shutdownTimeoutMs: env.SQS_SHUTDOWN_TIMEOUT_MS,
      outbox: {
        enabled: env.SQS_OUTBOX_PUBLISHER_ENABLED,
        batchSize: env.SQS_OUTBOX_BATCH_SIZE,
        pollIntervalMs: env.SQS_OUTBOX_POLL_INTERVAL_MS,
        leaseDurationMs: env.SQS_OUTBOX_LEASE_MS,
        shutdownTimeoutMs: env.SQS_OUTBOX_SHUTDOWN_TIMEOUT_MS,
        maxAttempts: env.SQS_OUTBOX_MAX_ATTEMPTS,
        retryBaseDelayMs: env.SQS_OUTBOX_RETRY_BASE_DELAY_MS,
        retryMaxDelayMs: env.SQS_OUTBOX_RETRY_MAX_DELAY_MS,
        retryJitterRatio: env.SQS_OUTBOX_RETRY_JITTER_PERCENT / 100,
      },
      pendingReference: {
        enabled: env.PENDING_REFERENCE_WORKER_ENABLED,
        batchSize: env.PENDING_REFERENCE_BATCH_SIZE,
        pollIntervalMs: env.PENDING_REFERENCE_POLL_INTERVAL_MS,
        leaseDurationMs: env.PENDING_REFERENCE_LEASE_MS,
        shutdownTimeoutMs: env.PENDING_REFERENCE_SHUTDOWN_TIMEOUT_MS,
        maxAttempts: env.PENDING_REFERENCE_MAX_ATTEMPTS,
        ttlMs: env.PENDING_REFERENCE_TTL_MS,
        retryBaseDelayMs: env.PENDING_REFERENCE_RETRY_BASE_DELAY_MS,
        retryMaxDelayMs: env.PENDING_REFERENCE_RETRY_MAX_DELAY_MS,
        retryJitterRatio: env.PENDING_REFERENCE_RETRY_JITTER_PERCENT / 100,
      },
    },
    observability: {
      enabled: env.OTEL_ENABLED,
      serviceName: env.OTEL_SERVICE_NAME,
      serviceVersion: env.OTEL_SERVICE_VERSION,
      exporterEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    },
    health: {
      timeoutMs: env.HEALTHCHECK_TIMEOUT_MS,
    },
    swagger: {
      enabled: env.SWAGGER_ENABLED,
    },
  };
}
