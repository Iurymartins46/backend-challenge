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

## Do zero à aplicação funcionando

O caminho recomendado usa Docker para que API, PostgreSQL, LocalStack, filas e
migrations sejam reproduzíveis. Você precisa de:

- Git;
- Bun **1.4.0** (a versão está fixada em `.bun-version` e `package.json`);
- Docker Engine em execução e Docker Compose v2;
- Bash e cURL apenas para o smoke test HTTP.

### 1. Clone o projeto e entre na pasta

```bash
git clone https://github.com/Iurymartins46/backend-challenge.git
cd backend-challenge
```

Se já recebeu ou clonou o repositório, apenas abra um terminal na raiz, onde estão
`package.json`, `.env.example` e este README.

### 2. Confirme as ferramentas

```bash
git --version
bun --version
docker --version
docker compose version
docker info
```

`bun --version` deve imprimir `1.4.0`. `docker info` precisa terminar sem erro; caso
contrário, inicie o Docker ou ajuste a permissão do seu usuário antes de continuar.

### 3. Instale as dependências e crie a configuração local

```bash
bun install --frozen-lockfile
cp .env.example .env
```

O primeiro comando instala exatamente as versões registradas em `bun.lock` e falha se
o manifesto e o lockfile divergirem. O segundo cria sua configuração local. O `.env`
não é versionado: não coloque credenciais reais no Git. Os valores de exemplo funcionam
localmente; altere-os apenas para resolver conflito de portas ou testar integrações.

### 4. Construa e inicie toda a stack

```bash
bun run docker:start
```

Esse é o comando de inicialização recomendado. Ele constrói a imagem da API, aguarda as
dependências, cria as filas, aplica as migrations e só considera a subida concluída
quando os serviços necessários estão saudáveis. Na primeira execução, o download das
imagens pode demorar alguns minutos.

### 5. Verifique a instalação

```bash
bun run docker:ps
curl -fsS http://localhost:3000/health/live
curl -fsS http://localhost:3000/health/ready
bun run smoke:http
```

Os dois endpoints devem responder com status `200`. O smoke cria dados com
identificadores novos, testa wallet, BET, replay idempotente, consultas, ledger,
reconciliação, métricas e um erro esperado. Ele não depende de dados previamente
existentes.

Depois disso, os principais endereços são:

| Recurso   | Endereço                             | Observação                        |
| --------- | ------------------------------------ | --------------------------------- |
| API       | `http://localhost:3000`              | Base das rotas HTTP.              |
| Swagger   | `http://localhost:3000/docs`         | Interface interativa do contrato. |
| OpenAPI   | `http://localhost:3000/docs-json`    | Documento JSON para ferramentas.  |
| Liveness  | `http://localhost:3000/health/live`  | Indica que o processo está vivo.  |
| Readiness | `http://localhost:3000/health/ready` | Verifica PostgreSQL e SQS.        |
| Métricas  | `http://localhost:3000/metrics`      | Exposição Prometheus.             |
| pgAdmin   | `http://localhost:8081`              | Publicado somente em loopback.    |

### 6. Pare a aplicação

```bash
bun run docker:down
```

Esse comando remove os containers e a rede, mas preserva os volumes nomeados e os
dados locais. Para acompanhar a API antes de parar, use `bun run docker:logs`.

### O que o Docker inicia

| Serviço           | Papel                                               |
| ----------------- | --------------------------------------------------- |
| `postgres`        | Fonte da verdade financeira.                        |
| `localstack`      | Emula SQS localmente.                               |
| `localstack-init` | Cria filas e redrive policy; termina após concluir. |
| `migrations`      | Aplica as migrations e termina após concluir.       |
| `api`             | Serve HTTP e executa consumer, publisher e worker.  |
| `pgadmin`         | Interface opcional para inspecionar o PostgreSQL.   |

Detalhes de imagens, volumes, overlays e solução para hosts sem Buildx estão em
[docker/README.md](docker/README.md).

## Desenvolvimento com a API no host

Use este modo quando quiser o reload automático do TypeScript, mantendo PostgreSQL e
LocalStack em containers:

```bash
bun run docker:up:infra
bun run docker:ps
bun run migration:run
bun run dev
```

Espere `postgres` e `localstack` ficarem `healthy` antes de aplicar a migration. Nesse
modo, `DATABASE_URL` e `SQS_ENDPOINT` precisam apontar para `localhost`, como já ocorre
no `.env.example`. A API lê o `.env` da raiz. Encerre o processo com `Ctrl+C` e depois
execute `bun run docker:down`.

## Uso da API

| Método | Endpoint                                                              | Finalidade                                                  |
| ------ | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| `GET`  | `/health/live`                                                        | Verifica se o processo está ativo.                          |
| `GET`  | `/health/ready`                                                       | Verifica PostgreSQL e SQS.                                  |
| `GET`  | `/metrics`                                                            | Expõe métricas Prometheus.                                  |
| `POST` | `/wallets`                                                            | Cria uma wallet e o lançamento `OPENING`, quando aplicável. |
| `GET`  | `/wallets/:walletId`                                                  | Consulta saldo e dados da wallet.                           |
| `GET`  | `/wallets/:walletId/ledger`                                           | Pagina o ledger imutável.                                   |
| `POST` | `/wallets/:walletId/reconciliation`                                   | Compara wallet e ledger no mesmo snapshot.                  |
| `POST` | `/wagering/transactions`                                              | Processa `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.       |
| `GET`  | `/wagering/transactions/:transactionId`                               | Consulta uma transação pelo identificador interno.          |
| `GET`  | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta uma transação pelo identificador externo.          |

`POST /wagering/transactions` requer o header `Idempotency-Key`. O contrato completo,
inclusive formatos de sucesso, códigos de erro e comportamento de replay, está em
[docs/API_AND_ERRORS.md](docs/API_AND_ERRORS.md) e no Swagger em execução.

Para uma verificação HTTP ponta a ponta após iniciar a stack:

```bash
bun run smoke:http
```

A coleção equivalente para Bruno fica em [tests/http/bruno](tests/http/bruno), e a
coleção cURL em [tests/http/curl](tests/http/curl).

## Todos os comandos do `package.json`

As tabelas abaixo explicam **cada script** disponível, inclusive pré-condições e efeitos
relevantes. Todos devem ser executados na raiz do repositório.

### Aplicação, qualidade e testes

| Comando                         | O que executa e quando usar                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run dev`                   | Executa `bun --watch src/bootstrap.ts`. Inicia a API no host e reinicia quando os fontes mudam; exige PostgreSQL/SQS conforme a configuração do `.env`.                                           |
| `bun run start`                 | Executa `bun src/bootstrap.ts`. Inicia a API no host sem watch, útil para uma execução local semelhante à de produção.                                                                            |
| `bun run build`                 | Executa o TypeScript com `tsconfig.build.json` e grava JavaScript em `dist/`. Não inicia a API.                                                                                                   |
| `bun run typecheck`             | Executa `tsc --noEmit`; verifica tipos sem criar `dist/` nem alterar fontes.                                                                                                                      |
| `bun run lint`                  | Executa ESLint no repositório e usa `--max-warnings=0`; qualquer erro ou warning reprova o comando.                                                                                               |
| `bun run format`                | Executa Prettier com `--write` nos fontes, testes, scripts e configurações listados no script. **Altera arquivos.** Markdown não faz parte desse escopo.                                          |
| `bun run format:check`          | Verifica a mesma seleção do comando anterior sem alterar arquivos.                                                                                                                                |
| `bun run test`                  | Executa `bun test`. Inclui a suíte descoberta pelo Bun; testes reais opt-in permanecem ignorados quando suas flags não estão habilitadas.                                                         |
| `bun run test:unit`             | Executa apenas `tests/unit`; não exige PostgreSQL nem LocalStack.                                                                                                                                 |
| `bun run test:integration`      | Executa `tests/integration` em série (`--max-concurrency=1`). Para rodar os cenários reais, use `RUN_REAL_INTEGRATION_TESTS=true bun run test:integration` com PostgreSQL e LocalStack saudáveis. |
| `bun run test:concurrency:once` | Define `RUN_REAL_CONCURRENCY_TESTS=true` e executa uma rodada serial do harness distribuído. A rodada cria banco/filas isolados e sobe três processos; exige a infraestrutura base saudável.      |
| `bun run test:concurrency`      | Encadeia duas execuções de `test:concurrency:once`. A segunda só começa se a primeira passar; repetir ajuda a revelar flakiness de concorrência.                                                  |
| `bun run test:load`             | Executa `scripts/load-test.ts`: experimento real isolado com três processos, cenário de hot wallet e cenário de várias wallets. Exige PostgreSQL/LocalStack e não integra o gate padrão.          |
| `bun run lockfile:check`        | Executa `bun install --frozen-lockfile --lockfile-only`; valida que `package.json` e `bun.lock` estão sincronizados sem instalar `node_modules`.                                                  |
| `bun run check`                 | Gate local padrão, em sequência: lockfile, formato, lint, tipos, testes, build, smoke de pacotes e scan de segredos. Para no primeiro erro e não ativa as suítes reais opt-in.                    |
| `bun run smoke:packages`        | Executa `tests/smoke/packages.ts` para verificar imports e compatibilidade mínima dos pacotes usados no runtime Bun.                                                                              |
| `bun run smoke:http`            | Executa `tests/http/curl/smoke.sh`; requer API em `localhost:3000`, Bash, cURL e Bun. Cria fixtures únicas e valida o fluxo HTTP principal.                                                       |
| `bun run security:scan`         | Executa o scanner heurístico local em `scripts/security-scan.sh`; procura padrões comuns de segredo no worktree sem rede. Não substitui uma ferramenta corporativa.                               |

### Docker Compose

Todos estes scripts leem o `.env` da raiz e usam `docker/compose.yaml`.

| Comando                           | O que executa e quando usar                                                                                                                                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run docker:config`           | Renderiza e valida silenciosamente o Compose base. Não sobe containers.                                                                                                                                        |
| `bun run docker:build`            | Constrói apenas a imagem `api` com o builder padrão. Não inicia serviços.                                                                                                                                      |
| `bun run docker:build:classic`    | Faz o mesmo build com BuildKit desabilitado; é o fallback para hosts sem o plugin Buildx.                                                                                                                      |
| `bun run docker:up`               | Executa a stack base em segundo plano com `--wait`, usando a imagem da API já existente. Inclui PostgreSQL, pgAdmin, LocalStack, filas, migrations e API.                                                      |
| `bun run docker:up:build`         | Igual ao anterior, mas usa `--build` antes de subir. É uma alternativa direta que exige um Buildx funcional; `docker:start` possui fallback automático.                                                        |
| `bun run docker:start`            | Caminho recomendado para a primeira inicialização. `scripts/docker-start.sh` tenta construir a API com Buildx, repete automaticamente com o builder clássico se esse build falhar e então executa `docker:up`. |
| `bun run docker:up:observability` | Combina o Compose base com o overlay de Collector, Prometheus, Tempo, Loki, Alloy e Grafana. Não força rebuild; execute `docker:start` antes se a imagem da API ainda não existir.                             |
| `bun run docker:up:oidc`          | Combina o Compose base com o overlay Keycloak, força `AUTH_MODE=oidc` na API e importa o realm de demonstração. Também requer a imagem da API previamente construída.                                          |
| `bun run docker:oidc:config`      | Valida a composição final do Compose base mais o overlay OIDC sem iniciar containers.                                                                                                                          |
| `bun run docker:up:infra`         | Sobe apenas PostgreSQL, LocalStack e o inicializador das filas. Não sobe API, pgAdmin nem o serviço de migrations e não usa `--wait`; confira a saúde antes do próximo comando.                                |
| `bun run docker:down`             | Para e remove containers e rede do projeto Compose. Não passa `--volumes`, portanto preserva os dados nomeados.                                                                                                |
| `bun run docker:ps`               | Exibe containers ativos, concluídos e parados do projeto (`--all`), útil para diagnóstico de health e migrations.                                                                                              |
| `bun run docker:logs`             | Segue os logs da API (`logs -f api`) até `Ctrl+C`; não para o container.                                                                                                                                       |
| `bun run docker:queues`           | Executa `awslocal sqs list-queues` dentro do LocalStack e lista as filas disponíveis. Requer o container ativo.                                                                                                |

### Migrations

Estes comandos usam `DATABASE_URL`. No host, ela deve apontar para a porta publicada do
PostgreSQL; dentro do Compose, o serviço `migrations` usa a URL interna.

| Comando                             | O que executa e quando usar                                                                                                                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run migration:run`             | Aplica em ordem todas as migrations pendentes pelo data source TypeORM. **Altera o schema do banco configurado.**                                                                                                                                    |
| `bun run migration:revert`          | Reverte somente a última migration aplicada. **Altera o schema** e deve ser usado com cuidado fora do ambiente local.                                                                                                                                |
| `bun run migration:show`            | Lista migrations aplicadas e pendentes sem modificar o schema.                                                                                                                                                                                       |
| `bun run migration:generate <nome>` | Compara entidades e banco pelo script `scripts/generate-migration.ts`, criando um arquivo em `src/infrastructure/database/migrations`. O nome aceita letras, números e hífens; sem argumento usa `schema`. **Cria arquivo e exige banco acessível.** |

Os comandos de integração, concorrência e carga exigem PostgreSQL e LocalStack saudáveis.
Inicie-os antes com `bun run docker:up:infra`. Eles usam recursos efêmeros próprios e
não usam o banco de desenvolvimento como fixture de resultado. Consulte
[docs/TESTING.md](docs/TESTING.md) para o que cada suíte prova.

## Migrations

As migrations são versionadas, revisáveis e reversíveis. Para alterar o schema, gere a
migration a partir das entidades, revise o SQL e valide ida, volta e nova ida em um
banco real:

```bash
bun run migration:generate add-transaction-metadata
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

## Autenticação OIDC opcional

O modo padrão é `AUTH_MODE=none`, destinado exclusivamente ao desenvolvimento local.
Essa restrição é operacional e não é bloqueada pelo parser de ambiente; um deploy deve
definir `AUTH_MODE=oidc` explicitamente. Para subir
o demo protegido com Keycloak, mantenha os valores OIDC do `.env.example` e execute:

```bash
bun run docker:up:oidc
```

O Keycloak fica em `http://localhost:8080`, importa o realm `wagering` e fornece dois
clients de demonstração: `provider-a`/`provider-a-secret` e
`provider-b`/`provider-b-secret`. Os segredos são deliberadamente públicos apenas para
o ambiente local e devem ser substituídos por secrets externos em qualquer ambiente
compartilhado. Se mudar a porta ou domínio do Keycloak, mantenha `KEYCLOAK_HOSTNAME` e
`OIDC_ISSUER` no mesmo endereço canônico público; apenas `OIDC_JWKS_URI_DOCKER` usa o
hostname interno do Compose.

Obtenha um token de serviço para o provedor A e envie-o como Bearer token:

```bash
TOKEN=$(curl -fsS -u provider-a:provider-a-secret \
  -d grant_type=client_credentials \
  http://localhost:8080/realms/wagering/protocol/openid-connect/token | \
  bun -e 'const input = await Bun.stdin.text(); console.log(JSON.parse(input).access_token)')
curl -i http://localhost:3000/wagering/transactions/00000000-0000-7000-8000-000000000000 \
  -H "Authorization: Bearer $TOKEN"
```

Em `AUTH_MODE=oidc`, a API aceita somente JWTs RS256 com issuer, audience, assinatura,
expiração e JWKS configurados. Os scopes `wager:read`, `wager:write`, `wallet:read` e
`wallet:write` protegem as rotas; nas operações que carregam `providerId`, o claim
`provider_id` precisa ser idêntico ao valor da operação. Health e métricas continuam
abertos, e SQS permanece canal interno confiável. A indisponibilidade do JWKS retorna
`503` após expirar o cache; um `kid` novo força uma única atualização, permitindo
rotação de chaves sem reinício.

## Documentação

- [Mapa da documentação e trilhas de leitura](docs/README.md)
- [Requisitos do desafio](docs/CHALLENGE.md)
- [Decisões de arquitetura](ARCHITECTURE.md)
- [API, Swagger e contrato de erros](docs/API_AND_ERRORS.md)
- [Dinheiro](docs/MONEY.md)
- [Banco de dados](docs/DATABASE.md)
- [Mensageria](docs/MESSAGING.md)
- [Observabilidade](docs/OBSERVABILITY.md)
- [Estratégia de testes](docs/TESTING.md)
- [Teste de carga](docs/LOAD_TEST.md)
- [Registro de entrega e evidências](docs/DELIVERY.md)
- [Plano de implementação histórico](docs/IMPLEMENTATION_PLAN.md)

## Problemas comuns

- Sem Buildx: `bun run docker:start` usa automaticamente o builder clássico. Para executar o fallback manualmente, use `bun run docker:build:classic` e depois `bun run docker:up`.
- Dependências não ficam saudáveis: use `bun run docker:ps` e os logs do serviço no
  Compose; as portas padrão são 5432 (PostgreSQL) e 4566 (LocalStack).
- API sem tabelas: execute `bun run migration:run` ou reinicie por `bun run docker:start`.
- Integrações reais ignoradas: inclua `RUN_REAL_INTEGRATION_TESTS=true` antes de
  `bun run test:integration`.
