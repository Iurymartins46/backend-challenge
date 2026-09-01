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
  };
  database: {
    url: string;
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
  };
  observability: {
    enabled: boolean;
    serviceName: string;
    serviceVersion: string;
    exporterEndpoint: string;
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
    },
    database: {
      url: env.DATABASE_URL,
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
    },
    observability: {
      enabled: env.OTEL_ENABLED,
      serviceName: env.OTEL_SERVICE_NAME,
      serviceVersion: env.OTEL_SERVICE_VERSION,
      exporterEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    },
    swagger: {
      enabled: env.SWAGGER_ENABLED,
    },
  };
}
