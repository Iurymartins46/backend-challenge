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
- mesmo caso de uso da API HTTP;
- visibility heartbeat durante processamento;
- `DeleteMessage` somente após commit;
- negócio terminal: commit e ack;
- erro transitório: rollback e redelivery;
- envelope permanentemente inválido: DLQ;
- em SIGTERM: parar polling, drenar e devolver visibility do que não concluir.

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

## Referências fora de ordem

Transações dependentes ausentes ficam `PENDING_REFERENCE`. O worker usa backoff
exponencial com jitter, teto, limite/TTL, clock injetável e seleção concorrente com
`SKIP LOCKED`. Ao resolver, usa o mesmo lock da wallet e o mesmo Unit of Work.

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
