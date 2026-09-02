import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class DatabaseHealthCheck {
  constructor(private readonly dataSource: DataSource) {}

  async check(): Promise<void> {
    if (!this.dataSource.isInitialized) {
      throw new Error('PostgreSQL data source is not initialized.');
    }

    await this.dataSource.query('SELECT 1');
  }
}
