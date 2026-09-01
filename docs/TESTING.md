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

Os cenários reais da Fase 4 ficam opt-in para que a suíte padrão não apague dados de um
banco de desenvolvimento. Com o PostgreSQL do Compose saudável e a migration aplicada,
execute `RUN_REAL_INTEGRATION_TESTS=true bun test tests/integration/financial-persistence.spec.ts`.
O fixture usa identificadores únicos e não tenta remover lançamentos, respeitando o
trigger append-only do ledger.

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

## Teste manual de HTTP

A coleção OpenCollection para Bruno fica em `tests/http/bruno`. Abra exatamente esse
diretório no Bruno 3+ e selecione o ambiente `local`. Os arquivos da coleção são
versionados e fazem parte da entrega de cada rota, enquanto valores secretos permanecem
fora do Git.

Na Fase 1, os cenários manuais cobrem:

- liveness e readiness;
- rejeição de query inválida com o envelope uniforme de erro;
- normalização de rota inexistente;
- publicação do OpenAPI e presença das rotas de health.

Esses cenários auxiliam a exploração manual, mas não substituem os testes automatizados
nem as provas contra PostgreSQL e LocalStack reais.
