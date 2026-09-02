import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';

import { ErrorCode } from '../../common/http/error-codes';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { ProviderScopes } from '../auth/provider-scopes.decorator';
import {
  CreateWalletUseCase,
  decodeLedgerCursor,
  GetWalletUseCase,
  InvalidLedgerCursorError,
  ListWalletLedgerUseCase,
  ReconcileWalletUseCase,
} from './application';
import {
  createWalletSchema,
  CreateWalletDto,
  walletIdParamsSchema,
  WalletIdParamsDto,
  WalletLedgerQueryDto,
  walletLedgerQuerySchema,
  WalletLedgerResponseDto,
  WalletReconciliationResponseDto,
  WalletResponseDto,
} from './presentation/wallet.dto';

@ApiTags('wallets')
@ApiBearerAuth('provider-oidc')
@Controller('wallets')
export class WalletController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly getWalletUseCase: GetWalletUseCase,
    private readonly listWalletLedgerUseCase: ListWalletLedgerUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
  ) {}

  @Post()
  @ProviderScopes('wallet:write')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a wallet' })
  @ApiCreatedResponse({ type: WalletResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  async create(
    @Body({ schema: createWalletSchema }) body: CreateWalletDto,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<WalletResponseDto> {
    return this.createWalletUseCase.execute({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
      correlationId,
    });
  }

  @Get(':walletId')
  @ProviderScopes('wallet:read')
  @ApiOperation({ summary: 'Get a wallet' })
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiOkResponse({ type: WalletResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async get(
    @Param({ schema: walletIdParamsSchema }) params: WalletIdParamsDto,
  ): Promise<WalletResponseDto> {
    return this.getWalletUseCase.execute(params.walletId);
  }

  @Get(':walletId/ledger')
  @ProviderScopes('wallet:read')
  @ApiOperation({ summary: 'List a wallet ledger page' })
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque versioned Base64URL cursor.' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: 'integer',
    minimum: 1,
    maximum: 100,
    example: 50,
  })
  @ApiOkResponse({ type: WalletLedgerResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async ledger(
    @Param({ schema: walletIdParamsSchema }) params: WalletIdParamsDto,
    @Query({ schema: walletLedgerQuerySchema }) query: WalletLedgerQueryDto,
  ): Promise<WalletLedgerResponseDto> {
    let after;
    if (query.cursor !== undefined) {
      try {
        after = decodeLedgerCursor(query.cursor);
      } catch (error: unknown) {
        if (!(error instanceof InvalidLedgerCursorError)) {
          throw error;
        }

        throw new BadRequestException({
          message: 'The ledger cursor is invalid.',
          errors: [
            {
              code: ErrorCode.RequestInvalid,
              detail: 'The ledger cursor is invalid.',
              field: 'cursor',
            },
          ],
        });
      }
    }

    return this.listWalletLedgerUseCase.execute({
      walletId: params.walletId,
      after,
      limit: query.limit ?? 50,
    });
  }

  @Post(':walletId/reconciliation')
  @ProviderScopes('wallet:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reconcile the stored wallet balance with its immutable ledger',
    description:
      'Reads the wallet and signed ledger aggregate in one REPEATABLE READ snapshot. Divergences are reported but never corrected automatically.',
  })
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiOkResponse({ type: WalletReconciliationResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiServiceUnavailableResponse({
    type: ErrorResponseDto,
    description: 'Transient PostgreSQL unavailability. Retry according to the Retry-After header.',
  })
  async reconcile(
    @Param({ schema: walletIdParamsSchema }) params: WalletIdParamsDto,
  ): Promise<WalletReconciliationResponseDto> {
    return this.reconcileWalletUseCase.execute(params.walletId);
  }
}
