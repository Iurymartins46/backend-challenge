import { shutdownTelemetry, startTelemetry } from './infrastructure/telemetry';

async function startApplication(): Promise<void> {
  // nestjs-pino is currently CommonJS while NestJS 12 is ESM. Preloading the
  // Nest core graph avoids Bun resolving the same module through require()
  // while its asynchronous ESM evaluation is still in progress.
  await import('@nestjs/core');
  await startTelemetry();

  try {
    const { bootstrap } = await import('./main.js');
    await bootstrap();
  } catch (error) {
    await shutdownTelemetry();
    throw error;
  }
}

startApplication().catch((error: unknown) => {
  console.error('Application failed to start', error);
  process.exitCode = 1;
});
