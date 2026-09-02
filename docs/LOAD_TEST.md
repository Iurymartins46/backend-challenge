# Teste de carga da Fase 16

O comando `bun run test:load` executa um experimento opt-in contra PostgreSQL e
LocalStack reais. O runner cria um banco temporário, aplica as migrations, cria filas
FIFO temporárias e sobe três processos NestJS independentes. Ao terminar, encerra os
processos e remove o banco e as filas. O banco de desenvolvimento e as filas padrão não
são usados.

## Pré-condição e escopo

A Fase 16 é independente da Fase 15. A única pré-condição é a suíte distribuída
obrigatória estar estável; valide-a antes da carga:

```bash
bun run docker:up:infra
bun run test:concurrency
bun run test:load
```

O runner usa somente `BET` HTTP com identificadores únicos e mantém o lock por wallet,
idempotência, ledger, transactional outbox e constraints existentes. Não há ajuste de
consistência para aumentar RPS. A Fase 15 (OIDC) continua fora do experimento.

## Metodologia

São executados dois cenários sequenciais:

1. `hot-wallet`: todos os clientes disputam uma única wallet;
2. `many-wallets`: os clientes distribuem operações em várias wallets independentes.

Cada cenário tem warm-up, janela de medição e cooldown. Warm-up e cooldown não entram
nos percentis nem no throughput da medição. A janela é um workload fechado: cada worker
envia a próxima requisição depois que a anterior termina. Não existe meta de RPS.

O relatório JSON impresso no stdout registra, por cenário:

- quantidade de requisições, status HTTP e erros de rede/servidor;
- throughput observado e latência p50, p95 e p99;
- conflitos de lock agregados dos processos durante a medição;
- backlog e lag da outbox antes/depois da medição, máximo amostrado e estado após o cooldown;
- auditoria `wallet.balance == saldo reconstruído pelo ledger`;
- quantidade de amostras e falhas do sampler;
- máquina, Bun/Node, número de processos, pool PostgreSQL e volume de wallets.

Os conflitos e as métricas da outbox são diagnósticos por processo; o backlog/lag
amostrado diretamente do PostgreSQL é a evidência autoritativa do estado da outbox.

## Configuração

Os padrões foram escolhidos para uma execução reproduzível e podem ser alterados sem
editar o código:

| Variável | Padrão | Finalidade |
| --- | ---: | --- |
| `LOAD_INSTANCES` | `3` | processos NestJS; mínimo 3 |
| `LOAD_CONCURRENCY` | `16` | workers HTTP por cenário |
| `LOAD_WARMUP_MS` | `1000` | aquecimento |
| `LOAD_DURATION_MS` | `5000` | janela de medição |
| `LOAD_COOLDOWN_MS` | `5000` | cooldown antes de aguardar drenagem |
| `LOAD_DRAIN_TIMEOUT_MS` | `30000` | limite para observar a drenagem da outbox |
| `LOAD_HTTP_TIMEOUT_MS` | `10000` | timeout de cada requisição |
| `LOAD_METRICS_SAMPLE_INTERVAL_MS` | `250` | intervalo do sampler PostgreSQL |
| `LOAD_MANY_WALLETS` | `32` | wallets do cenário distribuído |
| `LOAD_WALLET_CREATION_CONCURRENCY` | `8` | paralelismo apenas da preparação |
| `LOAD_REPORT_PATH` | — | caminho opcional para salvar o JSON, preferencialmente fora do repo |

Por exemplo, uma rodada curta para diagnóstico local:

```bash
LOAD_WARMUP_MS=500 \
LOAD_DURATION_MS=2000 \
LOAD_COOLDOWN_MS=2000 \
bun run test:load
```

Para guardar a evidência sem sujar o worktree:

```bash
LOAD_REPORT_PATH=/tmp/phase16-load.json bun run test:load
```

O pool por processo é o padrão do `pg` usado pelo TypeORM (`max = 10`); o relatório
registra esse valor e o potencial total (`instâncias × 10`). Configurações de outbox e
timeouts de banco são herdadas do ambiente local e aparecem no relatório por meio das
consequências observadas, sem serem alteradas pelo runner.

O comando retorna erro para falhas de infraestrutura do experimento ou divergência
entre wallet e ledger. Respostas HTTP 4xx de regra de negócio, 5xx e falhas de rede são
contabilizadas no relatório, sem serem ocultadas nem convertidas em uma meta artificial.
