# Smoke HTTP com cURL

`smoke.sh` é um fluxo mínimo reproduzível para uma API local já iniciada. Ele usa
`curl`, Bash e Bun, sem depender de `jq` ou de dados fixos no banco.

## Pré-requisitos

Na raiz do projeto:

```bash
bun install --frozen-lockfile
cp .env.example .env
bun run docker:up:infra
bun run migration:run
bun run docker:up:build
```

O script espera a API em `http://localhost:3000`. Para outro endereço:

```bash
BASE_URL=http://localhost:3001 bash tests/http/curl/smoke.sh
```

O fluxo verifica liveness, readiness, Swagger JSON, criação de wallet, BET inicial,
replay idempotente, consultas por id interno e externo, ledger, reconciliação, métricas
e o contrato de wallet inexistente. Ele usa valores e identificadores próprios a cada
execução e não deixa arquivos no repositório.
