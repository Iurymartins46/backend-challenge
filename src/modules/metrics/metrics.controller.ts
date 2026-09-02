import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { Public } from '../../common/http/public.decorator';
import { prometheusMetricsRequestHandler } from '../../infrastructure/telemetry';

@ApiTags('observability')
@Controller('metrics')
export class MetricsController {
  @Get()
  @Public()
  @ApiExcludeEndpoint()
  metrics(@Req() request: FastifyRequest, @Res() reply: FastifyReply): void {
    prometheusMetricsRequestHandler(request.raw, reply.raw);
  }
}
