# Estratégia de testes

## Unidade

`bun:test` cobre Money, Wallet, WagerTransaction, ledger, estados, referências, failure
codes, eventos, hash canônico e políticas de retry. Domínio puro não exige NestJS nem
banco.

## Integração

PostgreSQL e LocalStack reais executados por Docker Compose. Cobrir:

- migrations `up/down/up` e constraints via SQL direto;
- atomicidade wallet/transaction/ledger/inbox/outbox;
- redelivery, retry e DLQ;
- publishers e workers concorrentes;
- recuperação após reinício.

## Concorrência distribuída

Um harness sobe pelo menos três processos independentes contra o mesmo banco e filas.
Promises contra mocks não contam como paralelismo real.

Cenários obrigatórios:

1. mesma BET 50 vezes simultâneas produz um débito;
2. duas BETs de 80 sobre saldo 100 terminam em saldo 20;
3. wallets distintas processam em paralelo;
4. três ou mais processos competem;
5. processo morre pós-commit e pré-ack;
6. dois publishers disputam a outbox;
7. REFUND/ROLLBACK chega antes da referência;
8. restart preserva consistência final.

Failpoints são adapters injetáveis habilitados somente em teste. Esperas usam polling
com deadline, não sleeps arbitrários.

## Invariante final

Todo cenário consulta PostgreSQL e prova:

```text
wallet.balance_minor == SUM(CREDIT amount_minor) - SUM(DEBIT amount_minor)
```

Também verifica contagens de transactions, ledger, inbox e outbox para detectar efeitos
duplicados que uma simples comparação de saldo poderia esconder.
