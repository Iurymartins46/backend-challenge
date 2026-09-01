# Distributed Wagering Processor

Serviço financeiro distribuído para processar apostas recebidas por HTTP e AWS SQS,
com idempotência persistente, concorrência por wallet, ledger imutável e transactional
outbox.

> **Estado atual:** planejamento arquitetural. Os comandos abaixo definem a interface
> operacional pretendida e devem ser confirmados na fase final da implementação. O
> enunciado original foi preservado em [docs/CHALLENGE.md](docs/CHALLENGE.md).

## Documentação

- [Arquitetura](ARCHITECTURE.md)
- [Plano de implementação](docs/IMPLEMENTATION_PLAN.md)
- [API, Swagger e erros](docs/API_AND_ERRORS.md)
- [Dinheiro](docs/MONEY.md)
- [Banco de dados](docs/DATABASE.md)
- [Mensageria](docs/MESSAGING.md)
- [Observabilidade](docs/OBSERVABILITY.md)
- [Testes](docs/TESTING.md)

## Pré-requisitos

- Bun 1.x;
- Docker Engine;
- Docker Compose v2.

As versões exatas devem ficar travadas no lockfile e nas imagens Docker.

## Configuração local

```bash
bun install --frozen-lockfile
cp .env.example .env
docker compose -f docker/compose.yaml up -d postgres localstack localstack-init
bun run migration:run
bun run dev
```

A API deverá responder em `http://localhost:3000`.

## Executar tudo em containers

```bash
docker compose -f docker/compose.yaml up --build
```

## Swagger

Com a aplicação em execução:

- interface: `http://localhost:3000/docs`;
- especificação JSON: `http://localhost:3000/docs-json`.

O Swagger deve ser habilitado por configuração e permanecer disponível no ambiente de
desenvolvimento usado na avaliação.

## Observabilidade local

```bash
docker compose \
  -f docker/compose.yaml \
  -f docker/compose.observability.yaml \
  up --build
```

O overlay adicionará OpenTelemetry Collector, Prometheus, Tempo, Loki, Alloy e Grafana.
A URL planejada do Grafana é `http://localhost:3001`.

## Testes

```bash
bun run lint
bun run typecheck
bun run test:unit
bun run test:integration
bun run test:concurrency
```

Os testes de integração e concorrência devem usar PostgreSQL e LocalStack reais. A
documentação final registrará duração, ambiente e eventuais limitações conhecidas.

## Health checks

```text
GET /health/live
GET /health/ready
```

Liveness verifica somente o processo. Readiness verifica PostgreSQL e SQS e não depende
da stack Grafana.
