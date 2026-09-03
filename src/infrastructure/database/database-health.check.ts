import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class DatabaseHealthCheck {
  constructor(private readonly dataSource: DataSource) {}

  async check(): Promise<void> {
    if (!this.dataSource.isInitialized) {
      throw new Error('PostgreSQL data source is not initialized.');
    }

    const rows = await this.dataSource.query<readonly { wallets?: unknown }[]>(
      "SELECT to_regclass('public.wallets') AS wallets",
    );
    if (rows[0]?.wallets !== 'wallets') {
      throw new Error('The financial database schema is not ready.');
    }
  }
}
