import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { StandardSchemaValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../../src/app.module';
import dataSource from '../../src/infrastructure/database/data-source';

const runRealIntegration = process.env.RUN_REAL_INTEGRATION_TESTS === 'true';
const integration = runRealIntegration ? describe : describe.skip;

let app: NestFastifyApplication | undefined;

integration('wagering HTTP API', () => {
  beforeAll(async () => {
    await dataSource.initialize();
    await dataSource.runMigrations();

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  test('creates, replays, rejects conflicting and reads a BET through HTTP', async () => {
    if (app === undefined) {
      throw new Error('The HTTP application was not initialized.');
    }

    const playerId = randomUUID();
    const walletResponse = await app.inject({
      method: 'POST',
      url: '/wallets',
      payload: {
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      },
    });
    expect(walletResponse.statusCode).toBe(201);
    const wallet = walletResponse.json<{ id: string }>();

    const providerId = `http-provider-${randomUUID()}`;
    const externalTransactionId = `http-transaction-${randomUUID()}`;
    const idempotencyKey = `http-key-${randomUUID()}`;
    const payload = {
      providerId,
      externalTransactionId,
      playerId,
      walletId: wallet.id,
      roundId: 'http-round',
      gameId: 'http-game',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };

    const first = await app.inject({
      method: 'POST',
      url: '/wagering/transactions',
      headers: { 'idempotency-key': idempotencyKey },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<{
      transactionId: string;
      balance: { amount: string; currency: string };
      idempotentReplay: boolean;
    }>();
    expect(firstBody.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(firstBody.idempotentReplay).toBe(false);

    const replay = await app.inject({
      method: 'POST',
      url: '/wagering/transactions',
      headers: { 'idempotency-key': idempotencyKey },
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ transactionId: string; idempotentReplay: boolean }>()).toEqual({
      ...firstBody,
      idempotentReplay: true,
    });

    const conflict = await app.inject({
      method: 'POST',
      url: '/wagering/transactions',
      headers: { 'idempotency-key': idempotencyKey },
      payload: { ...payload, money: { amount: '26.00', currency: 'BRL' } },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ errors: Array<{ code: string }> }>().errors).toMatchObject([
      { code: 'error.idempotency.payload_conflict' },
    ]);

    const getById = await app.inject({
      method: 'GET',
      url: `/wagering/transactions/${firstBody.transactionId}`,
    });
    expect(getById.statusCode).toBe(200);
    expect(getById.json<{ transactionId: string; money: { amount: string } }>()).toMatchObject({
      transactionId: firstBody.transactionId,
      money: { amount: '25.00' },
    });

    const getByExternalId = await app.inject({
      method: 'GET',
      url: `/providers/${providerId}/wagering/transactions/${externalTransactionId}`,
    });
    expect(getByExternalId.statusCode).toBe(200);
    expect(getByExternalId.json<{ transactionId: string }>().transactionId).toBe(
      firstBody.transactionId,
    );
  });
});

if (!runRealIntegration) {
  test('real wagering HTTP integration is opt-in', () => {
    expect(true).toBe(true);
  });
}
