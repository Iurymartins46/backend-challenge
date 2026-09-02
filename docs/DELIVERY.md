# Registro final da entrega

Este documento reúne a rastreabilidade das garantias implementadas, o roteiro de
demonstração, as evidências de validação e os limites deliberados. O experimento de
carga é opcional. `docs/CHALLENGE.md` permanece como o enunciado original.

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
bun run test:load
```

`test:integration` cria bancos temporários para seus cenários e
`test:concurrency` executa duas rodadas completas. Cada rodada cria banco, filas e três
processos próprios. Ambos exigem PostgreSQL e LocalStack saudáveis, mas não devem usar o
banco de desenvolvimento como fixture de resultado.

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
                         ├──> /metrics ──> Prometheus ──> Grafana
                         ├──> OTLP ──> Collector ──> Tempo ──> Grafana
                         └──> stdout ──> Alloy ──> Loki ──> Grafana
```

O PostgreSQL arbitra idempotência, locks, constraints e a atomicidade. SQS FIFO ordena
e reduz duplicatas, mas não é a garantia final. `DeleteMessage` ocorre somente depois
do commit.

## Matriz requisito → implementação → evidência

| Requisito                                 | Implementação principal                                                              | Evidência verificável                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Dinheiro exato e sem IEEE-754             | `src/modules/wagering/domain/money.ts`, `BIGINT` no TypeORM                          | `tests/unit/money/money.spec.ts`; round-trip e limite em `tests/integration/financial-persistence.spec.ts`                                  |
| Wallet não negativa e ledger consistente  | lock `FOR UPDATE`, `Wallet`, ledger append-only e checks SQL                         | `tests/integration/financial-persistence.spec.ts`; auditoria wallet = ledger no harness distribuído                                         |
| Abertura atômica                          | `CreateWalletUseCase` + UoW com `OPENING`/ledger/outbox                              | `tests/unit/wallet/wallet.use-cases.spec.ts`; integração de rollback e abertura                                                             |
| BET/WIN/LOSS/REFUND/ROLLBACK              | `ProcessWagerTransactionUseCase` e regras puras                                      | `tests/unit/domain/wagering-domain.spec.ts` e `tests/unit/wagering/process-wager-transaction.use-case.spec.ts`; integração HTTP/referências |
| Concorrência por wallet e três instâncias | lock pessimista por `walletId`; nenhum lock global                                   | oito cenários em `tests/concurrency/distributed-wagering.spec.ts`, com duas BETs de 80, 50 duplicatas e wallets paralelas                   |
| Idempotência persistente                  | índice único, hash SHA-256 canônico e snapshot de resultado                          | `tests/integration/financial-persistence.spec.ts`, `http-wagering-api.spec.ts` e replay após restart no harness                             |
| Referência fora de ordem                  | `PENDING_REFERENCE`, claim/lease, backoff e TTL                                      | `tests/integration/pending-reference-worker.spec.ts`, testes de referências e cenário distribuído de REFUND                                |
| Inbox, redelivery e DLQ                   | chave `(consumer_name, message_id)`, ack pós-commit e redrive policy                 | `tests/integration/sqs-inbox.spec.ts`; filas e `maxReceiveCount=5` em Compose/harness                                                       |
| Transactional outbox                      | outbox na UoW, publisher com `SKIP LOCKED`/lease, retry                              | `tests/integration/outbox-publisher.spec.ts`; publisher concorrente e crash no harness                                                      |
| Reconciliação somente leitura             | snapshot `REPEATABLE READ`, diferença assinada, métrica de divergência               | `tests/unit/wallet/reconcile-wallet.use-case.spec.ts` e `tests/integration/reconciliation.spec.ts`                                          |
| Observabilidade operacional               | logs JSON, correlation ids, métricas de negócio, gauge real da DLQ, health separado e overlay visual 12B | `tests/unit/logging.spec.ts`, `telemetry.spec.ts`, `health.spec.ts`, `sqs-inbox.spec.ts`, indisponibilidade real, `/metrics` e `docker/observability/` |
| Teste de carga opcional                   | runner isolado com hot wallet e muitas wallets, três processos, warm-up/medição/cooldown | `scripts/load-test.ts`, [docs/LOAD_TEST.md](LOAD_TEST.md) e execução real abaixo |
| Contrato HTTP                             | DTOs/schema Zod, Swagger, envelope uniforme de erro                                  | `docs/API_AND_ERRORS.md`, coleção Bruno e `tests/http/curl/smoke.sh`                                                                        |
| OIDC opcional de providers                | Keycloak em overlay, client credentials, JWKS cache/rotação, scopes e provider binding | `tests/unit/oidc-provider-identity.adapter.spec.ts`, `provider-auth.guard.spec.ts` e fluxo local Keycloak abaixo                            |
| Schema como última defesa                 | FKs, uniques, checks e trigger append-only                                           | SQL direto em `financial-persistence.spec.ts` e no cenário de constraints distribuído                                                       |

## Roteiro de demonstração

1. Mostrar o diagrama e explicar que HTTP, SQS e worker convergem no mesmo caso de uso.
2. Executar `bun run smoke:http` e mostrar o `201` inicial, o `200` do replay, a leitura
   pelos dois identificadores, o ledger e a reconciliação `consistent: true`.
3. Explicar `Money` como string na borda, `bigint` em centavos no domínio e `BIGINT` no
   PostgreSQL; apontar a constraint de saldo e o trigger imutável.
4. Executar `bun run test:concurrency`. Destacar a corrida de 50 BETs, o cenário 80/80,
   as wallets distintas, três processos, o crash pós-commit/pré-ack, dois publishers,
   REFUND fora de ordem e restart.
5. Executar `bun run test:load` e comparar hot wallet com muitas wallets, observando
   percentis, throughput, conflitos de lock, lag da outbox e a auditoria final.
6. Na apresentação, abrir os logs de uma falha do harness e apontar os
   `correlationId`s e os últimos logs por processo, sem expor valores financeiros.
7. Mostrar `POST /wallets/:walletId/reconciliation` e explicar que divergência é
   sinalizada por resposta, log e métrica, sem autocorreção.
8. Abrir o Grafana em `http://localhost:3001`, mostrar o dashboard provisionado e
   consultar um trace no Tempo e os logs correlatos no Loki. A stack visual é um overlay
   opcional e não participa da readiness financeira.

## Registro de versões e execução

O registro abaixo deve refletir a última execução real da suíte e não uma estimativa.

| Item                     | Valor registrado                                                          |
| ------------------------ | ------------------------------------------------------------------------- |
| Data da validação        | 2026-09-02                                                                |
| Runtime/package manager  | Bun 1.4.0 (`.bun-version`, `package.json`)                                |
| Banco                    | PostgreSQL 18.6-alpine                                                    |
| Mensageria               | LocalStack Community 4.14.0, SQS                                          |
| Container tooling        | Docker 29.7.2; Docker Compose v5.5.0                                      |
| Máquina                  | Linux 7.0.0-30-generic, x86_64, 22 CPUs, 14,99 GiB RAM                   |
| Suíte unitária           | 76 testes, 288 assertions, 554 ms                                         |
| Suíte de integração real | 34 testes, 174 assertions, 2,27 s, PostgreSQL/LocalStack e DLQ real       |
| Suíte distribuída real   | 2 rodadas; 16 execuções, 42 assertions, 47,91 s                           |
| Suíte de carga real      | 2 cenários; 707/4.088 requests na medição; 0 erros; wallets/ledger consistentes; outbox não drenou em 35 s |
| Smoke HTTP real          | `bun run smoke:http` passou contra API containerizada em `localhost:3000` |
| Health com falha real    | LocalStack e PostgreSQL: liveness 200 e readiness 503                     |

Na execução real registrada, o cenário hot wallet observou 707 requests na
medição, 138,75 RPS, p50/p95/p99 de 128,31/157,20/174,29 ms e zero erros. O cenário
muitas wallets observou 4.088 requests, 815,80 RPS, p50/p95/p99 de
16,82/36,35/44,99 ms e zero erros. Não houve divergência wallet/ledger nem conflito de
lock observado. A outbox chegou a 1.462 pendências no primeiro cenário e a 10.018 no
segundo; após 35 s de cooldown/drenagem ainda havia 472 e 9.028, respectivamente.
Esse backlog é uma limitação observada da configuração padrão, não foi ocultado nem
usado para relaxar as garantias financeiras.

O caminho padrão `bun run docker:up:build` encontrou o Buildx ausente no host; o caminho
documentado `bun run docker:build:classic` construiu a imagem e `bun run docker:up`
subiu a API com healthcheck saudável. A duração acima é a observada nesta execução, não
uma estimativa de desempenho.

Na Fase 15, o overlay OIDC foi validado com Keycloak 26.7.3 e realm importado. Um token
`client_credentials` de `provider-a` passou pela API atual executada no host contra as
dependências Docker e recebeu `404` somente porque a transação de consulta não existia;
health permaneceu `200`, token ausente/inválido retornou `401` e um POST com
`providerId=provider-b` retornou `403/error.auth.provider_mismatch`. O rebuild clássico
da imagem Docker desta fase ficou bloqueado por falha do Bun ao extrair
`swagger-ui-dist`; não é apresentado como evidência de imagem atualizada.

## Autenticação opcional implementada

O overlay `docker/compose.oidc.yaml` sobe Keycloak e importa o realm/demo clients. O
adapter OIDC valida JWT RS256 por issuer, audience, assinatura, expiração e JWKS, aplica
scopes e bloqueia divergência entre `provider_id` autenticado e `providerId` da operação.
`AUTH_MODE=none` permanece exclusivamente para desenvolvimento; a execução real do
overlay e do fluxo client credentials deve ser registrada nesta seção quando realizada.

## Notas não bloqueantes

- O ledger mantém uma entrada por wallet/transação; double-entry é diferencial opcional.
- O scan versionado em `scripts/security-scan.sh` é heurístico e sem dependência de rede;
  ele cobre formatos comuns e não substitui uma política corporativa de secret scanning.
- O `check` padrão valida código e testes unitários sem tocar serviços reais. A evidência
  PostgreSQL/LocalStack deve ser obtida pelos comandos opt-in acima.
