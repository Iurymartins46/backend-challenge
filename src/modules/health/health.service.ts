import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

import type { HealthResponseDto } from './health.dto';

@Injectable()
export class HealthService implements OnApplicationShutdown {
  private shuttingDown = false;

  live(): HealthResponseDto {
    return { status: 'ok', check: 'live' };
  }

  ready(): HealthResponseDto {
    if (this.shuttingDown) {
      throw new Error('Application is shutting down');
    }

    return { status: 'ok', check: 'ready' };
  }

  onApplicationShutdown(): void {
    this.shuttingDown = true;
  }
}
