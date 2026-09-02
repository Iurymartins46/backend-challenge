# Banco de dados e constraints

## Tabelas principais

### `wallets`

- UUID, player, moeda, saldo em centavos, versão e timestamps;
- unique `(player_id, currency)`;
- `CHECK (balance_minor >= 0)` e `CHECK (version >= 1)`;
- chave candidata composta para FKs de contexto.

### `wager_transactions`

- provider, external transaction, idempotency key e payload hash;
- wallet, player, rodada, jogo, kind, status, valor e moeda;
- referência externa e FK autorreferente resolvida;
- failure code, processed at, agenda, contador de tentativas e claim/lease da referência;
- snapshot do saldo e versão para replay;
- unique `(provider_id, external_transaction_id)`;
- unique `(provider_id, idempotency_key)`;
- índice parcial de `PENDING_REFERENCE`;
- unique parcial `(reference_transaction_id, kind)` para reversões processadas.

### `wallet_ledger_entries`

- uma entrada por wallet/transação;
- amount positivo e balances anterior/posterior não negativos;
- `CHECK` da aritmética conforme `DEBIT` ou `CREDIT`;
- trigger que rejeita `UPDATE` e `DELETE`;
- FKs compostas preservam wallet, transação e moeda.

### `inbox_messages`

- PK `(consumer_name, message_id)`;
- payload hash, received at e processed at;
- mesmo id/hash é replay; mesmo id com hash diferente é erro permanente.

### `outbox_messages`

- envelope JSONB, type, aggregate e occurred at;
- attempts, next attempt, published at, locked by e locked until;
- event id único e índice parcial dos pendentes.

## Transações

O `FinancialUnitOfWork` cria repositories presos ao `EntityManager` transacional. Wallet,
transaction, ledger, inbox e outbox confirmam ou sofrem rollback juntos.

Na implementação TypeORM, `FinancialUnitOfWork.transaction()` cria um UoW novo a partir do
manager entregue pelo callback transacional. Os adapters não resolvem o manager global.
Os timeouts de sessão são configurados por `DATABASE_LOCK_TIMEOUT_MS` (padrão `5000`) e
`DATABASE_STATEMENT_TIMEOUT_MS` (padrão `30000`) via opções do driver PostgreSQL.

As colunas monetárias `balance_minor`, `amount_minor`, `balance_before_minor`,
`balance_after_minor` e `result_balance_minor` são `BIGINT` e ficam tipadas como `string`
nas entidades TypeORM. Os mappers usam `BigInt` diretamente e reidratam `Money` sem
passar por `number`.

O lock pessimista é sempre adquirido por wallet e em ordem consistente. Seletores de
workers usam `FOR UPDATE SKIP LOCKED`, sem lock global. O worker de referências atualiza
`reference_attempts`, `reference_locked_by` e `reference_locked_until` no mesmo claim
curto; a agenda continua em `next_reference_attempt_at`.

## Migrations

Migrations são versionadas e reversíveis. A suíte executa `up`, valida constraints,
executa `down` e repete `up` em banco limpo. Constraints também são exercitadas por SQL
direto para provar que as invariantes não dependem apenas do código.
