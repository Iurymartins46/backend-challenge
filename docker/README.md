# Infraestrutura Docker

Todos os artefatos de containers devem permanecer nesta pasta.

Estrutura planejada:

```text
docker/
  api/Dockerfile
  compose.yaml
  compose.observability.yaml
  localstack/
  postgres/
  observability/
```

- `compose.yaml`: API, PostgreSQL, LocalStack e inicialização das filas;
- `compose.observability.yaml`: overlay com Collector, Prometheus, Tempo, Loki, Alloy e
  Grafana;
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
