const migrationDirectory = 'src/infrastructure/database/migrations';
const dataSourcePath = 'src/infrastructure/database/data-source.ts';

async function generateMigration(): Promise<void> {
  const args = Bun.argv.slice(2).filter((argument) => argument !== '--');

  if (args.length > 1) {
    throw new Error('Use: bun run migration:generate [migration-name]');
  }

  const migrationName = args[0]?.trim() || 'schema';

  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(migrationName)) {
    throw new Error(
      'Migration name must start with a letter and contain only letters, digits or dashes.',
    );
  }

  const subprocess = Bun.spawn(
    [
      process.execPath,
      './node_modules/typeorm/cli.js',
      'migration:generate',
      `${migrationDirectory}/${migrationName}`,
      '-d',
      dataSourcePath,
    ],
    {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );

  process.exitCode = await subprocess.exited;
}

generateMigration().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
