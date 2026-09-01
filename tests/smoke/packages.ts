import '@nestjs/common';
import '@nestjs/platform-fastify';
import '@nestjs/typeorm';
import '@aws-sdk/client-sqs';
import '@opentelemetry/sdk-node';
import '@opentelemetry/instrumentation-pg';

console.log('package-smoke:pass');
