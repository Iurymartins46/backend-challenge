# Infraestrutura Docker

Todos os artefatos de containers devem permanecer nesta pasta.

Estrutura atual:

```text
docker/
  api/Dockerfile
  compose.yaml
  compose.observability.yaml
  compose.oidc.yaml
  keycloak/
  localstack/
  pgadmin/servers.json
  observability/
```

- `compose.yaml`: API, PostgreSQL, pgAdmin, LocalStack e inicialização das filas;
- `compose.observability.yaml`: overlay opcional com Collector,
  Prometheus, Tempo, Loki, Alloy e Grafana; somente Grafana publica porta no host;
- `compose.oidc.yaml`: overlay opcional que sobe Keycloak, importa o realm de demo e
  ativa `AUTH_MODE=oidc` na API;
- diretórios internos: scripts, configuração e provisioning montados nos containers.

Os comandos passam explicitamente o `.env` da raiz com `--env-file .env`;
`.env.example` mantém o contrato completo sem segredos reais. A imagem PostgreSQL 18
monta o volume nomeado em
`/var/lib/postgresql`, conforme o layout introduzido pela imagem oficial nessa major.

O Compose usa `localstack/localstack:4.14.0` por padrão porque as imagens
`2026.03.0+` exigem ativação de licença. Quem optar pela linha autenticada deve alterar
`LOCALSTACK_IMAGE` no `.env` local e preencher `LOCALSTACK_AUTH_TOKEN`. O valor vazio do
exemplo funciona com 4.14.0 e nenhum token deve entrar no Git.

Compose v2 espera o plugin Docker Buildx. Em instalações sem esse plugin, o mesmo
Dockerfile foi validado com o builder clássico usando
`COMPOSE_DOCKER_CLI_BUILD=0 DOCKER_BUILDKIT=0 docker compose ... build api`; instalar o
Buildx continua sendo a correção recomendada para o host.

O contexto de build da API deve apontar para a raiz do repositório, mesmo que o
`Dockerfile` esteja em `docker/api/`.

O pgAdmin é iniciado junto com a stack base e fica disponível em
`http://localhost:8081`. Entre com o e-mail e a senha definidos por
`PGADMIN_DEFAULT_EMAIL` e `PGADMIN_DEFAULT_PASSWORD`. O servidor PostgreSQL é
importado automaticamente a partir de `docker/pgadmin/servers.json` e usa o host
interno `postgres`; informe a senha do PostgreSQL na primeira conexão. A porta é
publicada apenas em `127.0.0.1`; troque as credenciais de exemplo antes de compartilhar
o ambiente.

Para subir a stack visual junto da aplicação:

```bash
bun run docker:up:observability
```

Esse comando não é necessário para executar a aplicação: `bun run docker:up` continua
subindo somente o Compose base. Se a imagem da API ainda não existir, construa-a antes
com `bun run docker:build` (ou `bun run docker:build:classic` em hosts sem Buildx).

Os serviços internos são descobertos pelos nomes `otel-collector`, `prometheus`,
`tempo` e `loki`. A interface fica em `http://localhost:3001`; use as variáveis
`GRAFANA_PORT`, `GRAFANA_ADMIN_USER` e `GRAFANA_ADMIN_PASSWORD` para ajustar a
instalação local.

Para testar a autenticação OIDC com o realm e clients de demonstração:

```bash
bun run docker:up:oidc
```

O Keycloak fica em `http://localhost:8080`. Esse overlay contém credenciais locais
deliberadamente públicas e não representa uma configuração pronta para produção. O
procedimento de obtenção do token e os scopes estão no
[`README.md`](../README.md#autenticação-oidc-opcional).
