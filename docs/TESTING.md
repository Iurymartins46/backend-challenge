# Estratégia de testes

## Unidade

`bun:test` cobre Money, Wallet, WagerTransaction, ledger, estados, referências, failure
codes, eventos, hash canônico, políticas de retry e OIDC: JWT ausente/inválido/expirado,
issuer/audience/assinatura, provider divergente, scopes, cache, rotação e JWKS
indisponível. Domínio puro não exige NestJS nem
banco.

O overlay real `bun run docker:up:oidc` sobe Keycloak e importa clients de serviço de
demo. A prova manual obtém token por client credentials, chama uma rota protegida, repete
com `provider-b` contra `provider-a` e espera `403/error.auth.provider_mismatch`. O
Keycloak não é pré-requisito das suítes financeiras PostgreSQL/LocalStack.

## Integração

PostgreSQL e LocalStack reais executados por Docker Compose. Cobrir:

- migrations `up/down/up` e constraints via SQL direto;
- atomicidade wallet/transaction/ledger/inbox/outbox;
- redelivery, retry e DLQ;
- publishers e workers concorrentes;
- recuperação após reinício.

Os cenários reais ficam opt-in para que a suíte padrão não toque no banco de
desenvolvimento. `migrations-round-trip.spec.ts` cria um banco PostgreSQL efêmero, prova
`up/down/up` em schema vazio e o remove ao final. `financial-persistence.spec.ts` usa
identificadores únicos e não tenta remover lançamentos, respeitando o trigger append-only
do ledger. `http-wagering-api.spec.ts` exerce o contrato Nest/Fastify com PostgreSQL
real para criação de wallet, BET, replay e as duas leituras de transação. Com
o PostgreSQL do Compose saudável, execute
`RUN_REAL_INTEGRATION_TESTS=true bun run test:integration`.

`sqs-inbox.spec.ts` prova contra PostgreSQL e LocalStack reais:
envelope público estrito, inbox atômica, redelivery idempotente, divergência de message
id, ack somente depois do commit e gauge obtida da DLQ após redrive real. Execute-a isoladamente com
`RUN_REAL_INTEGRATION_TESTS=true bun test tests/integration/sqs-inbox.spec.ts`.

`outbox-publisher.spec.ts` prova contra PostgreSQL e LocalStack:
claims concorrentes, visibilidade somente após commit, retry após indisponibilidade do
SQS e recuperação de lease depois de publicar antes da marcação. Execute-a isoladamente
com `RUN_REAL_INTEGRATION_TESTS=true bun test tests/integration/outbox-publisher.spec.ts`.

`pending-reference-worker.spec.ts` prova contra PostgreSQL:
REFUND/ROLLBACK antes da referência, três workers concorrentes, agenda preservada no
restart lógico e TTL auditável. O clock fake avança a agenda sem sleeps. Execute-a com
`RUN_REAL_INTEGRATION_TESTS=true bun test tests/integration/pending-reference-worker.spec.ts`.

`reconciliation.spec.ts` prova contra PostgreSQL: wallet sem
lançamentos, opening e operações múltiplas, uma escrita confirmada entre as leituras do
snapshot e uma divergência injetada por fixture SQL sem ajuste automático. Execute-a com
`RUN_REAL_INTEGRATION_TESTS=true bun test tests/integration/reconciliation.spec.ts`.

## Concorrência distribuída

`bun run test:concurrency` executa duas vezes o harness distribuído, sempre com recursos
novos. Em cada repetição ele cria um banco PostgreSQL efêmero com migrations aplicadas,
três filas FIFO exclusivas (com DLQ de comandos) e sobe três processos NestJS
independentes contra esses mesmos recursos. O teardown encerra os processos, remove as
filas e elimina o banco; banco de desenvolvimento e filas padrão não são reutilizados.
PostgreSQL e LocalStack do Compose devem estar saudáveis antes do comando. Para diagnóstico
local de uma única passagem, use `bun run test:concurrency:once`.

O workflow de CI executa a integração real e também `bun run test:concurrency`, portanto
as duas rodadas e as três instâncias fazem parte da validação de cada push/PR para
`main`.

Promises contra mocks não contam como paralelismo real. As corridas usam uma barreira de
início e os resultados usam polling com deadline. Em timeout, o harness imprime os
`correlationId`s e os últimos logs de cada processo. O failpoint de crash só aceita
`NODE_ENV=test` com o valor exato `terminate-after-commit-before-ack`; ele envia `SIGKILL`
depois do commit do comando e antes de `DeleteMessage`.

Cenários obrigatórios:

1. mesma BET 50 vezes simultâneas produz um débito;
2. duas BETs de 80 sobre saldo 100 terminam em saldo 20;
3. wallets distintas processam em paralelo;
4. três ou mais processos competem;
5. processo morre pós-commit e pré-ack;
6. dois publishers disputam a outbox;
7. REFUND/ROLLBACK chega antes da referência;
8. restart preserva consistência final.

Além dos oito cenários, o banco isolado executa as migrations e tenta, por SQL direto,
um saldo negativo e a mutação do ledger append-only.

Failpoints são adapters injetáveis habilitados somente em teste. Esperas usam polling
com deadline, não sleeps arbitrários.

## Teste de carga opcional

`bun run test:load` é um experimento separado da suíte de correção. Ele usa PostgreSQL
e LocalStack reais, banco e filas temporários, três processos NestJS e dois cenários
HTTP: uma hot wallet e muitas wallets. Cada cenário tem warm-up, janela de medição e
cooldown, e o relatório registra throughput, p50/p95/p99, erros, conflitos de lock,
backlog/lag da outbox, ambiente e limitações. A igualdade wallet/ledger é verificada ao
final; não existe meta de RPS nem relaxamento de consistência. O procedimento completo
está em [docs/LOAD_TEST.md](LOAD_TEST.md).

## Invariante final

Todo cenário consulta PostgreSQL e prova:

```text
wallet.balance_minor == SUM(CREDIT amount_minor) - SUM(DEBIT amount_minor)
```

Também verifica contagens de transactions, ledger, inbox e outbox para detectar efeitos
duplicados que uma simples comparação de saldo poderia esconder.

## Teste manual de HTTP

A coleção OpenCollection para Bruno fica em `tests/http/bruno`. Abra exatamente esse
diretório no Bruno 3+ e selecione `local` para `AUTH_MODE=none`, ou `oidc` após iniciar
`bun run docker:up:oidc`. No ambiente OIDC, cadastre `oidcClientSecret` como secret local,
execute primeiro `OIDC/Obter token client credentials` e depois as rotas protegidas; health
e métricas não usam token. Os arquivos da coleção são
versionados e fazem parte da entrega de cada rota, enquanto valores secretos permanecem
fora do Git.

Os cenários manuais cobrem:

- liveness e readiness;
- rejeição de query inválida com o envelope uniforme de erro;
- normalização de rota inexistente;
- publicação do OpenAPI e presença das rotas de health.

Esses cenários auxiliam a exploração manual, mas não substituem os testes automatizados
nem as provas contra PostgreSQL e LocalStack reais.
