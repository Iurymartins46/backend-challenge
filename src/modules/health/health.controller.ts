import { Controller, Get, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { ErrorResponseDto } from '../../common/http/error.dto';
import { Public } from '../../common/http/public.decorator';
import { HealthResponseDto } from './health.dto';
import { HealthService } from './health.service';

const readyQuerySchema = z.object({
  verbose: z.enum(['true', 'false']).optional(),
});

type ReadyQuery = z.infer<typeof readyQuerySchema>;

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  @Public()
  @ApiOperation({ summary: 'Process liveness' })
  @ApiOkResponse({ type: HealthResponseDto })
  live(): HealthResponseDto {
    return this.healthService.live();
  }

  @Get('ready')
  @Public()
  @ApiOperation({ summary: 'Application readiness' })
  @ApiOkResponse({ type: HealthResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  ready(@Query({ schema: readyQuerySchema }) _query: ReadyQuery): HealthResponseDto {
    return this.healthService.ready();
  }
}
