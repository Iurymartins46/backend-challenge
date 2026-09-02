# Mensageria, inbox e outbox

## Filas

- `wager-transactions.fifo`: comandos de entrada;
- `wager-transactions-dlq.fifo`: DLQ dos comandos;
- `wager-events.fifo`: eventos publicados pela outbox.

`MessageGroupId = walletId` preserva ordem por wallet e paralelismo entre wallets.
Deduplication id do broker é otimização; PostgreSQL continua sendo a garantia.

## Consumidor

- long polling e concorrência limitada pelo pool do banco;
- inbox por `(consumerName, messageId)`;
- envelope de comando versionado com `messageId` de aplicação separado do SQS `MessageId`;
- mesmo caso de uso da API HTTP;
- visibility heartbeat durante processamento;
- `DeleteMessage` somente após commit;
- negócio terminal: commit e ack;
- erro transitório: rollback e redelivery;
- envelope permanentemente inválido: DLQ;
- em SIGTERM: parar polling, drenar e devolver visibility do que não concluir.

O envelope aceito pela Fase 8 tem esta forma:

```json
{
  "messageId": "0192f2a0-345e-7e38-af88-e43f851a819d",
  "messageType": "WagerTransactionCommand",
  "version": 1,
  "correlationId": "provider-correlation-123",
  "causationId": "provider-request-123",
  "occurredAt": "2026-09-01T12:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

O hash da inbox cobre o `data` completo, inclusive `idempotencyKey`, e não metadados de
transporte. Assim, uma redelivery idêntica é replay seguro, enquanto reusar o mesmo
message id com outro comando fica sem ack e segue para a DLQ após o limite de receives.

## Outbox

Eventos são gravados na mesma transação financeira. Publishers:

1. selecionam vencidos com `FOR UPDATE SKIP LOCKED`;
2. registram lease em transação curta;
3. publicam fora da transação;
4. marcam sucesso somente se ainda possuem o lease;
5. agendam backoff em falha;
6. permitem retomada após expiração do lease.

Morte após publicar e antes de marcar pode duplicar. `eventId` permanece igual e deve
ser usado pela inbox do consumidor externo.

O limite operacional de tentativas não envia o evento para descarte: depois do teto, o
contador fica saturado e o próximo retry usa o atraso máximo configurado. Assim, uma
indisponibilidade prolongada não remove um evento confirmado da outbox. A quantidade de
pendências e o lag do evento mais antigo são medidos pelo publisher.

## Referências fora de ordem

Transações dependentes ausentes ficam `PENDING_REFERENCE`. O worker seleciona apenas
agendas vencidas usando `FOR UPDATE SKIP LOCKED`, incrementa `reference_attempts` e
persiste `reference_locked_by`/`reference_locked_until` no claim curto. Ao resolver,
usa o mesmo lock da wallet e o mesmo Unit of Work do processamento HTTP/SQS.

A policy padrão usa 2 s exponencial com jitter de 20%, teto de 5 min, 10 tentativas e
TTL de 30 min. A agenda, o contador e o lease sobrevivem a restart; um claim abandonado
volta a ficar disponível ao expirar. No limite, o worker faz uma última revalidação sob
o lock da wallet. Se a referência continuar ausente, a transação fica
`REJECTED/error.wager.reference_not_found`, sem ledger, e a outbox grava
`WagerTransactionRejected` na mesma transação.

## Eventos mínimos

- `WagerTransactionProcessed`;
- `WagerTransactionRejected`;
- `WalletBalanceChanged` somente se o saldo mudar;
- `WagerTransactionPendingReference` na primeira entrada em espera.

## Códigos de falha do domínio

As transições rejeitadas carregam códigos estáveis e não dependem do texto da
mensagem: `error.wager.insufficient_funds` para BET sem saldo,
`error.wager.reversal_negative_balance` para reversão que deixaria saldo negativo,
`error.wager.reference_not_found` para referência ausente,
`error.wager.reference_amount_mismatch` para valor divergente,
`error.wager.reference_invalid_kind` para tipo incompatível,
`error.wager.reference_context_mismatch` para provider/player/wallet/rodada/jogo/moeda
divergentes e `error.wager.reversal_already_processed` para duplicidade de reversão.
Falhas de infraestrutura permanentes usam `error.infrastructure.internal_error` ou
`error.infrastructure.dependency_unavailable` conforme a classificação do adapter.
