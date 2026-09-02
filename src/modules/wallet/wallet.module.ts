import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infrastructure/database/database.module';
import {
  FINANCIAL_UNIT_OF_WORK,
  type FinancialUnitOfWorkPort,
} from '../wagering/application/ports';
import { RandomIdGenerator, SystemClock, type Clock, type IdGenerator } from '../wagering/domain';
import {
  CreateWalletUseCase,
  GetWalletUseCase,
  ListWalletLedgerUseCase,
  ReconcileWalletUseCase,
  WalletReconciliationMetrics,
} from './application';
import { WalletController } from './wallet.controller';

const WALLET_ID_GENERATOR = Symbol('WALLET_ID_GENERATOR');
const WALLET_CLOCK = Symbol('WALLET_CLOCK');

@Module({
  imports: [DatabaseModule],
  controllers: [WalletController],
  providers: [
    {
      provide: WALLET_ID_GENERATOR,
      useFactory: (): IdGenerator => new RandomIdGenerator(),
    },
    {
      provide: WALLET_CLOCK,
      useFactory: (): Clock => new SystemClock(),
    },
    {
      provide: CreateWalletUseCase,
      inject: [FINANCIAL_UNIT_OF_WORK, WALLET_ID_GENERATOR, WALLET_CLOCK],
      useFactory: (unitOfWork: FinancialUnitOfWorkPort, idGenerator: IdGenerator, clock: Clock) =>
        new CreateWalletUseCase(unitOfWork, idGenerator, clock),
    },
    {
      provide: GetWalletUseCase,
      inject: [FINANCIAL_UNIT_OF_WORK],
      useFactory: (unitOfWork: FinancialUnitOfWorkPort) => new GetWalletUseCase(unitOfWork),
    },
    {
      provide: ListWalletLedgerUseCase,
      inject: [FINANCIAL_UNIT_OF_WORK],
      useFactory: (unitOfWork: FinancialUnitOfWorkPort) => new ListWalletLedgerUseCase(unitOfWork),
    },
    {
      provide: WalletReconciliationMetrics,
      useFactory: (): WalletReconciliationMetrics => new WalletReconciliationMetrics(),
    },
    {
      provide: ReconcileWalletUseCase,
      inject: [FINANCIAL_UNIT_OF_WORK, WalletReconciliationMetrics],
      useFactory: (unitOfWork: FinancialUnitOfWorkPort, metrics: WalletReconciliationMetrics) =>
        new ReconcileWalletUseCase(unitOfWork, metrics),
    },
  ],
})
export class WalletModule {}
