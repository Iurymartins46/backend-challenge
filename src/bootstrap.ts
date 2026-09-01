import { shutdownTelemetry, startTelemetry } from './infrastructure/telemetry';

async function startApplication(): Promise<void> {
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
