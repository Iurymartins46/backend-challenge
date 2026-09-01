import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpStatus,
  InternalServerErrorException,
  Param,
  Post,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ERROR_CATALOG, ErrorCode } from '../../common/http/error-codes';
import { ErrorResponseDto } from '../../common/http/error.dto';
import {
  GetWagerTransactionUseCase,
  ProcessWagerTransactionUseCase,
  type WagerTransactionSubmissionView,
} from './application';
import { WagerTransactionStatus } from './domain/wager-transaction';
import {
  createWagerTransactionSchema,
  CreateWagerTransactionDto,
  providerTransactionParamsSchema,
  ProviderTransactionParamsDto,
  WagerTransactionDetailsDto,
  WagerTransactionIdParamsDto,
  WagerTransactionRejectedResponseDto,
  WagerTransactionSubmissionDto,
  wagerTransactionIdParamsSchema,
} from './presentation/wagering.dto';

@ApiTags('wagering')
@Controller()
export class WageringController {
  constructor(
    private readonly processWagerTransactionUseCase: ProcessWagerTransactionUseCase,
    private readonly getWagerTransactionUseCase: GetWagerTransactionUseCase,
  ) {}

  @Post('wagering/transactions')
  @ApiOperation({ summary: 'Process a wager transaction' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Stable key for the provider business operation.',
    example: 'provider-a:transaction-123',
  })
  @ApiCreatedResponse({
    type: WagerTransactionSubmissionDto,
    description: 'The transaction was processed for the first time.',
  })
  @ApiOkResponse({
    type: WagerTransactionSubmissionDto,
    description: 'The request is an idempotent replay of a processed transaction.',
  })
  @ApiAcceptedResponse({
    type: WagerTransactionSubmissionDto,
    description: 'The transaction was accepted and remains pending.',
  })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiUnprocessableEntityResponse({ type: WagerTransactionRejectedResponseDto })
  @ApiServiceUnavailableResponse({ type: ErrorResponseDto })
  async create(
    @Body({ schema: createWagerTransactionSchema }) body: CreateWagerTransactionDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WagerTransactionSubmissionDto> {
    const idempotencyKey = headerValue(request.headers['idempotency-key']);
    const correlationId = headerValue(request.headers['x-correlation-id']);
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (normalizedIdempotencyKey === undefined || normalizedIdempotencyKey.length === 0) {
      throw new BadRequestException({
        message: 'The Idempotency-Key header is required.',
        errors: [
          {
            code: ErrorCode.RequestIdempotencyKeyRequired,
            detail: 'Send a non-empty Idempotency-Key header.',
            field: 'Idempotency-Key',
          },
        ],
      });
    }

    if (normalizedIdempotencyKey.length > 255) {
      throw new BadRequestException({
        message: 'The Idempotency-Key header is too long.',
        errors: [
          {
            code: ErrorCode.RequestInvalid,
            detail: 'The Idempotency-Key header must contain at most 255 characters.',
            field: 'Idempotency-Key',
          },
        ],
      });
    }

    const result = await this.processWagerTransactionUseCase.execute({
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      idempotencyKey: normalizedIdempotencyKey,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: body.money,
      referenceExternalTransactionId: body.referenceExternalTransactionId,
      correlationId,
    });

    if (result.status === WagerTransactionStatus.Rejected) {
      throwRejectedTransaction(result);
    }

    if (result.status === WagerTransactionStatus.Failed) {
      throw new InternalServerErrorException({
        message: 'The transaction failed permanently.',
        errors: [
          {
            code: result.failureCode ?? ErrorCode.InfrastructureInternalError,
            detail: 'The transaction could not be completed.',
          },
        ],
      });
    }

    reply.status(
      result.idempotentReplay
        ? HttpStatus.OK
        : result.status === WagerTransactionStatus.Processed
          ? HttpStatus.CREATED
          : HttpStatus.ACCEPTED,
    );
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  @ApiOperation({ summary: 'Get a wagering transaction by internal id' })
  @ApiParam({ name: 'transactionId', format: 'uuid' })
  @ApiOkResponse({ type: WagerTransactionDetailsDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async getById(
    @Param({ schema: wagerTransactionIdParamsSchema }) params: WagerTransactionIdParamsDto,
  ): Promise<WagerTransactionDetailsDto> {
    return this.getWagerTransactionUseCase.byId(params.transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @ApiOperation({ summary: 'Get a wagering transaction by provider external id' })
  @ApiParam({ name: 'providerId' })
  @ApiParam({ name: 'externalTransactionId' })
  @ApiOkResponse({ type: WagerTransactionDetailsDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async getByProviderAndExternalId(
    @Param({ schema: providerTransactionParamsSchema }) params: ProviderTransactionParamsDto,
  ): Promise<WagerTransactionDetailsDto> {
    return this.getWagerTransactionUseCase.byProviderAndExternalId(
      params.providerId,
      params.externalTransactionId,
    );
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function throwRejectedTransaction(result: WagerTransactionSubmissionView): never {
  const failureCode = result.failureCode ?? ErrorCode.InfrastructureInternalError;
  const description = ERROR_CATALOG[failureCode]?.meaning ?? 'The transaction was rejected.';
  throw new UnprocessableEntityException({
    message: 'The transaction was rejected.',
    transactionId: result.transactionId,
    idempotentReplay: result.idempotentReplay,
    errors: [{ code: failureCode, detail: description }],
  });
}
