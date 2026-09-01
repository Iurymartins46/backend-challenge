import 'reflect-metadata';

import { DataSource } from 'typeorm';

const dataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering',
  entities: [],
  migrations: ['src/infrastructure/database/migrations/*.{ts,js}'],
  synchronize: false,
});

export default dataSource;
