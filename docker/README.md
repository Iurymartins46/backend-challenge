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

O contexto de build da API deve apontar para a raiz do repositório, mesmo que o
`Dockerfile` esteja em `docker/api/`.
