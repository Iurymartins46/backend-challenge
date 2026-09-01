import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infrastructure/database/database.module';
import { GetWagerTransactionUseCase, ProcessWagerTransactionUseCase } from './application';
import { FINANCIAL_UNIT_OF_WORK, type FinancialUnitOfWorkPort } from './application/ports';
import { RandomIdGenerator, SystemClock, type Clock, type IdGenerator } from './domain';
import { WageringController } from './wagering.controller';

const WAGER_ID_GENERATOR = Symbol('WAGER_ID_GENERATOR');
const WAGER_CLOCK = Symbol('WAGER_CLOCK');

@Module({
  imports: [DatabaseModule],
  controllers: [WageringController],
  providers: [
    {
      provide: WAGER_ID_GENERATOR,
      useFactory: (): IdGenerator => new RandomIdGenerator(),
    },
    {
      provide: WAGER_CLOCK,
      useFactory: (): Clock => new SystemClock(),
    },
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [FINANCIAL_UNIT_OF_WORK, WAGER_ID_GENERATOR, WAGER_CLOCK],
      useFactory: (unitOfWork: FinancialUnitOfWorkPort, idGenerator: IdGenerator, clock: Clock) =>
        new ProcessWagerTransactionUseCase(unitOfWork, idGenerator, clock),
    },
    {
      provide: GetWagerTransactionUseCase,
      inject: [FINANCIAL_UNIT_OF_WORK],
      useFactory: (unitOfWork: FinancialUnitOfWorkPort) =>
        new GetWagerTransactionUseCase(unitOfWork),
    },
  ],
})
export class WageringModule {}
