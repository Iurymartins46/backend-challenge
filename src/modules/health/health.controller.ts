import { Controller, Get, HttpStatus, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
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
  @ApiServiceUnavailableResponse({ type: HealthResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  async ready(
    @Query({ schema: readyQuerySchema }) _query: ReadyQuery,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<HealthResponseDto> {
    const result = await this.healthService.ready();
    if (result.status === 'error') {
      reply.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return result;
  }
}
