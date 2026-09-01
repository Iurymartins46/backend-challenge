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
  AWS_REGION?: unknown;
  AWS_ACCESS_KEY_ID?: unknown;
  AWS_SECRET_ACCESS_KEY?: unknown;
  SQS_ENDPOINT?: unknown;
  SQS_COMMAND_QUEUE_NAME?: unknown;
  SQS_COMMAND_DLQ_NAME?: unknown;
  SQS_EVENTS_QUEUE_NAME?: unknown;
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
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  SQS_ENDPOINT: string;
  SQS_COMMAND_QUEUE_NAME: string;
  SQS_COMMAND_DLQ_NAME: string;
  SQS_EVENTS_QUEUE_NAME: string;
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
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  SQS_ENDPOINT: 'http://localhost:4566',
  SQS_COMMAND_QUEUE_NAME: 'wager-transactions.fifo',
  SQS_COMMAND_DLQ_NAME: 'wager-transactions-dlq.fifo',
  SQS_EVENTS_QUEUE_NAME: 'wager-events.fifo',
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
    AWS_REGION: valueOrDefault(raw.AWS_REGION, 'AWS_REGION'),
    AWS_ACCESS_KEY_ID: valueOrDefault(raw.AWS_ACCESS_KEY_ID, 'AWS_ACCESS_KEY_ID'),
    AWS_SECRET_ACCESS_KEY: valueOrDefault(raw.AWS_SECRET_ACCESS_KEY, 'AWS_SECRET_ACCESS_KEY'),
    SQS_ENDPOINT: sqsEndpoint,
    SQS_COMMAND_QUEUE_NAME: commandQueueName,
    SQS_COMMAND_DLQ_NAME: commandDlqName,
    SQS_EVENTS_QUEUE_NAME: eventsQueueName,
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
