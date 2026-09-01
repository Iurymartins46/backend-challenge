import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { entities } from '../../src/infrastructure/database/entities/registry';

const runRealIntegration = process.env.RUN_REAL_INTEGRATION_TESTS === 'true';
const integration = runRealIntegration ? describe : describe.skip;
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering';

let adminDataSource: DataSource | undefined;
let migrationDataSource: DataSource | undefined;
let isolatedDatabaseName: string | undefined;

function isolatedDatabaseUrl(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function createIsolatedDatabaseName(): string {
  return `wagering_migration_${randomUUID().replaceAll('-', '')}`;
}

async function destroyDataSource(dataSource: DataSource | undefined): Promise<void> {
  if (dataSource?.isInitialized) {
    await dataSource.destroy();
  }
}

integration('financial schema migrations', () => {
  beforeAll(async () => {
    isolatedDatabaseName = createIsolatedDatabaseName();
    adminDataSource = new DataSource({ type: 'postgres', url: databaseUrl });
    await adminDataSource.initialize();
    await adminDataSource.query(`CREATE DATABASE "${isolatedDatabaseName}"`);

    migrationDataSource = new DataSource({
      type: 'postgres',
      url: isolatedDatabaseUrl(isolatedDatabaseName),
      entities,
      migrations: ['src/infrastructure/database/migrations/*.{ts,js}'],
      synchronize: false,
    });
    await migrationDataSource.initialize();
  });

  afterAll(async () => {
    await destroyDataSource(migrationDataSource);

    if (adminDataSource?.isInitialized && isolatedDatabaseName !== undefined) {
      await adminDataSource.query(`DROP DATABASE IF EXISTS "${isolatedDatabaseName}" WITH (FORCE)`);
    }

    await destroyDataSource(adminDataSource);
  });

  test('applies, reverts and reapplies the financial schema on an empty database', async () => {
    if (migrationDataSource === undefined) {
      throw new Error('The isolated migration database was not initialized.');
    }

    expect(await migrationDataSource.runMigrations()).toHaveLength(1);
    expect(await tableNames(migrationDataSource)).toEqual(expectedTableNames);

    await migrationDataSource.undoLastMigration();
    expect(await tableNames(migrationDataSource)).toEqual([]);

    expect(await migrationDataSource.runMigrations()).toHaveLength(1);
    expect(await tableNames(migrationDataSource)).toEqual(expectedTableNames);
  });
});

const expectedTableNames = [
  'inbox_messages',
  'outbox_messages',
  'wager_transactions',
  'wallet_ledger_entries',
  'wallets',
];

async function tableNames(dataSource: DataSource): Promise<string[]> {
  const rows = await dataSource.query<Array<{ table_name: string }>>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
       AND table_name <> 'migrations'
     ORDER BY table_name`,
  );
  return rows.map((row) => row.table_name);
}

if (!runRealIntegration) {
  test('real migration round-trip is opt-in', () => {
    expect(true).toBe(true);
  });
}
