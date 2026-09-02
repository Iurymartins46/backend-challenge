# Distributed Wagering Processor

Serviço financeiro distribuído para processar operações de apostas recebidas por HTTP
e Amazon SQS. O projeto protege saldo, idempotência e trilha financeira mesmo com
mensagens duplicadas, chegada fora de ordem, concorrência entre instâncias e falhas de
processo.

As principais garantias são:

- valores externos em decimal e cálculo interno exato em centavos (`bigint`/`BIGINT`);
- saldo não negativo, ledger imutável e reconciliação somente para leitura;
- idempotência persistente por provedor, chave e payload de negócio;
- lock pessimista por wallet e constraints do PostgreSQL como proteção final;
- inbox para comandos SQS, confirmação da mensagem somente após commit e outbox
  transacional para eventos;
- logs JSON, métricas Prometheus, traces OpenTelemetry, health checks e Swagger.

O enunciado e todos os requisitos do desafio estão preservados em
[docs/CHALLENGE.md](docs/CHALLENGE.md). As decisões e seus trade-offs estão em
[ARCHITECTURE.md](ARCHITECTURE.md).

## Começar rapidamente

Pré-requisitos: Bun 1.4.0, Docker Engine e Docker Compose v2. Com o repositório
clonado, execute os comandos abaixo na raiz:

```bash
bun install --frozen-lockfile
cp .env.example .env
bun run docker:start
```

`docker:start` é o comando único para iniciar a aplicação local completa: constrói a
imagem, inicia API, PostgreSQL, LocalStack e as filas SQS, e aplica as migrations. Ao
terminar, use:

- API: `http://localhost:3000`
- Swagger: `http://localhost:3000/docs`
- OpenAPI: `http://localhost:3000/docs-json`
- liveness: `http://localhost:3000/health/live`
- readiness: `http://localhost:3000/health/ready`

O `.env.example` contém uma configuração funcional para desenvolvimento. Copie-o antes
de iniciar e ajuste apenas se houver conflito de portas, credenciais ou serviços
externos. O arquivo `.env` não é versionado: não coloque segredos no Git. A imagem
LocalStack padrão funciona sem token; versões mais recentes podem exigir
`LOCALSTACK_AUTH_TOKEN` — veja [docker/README.md](docker/README.md).

Para executar a API no host, mantendo somente as dependências em containers:

```bash
bun run docker:up:infra
bun run migration:run
bun run dev
```

Nesse modo, `DATABASE_URL` e `SQS_ENDPOINT` devem apontar para `localhost`, como no
arquivo de exemplo. Pare os containers com `bun run docker:down`; os volumes são
preservados.

## Uso da API

| Método | Endpoint | Finalidade |
| --- | --- | --- |
| `GET` | `/health/live` | Verifica se o processo está ativo. |
| `GET` | `/health/ready` | Verifica PostgreSQL e SQS. |
| `GET` | `/metrics` | Expõe métricas Prometheus. |
| `POST` | `/wallets` | Cria uma wallet e o lançamento `OPENING`, quando aplicável. |
| `GET` | `/wallets/:walletId` | Consulta saldo e dados da wallet. |
| `GET` | `/wallets/:walletId/ledger` | Pagina o ledger imutável. |
| `POST` | `/wallets/:walletId/reconciliation` | Compara wallet e ledger no mesmo snapshot. |
| `POST` | `/wagering/transactions` | Processa `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`. |
| `GET` | `/wagering/transactions/:transactionId` | Consulta uma transação pelo identificador interno. |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta uma transação pelo identificador externo. |

`POST /wagering/transactions` requer o header `Idempotency-Key`. O contrato completo,
inclusive formatos de sucesso, códigos de erro e comportamento de replay, está em
[docs/API_AND_ERRORS.md](docs/API_AND_ERRORS.md) e no Swagger em execução.

Para uma verificação HTTP ponta a ponta após iniciar a stack:

```bash
bun run smoke:http
```

A coleção equivalente para Bruno fica em [tests/http/bruno](tests/http/bruno), e a
coleção cURL em [tests/http/curl](tests/http/curl).

## Comandos disponíveis

| Comando | Explicação |
| --- | --- |
| `bun run dev` | Inicia a API no host e reinicia ao alterar arquivos TypeScript. |
| `bun run start` | Inicia a API no host sem modo watch. |
| `bun run build` | Compila TypeScript para `dist/`. |
| `bun run typecheck` | Verifica os tipos sem gerar arquivos. |
| `bun run lint` | Executa ESLint e falha com qualquer warning. |
| `bun run format` | Formata os arquivos cobertos pela configuração Prettier. |
| `bun run format:check` | Confere a formatação sem alterar arquivos. |
| `bun run test` | Executa toda a suíte `bun:test`; cenários reais opt-in são ignorados sem suas variáveis. |
| `bun run test:unit` | Executa somente os testes unitários. |
| `bun run test:integration` | Executa os testes de integração; use `RUN_REAL_INTEGRATION_TESTS=true` para ativar os cenários PostgreSQL/LocalStack reais. |
| `bun run test:concurrency:once` | Executa uma rodada real do harness distribuído com três processos. |
| `bun run test:concurrency` | Executa duas rodadas do harness distribuído para aumentar a confiança contra flakiness. |
| `bun run test:load` | Executa o experimento opt-in de carga com banco, filas e processos isolados. |
| `bun run lockfile:check` | Confirma que `package.json` e `bun.lock` estão sincronizados. |
| `bun run check` | Executa a verificação local completa: lockfile, formato, lint, tipos, testes, build, smoke de pacotes e scan de segredos. |
| `bun run docker:config` | Valida a configuração final do Docker Compose usando `.env`. |
| `bun run docker:build` | Constrói somente a imagem da API. |
| `bun run docker:build:classic` | Constrói a imagem com o builder clássico para hosts sem Buildx. |
| `bun run docker:up` | Inicia a stack base usando imagens já construídas. |
| `bun run docker:up:build` | Constrói a imagem e inicia a stack base, sem aplicar migrations. |
| `bun run docker:start` | Constrói, inicia a stack base e aplica migrations; é o atalho recomendado para desenvolvimento local. |
| `bun run docker:up:observability` | Inicia API, dependências e o overlay opcional de observabilidade. |
| `bun run docker:up:infra` | Inicia somente PostgreSQL, LocalStack e a criação das filas. |
| `bun run docker:down` | Para e remove os containers da stack, preservando volumes nomeados. |
| `bun run docker:ps` | Mostra o estado de todos os serviços do Compose. |
| `bun run docker:logs` | Acompanha os logs da API em tempo real. |
| `bun run docker:queues` | Lista as filas SQS criadas no LocalStack. |
| `bun run migration:run` | Aplica migrations pendentes no banco configurado por `DATABASE_URL`. |
| `bun run migration:revert` | Reverte a última migration aplicada. |
| `bun run migration:show` | Mostra migrations aplicadas e pendentes. |
| `bun run migration:generate <nome>` | Gera uma migration a partir das mudanças de entidades; sem nome, usa `schema`. |
| `bun run smoke:packages` | Verifica a compatibilidade de pacotes usada no runtime. |
| `bun run smoke:http` | Exercita a API com cURL: wallet, aposta, replay, leituras, ledger, reconciliação e erros. |
| `bun run security:scan` | Procura padrões de segredos em arquivos rastreados; é uma verificação heurística local. |

Os comandos de integração, concorrência e carga exigem PostgreSQL e LocalStack saudáveis.
Inicie-os antes com `bun run docker:up:infra`. Eles usam recursos efêmeros próprios e
não usam o banco de desenvolvimento como fixture de resultado. Consulte
[docs/TESTING.md](docs/TESTING.md) para o que cada suíte prova.

## Migrations

As migrations são versionadas, revisáveis e reversíveis. Para alterar o schema, gere a
migration a partir das entidades, revise o SQL e valide ida, volta e nova ida em um
banco real:

```bash
bun run migration:generate adiciona-tabelas-e-signer
bun run migration:show
bun run migration:run
bun run migration:revert
```

O uso de `migration:generate` sem argumento cria um nome com o sufixo seguro `schema`.
Não gere migrations vazias. Os detalhes do schema, constraints e transações estão em
[docs/DATABASE.md](docs/DATABASE.md).

## Observabilidade

O overlay opcional inclui Collector, Prometheus, Tempo, Loki, Alloy e Grafana:

```bash
bun run docker:up:observability
```

Grafana fica em `http://localhost:3001` por padrão. A aplicação continua funcional sem
o overlay: readiness depende apenas de PostgreSQL e SQS. Configuração, sinais e limites
estão em [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md).

## Documentação

- [Requisitos do desafio](docs/CHALLENGE.md)
- [Decisões de arquitetura](ARCHITECTURE.md)
- [API, Swagger e contrato de erros](docs/API_AND_ERRORS.md)
- [Dinheiro](docs/MONEY.md)
- [Banco de dados](docs/DATABASE.md)
- [Mensageria](docs/MESSAGING.md)
- [Estratégia de testes](docs/TESTING.md)
- [Teste de carga](docs/LOAD_TEST.md)
- [Registro de entrega e evidências](docs/DELIVERY.md)
- [Plano de implementação histórico](docs/IMPLEMENTATION_PLAN.md)

## Problemas comuns

- Sem Buildx: execute `bun run docker:build:classic` e depois `bun run docker:up`.
- Dependências não ficam saudáveis: use `bun run docker:ps` e os logs do serviço no
  Compose; as portas padrão são 5432 (PostgreSQL) e 4566 (LocalStack).
- API sem tabelas: execute `bun run migration:run` ou reinicie por `bun run docker:start`.
- Integrações reais ignoradas: inclua `RUN_REAL_INTEGRATION_TESTS=true` antes de
  `bun run test:integration`.
