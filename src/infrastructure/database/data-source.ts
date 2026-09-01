import 'reflect-metadata';

import { DataSource } from 'typeorm';

import { entities } from './entities/registry';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering';
const lockTimeoutMs = process.env.DATABASE_LOCK_TIMEOUT_MS ?? '5000';
const statementTimeoutMs = process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? '30000';

const dataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  entities,
  migrations: ['src/infrastructure/database/migrations/*.{ts,js}'],
  synchronize: false,
  extra: {
    options: `-c lock_timeout=${lockTimeoutMs} -c statement_timeout=${statementTimeoutMs}`,
  },
});

export default dataSource;
