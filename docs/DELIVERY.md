# Registro final da entrega

Este documento fecha as Fases 1–14 e a subfase obrigatória 12A. Ele reúne o diagrama
final, a rastreabilidade das garantias, o roteiro de demonstração e os limites que
continuam deliberados. `docs/CHALLENGE.md` permanece como o enunciado original.

## Como validar do zero

```bash
bun install --frozen-lockfile
cp .env.example .env
bun run docker:up:infra
bun run migration:run
bun run docker:up:build
bun run smoke:http
```

Verificações locais sem dependências reais:

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
bun run build
bun run smoke:packages
bun run security:scan
```

Verificações reais, opt-in e isoladas:

```bash
RUN_REAL_INTEGRATION_TESTS=true bun run test:integration
bun run test:concurrency
```

`test:integration` cria bancos temporários para seus cenários e
`test:concurrency` cria banco, filas e três processos próprios. Ambos exigem PostgreSQL
e LocalStack saudáveis, mas não devem usar o banco de desenvolvimento como fixture de
resultado.

## Diagrama final

```text
                         ┌────────────────────────────┐
HTTP ───────────────────>│ Controllers + DTOs/Swagger │
                         └──────────────┬─────────────┘
                                        │
SQS commands ──> inbox ─────────────────┤
                                        v
                         ┌────────────────────────────┐
                         │ ProcessWagerTransaction    │
                         │ valida + lock por wallet   │
                         └──────────────┬─────────────┘
                                        │ uma UoW SQL
                                        v
                         ┌────────────────────────────┐
                         │ PostgreSQL                  │
                         │ wallet + transaction       │
                         │ ledger + inbox + outbox    │
                         └──────────────┬─────────────┘
                                        │ commit primeiro
                         ┌──────────────v─────────────┐
                         │ Outbox publisher(s)         │──> wager-events.fifo
                         │ claim/lease + at-least-once │
                         └────────────────────────────┘

PENDING_REFERENCE ──> worker(s) ──> mesmo use case + mesmo lock da wallet

HTTP/SQS/workers ──> logs JSON, métricas e traces não bloqueantes
                         └──> /metrics; backends visuais 12B não incluídos
```

O PostgreSQL arbitra idempotência, locks, constraints e a atomicidade. SQS FIFO ordena
e reduz duplicatas, mas não é a garantia final. `DeleteMessage` ocorre somente depois
do commit.

## Matriz requisito → implementação → evidência

| Requisito                                 | Implementação principal                                                | Evidência verificável                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Dinheiro exato e sem IEEE-754             | `src/modules/wagering/domain/money.ts`, `BIGINT` no TypeORM            | `tests/unit/money/money.spec.ts`; round-trip e limite em `tests/integration/financial-persistence.spec.ts`                                  |
| Wallet não negativa e ledger consistente  | lock `FOR UPDATE`, `Wallet`, ledger append-only e checks SQL           | `tests/integration/financial-persistence.spec.ts`; auditoria wallet = ledger no harness distribuído                                         |
| Abertura atômica                          | `CreateWalletUseCase` + UoW com `OPENING`/ledger/outbox                | `tests/unit/wallet/wallet.use-cases.spec.ts`; integração de rollback e abertura                                                             |
| BET/WIN/LOSS/REFUND/ROLLBACK              | `ProcessWagerTransactionUseCase` e regras puras                        | `tests/unit/domain/wagering-domain.spec.ts` e `tests/unit/wagering/process-wager-transaction.use-case.spec.ts`; integração HTTP/referências |
| Concorrência por wallet e três instâncias | lock pessimista por `walletId`; nenhum lock global                     | oito cenários em `tests/concurrency/distributed-wagering.spec.ts`, com duas BETs de 80, 50 duplicatas e wallets paralelas                   |
| Idempotência persistente                  | índice único, hash SHA-256 canônico e snapshot de resultado            | `tests/integration/financial-persistence.spec.ts`, `http-wagering-api.spec.ts` e replay após restart no harness                             |
| Referência fora de ordem                  | `PENDING_REFERENCE`, claim/lease, backoff e TTL                        | `tests/integration/pending-reference-worker.spec.ts`, `phase7-references.spec.ts` e cenário distribuído de REFUND                           |
| Inbox, redelivery e DLQ                   | chave `(consumer_name, message_id)`, ack pós-commit e redrive policy   | `tests/integration/sqs-inbox.spec.ts`; filas e `maxReceiveCount=5` em Compose/harness                                                       |
| Transactional outbox                      | outbox na UoW, publisher com `SKIP LOCKED`/lease, retry                | `tests/integration/outbox-publisher.spec.ts`; publisher concorrente e crash no harness                                                      |
| Reconciliação somente leitura             | snapshot `REPEATABLE READ`, diferença assinada, métrica de divergência | `tests/unit/wallet/reconcile-wallet.use-case.spec.ts` e `tests/integration/reconciliation.spec.ts`                                          |
| Observabilidade operacional               | logs JSON, correlation ids, métricas de negócio, health separado       | `tests/unit/telemetry.spec.ts`, `health.spec.ts`, `exception-filter.spec.ts` e endpoint `/metrics`                                          |
| Contrato HTTP                             | DTOs/schema Zod, Swagger, envelope uniforme de erro                    | `docs/API_AND_ERRORS.md`, coleção Bruno e `tests/http/curl/smoke.sh`                                                                        |
| Schema como última defesa                 | FKs, uniques, checks e trigger append-only                             | SQL direto em `financial-persistence.spec.ts` e no cenário de constraints distribuído                                                       |

## Roteiro de demonstração

1. Mostrar o diagrama e explicar que HTTP, SQS e worker convergem no mesmo caso de uso.
2. Executar `bun run smoke:http` e mostrar o `201` inicial, o `200` do replay, a leitura
   pelos dois identificadores, o ledger e a reconciliação `consistent: true`.
3. Explicar `Money` como string na borda, `bigint` em centavos no domínio e `BIGINT` no
   PostgreSQL; apontar a constraint de saldo e o trigger imutável.
4. Executar `bun run test:concurrency`. Destacar a corrida de 50 BETs, o cenário 80/80,
   as wallets distintas, três processos, o crash pós-commit/pré-ack, dois publishers,
   REFUND fora de ordem e restart.
5. Na apresentação, abrir os logs de uma falha do harness e apontar os
   `correlationId`s e os últimos logs por processo, sem expor valores financeiros.
6. Mostrar `POST /wallets/:walletId/reconciliation` e explicar que divergência é
   sinalizada por resposta, log e métrica, sem autocorreção.
7. Declarar explicitamente que Grafana/Tempo/Loki/Collector não fazem parte desta
   entrega: a subfase 12B ficou pendente; o endpoint `/metrics` e os sinais da 12A são
   os artefatos disponíveis.

## Registro de versões e execução

O registro abaixo deve refletir a última execução real da suíte e não uma estimativa.

| Item                     | Valor registrado                                                          |
| ------------------------ | ------------------------------------------------------------------------- |
| Data da validação        | 2026-09-02                                                                |
| Runtime/package manager  | Bun 1.4.0 (`.bun-version`, `package.json`)                                |
| Banco                    | PostgreSQL 18.6-alpine                                                    |
| Mensageria               | LocalStack Community 4.14.0, SQS                                          |
| Container tooling        | Docker 29.7.2; Docker Compose v5.5.0                                      |
| Máquina                  | Linux 7.0.0-30-generic, x86_64, 22 CPUs, 14 GiB RAM                       |
| Suíte unitária           | 63 testes, 790 ms                                                         |
| Suíte de integração real | 34 testes, 4.22 s, PostgreSQL/LocalStack reais                            |
| Suíte distribuída real   | 8 testes, 21 assertions, 20.778 s                                         |
| Smoke HTTP real          | `bun run smoke:http` passou contra API containerizada em `localhost:3000` |

O caminho padrão `bun run docker:up:build` encontrou o Buildx ausente no host; o caminho
documentado `bun run docker:build:classic` construiu a imagem e `bun run docker:up`
subiu a API com healthcheck saudável. A duração acima é a observada nesta execução, não
uma estimativa de desempenho.

## Limitações e pendências

- OIDC e validação de JWT não foram iniciados; `AUTH_MODE=none` é um modo de
  desenvolvimento explícito e a Fase 15 continua posterior.
- A subfase visual 12B não foi implementada. O overlay permanece vazio por desenho; não
  há Grafana, Tempo, Loki, Alloy ou Collector para demonstrar.
- O teste de carga da Fase 16 não foi executado.
- O ledger mantém uma entrada por wallet/transação; double-entry é diferencial opcional.
- O scan versionado em `scripts/security-scan.sh` é heurístico e sem dependência de rede;
  ele cobre formatos comuns e não substitui uma política corporativa de secret scanning.
- O `check` padrão valida código e testes unitários sem tocar serviços reais. A evidência
  PostgreSQL/LocalStack deve ser obtida pelos comandos opt-in acima.
