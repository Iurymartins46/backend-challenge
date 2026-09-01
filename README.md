# Distributed Wagering Processor

Serviço financeiro distribuído para processar apostas recebidas por HTTP e AWS SQS,
com idempotência persistente, concorrência por wallet, ledger imutável e transactional
outbox.

> **Estado atual:** Fases 1–6 implementadas. A aplicação NestJS, configuração,
> telemetria, health, Swagger, PostgreSQL/SQS e Compose estão preparados; o domínio
> puro, a persistência TypeORM e a vertical HTTP de wallet/ledger estão implementados;
> processamento HTTP síncrono de BET/WIN/LOSS, idempotência, lock por wallet e
> consultas de transação estão implementados; processamento SQS de apostas entra nas
> fases seguintes. O
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

- Bun 1.4.0 (também registrado em `.bun-version` e `packageManager`);
- Docker Engine;
- Docker Compose v2.

As versões exatas ficam travadas no lockfile e nas imagens Docker. `bun.lock` deve ser
versionado: ele torna `bun install --frozen-lockfile` e o build da imagem reproduzíveis.
O ambiente local usa PostgreSQL 18.6 e LocalStack Community 4.14.0.

## Configuração local

```bash
bun install --frozen-lockfile
cp .env.example .env
bun run docker:up:infra
bun run dev
```

A raiz do projeto contém um `.env` local ignorado pelo Git. Os comandos passam esse
arquivo explicitamente com `--env-file .env`, evitando que diferentes versões do
Compose procurem `.env` ao lado de `docker/compose.yaml`. `.env.example` é o contrato
versionado e contém todas as variáveis necessárias tanto para execução no host quanto
dentro da rede Docker. Não versionar credenciais reais.

O LocalStack passou a exigir conta e token nas imagens `2026.03.0+`. O padrão
`localstack/localstack:4.14.0` é a última linha Community que inicia sem credencial
externa e mantém o setup reproduzível. Para testar uma imagem atual autenticada, altere
`LOCALSTACK_IMAGE` somente no `.env` local e preencha `LOCALSTACK_AUTH_TOKEN`; nunca
versione o token. Consulte a
[documentação de autenticação do LocalStack](https://docs.localstack.cloud/aws/getting-started/auth-token/).

A API responde em `http://localhost:3000`. A migration financeira da Fase 4 cria o
schema reversível; os comandos abaixo executam e revertem esse schema no PostgreSQL.

## Migrations TypeORM

```bash
# Gera <timestamp>-adiciona-tabelas-e-signer.ts a partir do diff das entities
bun run migration:generate adiciona-tabelas-e-signer

# Sem nome, usa o sufixo seguro "schema": <timestamp>-schema.ts
bun run migration:generate

bun run migration:show
bun run migration:run
bun run migration:revert
```

O TypeORM exige um nome válido para formar também o nome da classe; por isso uma
migration gerada sem argumento não pode ter apenas o timestamp e recebe `schema` como
sufixo. Gerar migration somente em fases que alterem persistência, começando na Fase 4,
revisar o SQL gerado e então provar `up/down/up` no PostgreSQL real. Não gerar uma
migration vazia ao final de toda fase.

## Executar tudo em containers

```bash
bun run docker:up:build
```

Os scripts `docker:*` centralizam o caminho do Compose e o carregamento de `.env`:

```bash
bun run docker:config         # valida a configuração resolvida
bun run docker:build          # constrói a API sem iniciar containers
bun run docker:up             # inicia as imagens já construídas
bun run docker:up:infra       # inicia somente PostgreSQL e LocalStack
bun run docker:ps             # mostra o estado de todos os serviços
bun run docker:queues         # lista as filas criadas no LocalStack
bun run docker:logs           # acompanha os logs da API
bun run docker:down           # encerra os containers; preserva volumes
```

O Docker Compose atual usa Buildx por padrão. Se o host ainda não tiver o plugin,
instale-o ou use temporariamente o builder clássico:

```bash
bun run docker:build:classic
bun run docker:up
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
  --env-file .env \
  -f docker/compose.yaml \
  -f docker/compose.observability.yaml \
  up --build
```

O overlay visual será criado em fase posterior. Nesta fase, `OTEL_ENABLED=true` configura
o exporter OTLP da aplicação, mas nenhum Collector, Prometheus, Tempo, Loki, Alloy ou
Grafana é provisionado.

## Testes

```bash
bun run check
```

`check` verifica primeiro se `package.json` e `bun.lock` estão sincronizados, depois
executa formatação em modo somente leitura, lint, typecheck, todos os testes, build
TypeScript e o smoke test de compatibilidade dos pacotes. Os comandos individuais
continuam disponíveis quando for necessário isolar uma falha.

Na Fase 4, a integração opt-in contra PostgreSQL real valida migration, constraints,
round-trip, rollback atômico e a UoW. Execute-a com
`RUN_REAL_INTEGRATION_TESTS=true bun test tests/integration/financial-persistence.spec.ts`.
Essa mesma suíte também valida a abertura transacional de wallets e a paginação do
ledger da Fase 5. Os cenários de processamento financeiro e concorrência começam nas
fases posteriores.
Na Fase 1, PostgreSQL 18.6 e LocalStack reais são usados para validar startup, health,
Swagger e filas; os testes automatizados cobrem configuração, erros, auth no-op e o span
HTTP básico.

O projeto usa NestJS 12 com Fastify e validação Standard Schema/Zod. TypeScript 6.0.2 é
o maior release aceito por `typescript-eslint@8.69.0` (`<6.1.0`); TypeScript 7 será
adotado quando o linter declarar compatibilidade, sem desativar o lint tipado.

## Teste manual com Bruno

A coleção OpenCollection versionada fica em `tests/http/bruno`. No Bruno 3+, use
**Open Collection** e selecione essa pasta (a que contém `opencollection.yml`), depois
selecione o ambiente `local`. Ela cobre health, Swagger, o envelope uniforme de erro e
as rotas de wallet da Fase 5. Rotas adicionadas nas próximas fases devem vir
acompanhadas dos respectivos cenários manuais na mesma coleção; o Codex pode criá-los e
mantê-los junto com o código.

O arquivo `.env` da raiz continua sendo exclusivo do Compose/aplicação. Não coloque
segredos nos YAMLs do Bruno; quando uma rota futura precisar de credencial, mantenha o
valor real fora do Git e referencie uma variável local do Bruno.

As rotas síncronas de apostas da Fase 6 exigem o header `Idempotency-Key` e ficam em
`POST /wagering/transactions`, `GET /wagering/transactions/:transactionId` e
`GET /providers/:providerId/wagering/transactions/:externalTransactionId`.

## Health checks

```text
GET /health/live
GET /health/ready
```

Liveness verifica somente o processo. O endpoint de readiness desta fase verifica o
estado do processo; as verificações de PostgreSQL e SQS entram quando os adapters de
saúde forem implementados. Readiness nunca dependerá da stack visual.
