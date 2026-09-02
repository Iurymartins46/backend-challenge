# Observabilidade

## Estratégia

OpenTelemetry começa na Fase 1, antes do bootstrap do NestJS. Isso permite carregar
auto-instrumentação antes dos módulos que ela precisa observar.

A base inicial contém:

- `telemetry.ts` carregado antes de `main.ts`;
- resource com service name, version, environment e instance id;
- propagação W3C Trace Context;
- traces HTTP/PostgreSQL básicos;
- exporter OTLP configurável e não bloqueante;
- correlation id compartilhado entre HTTP, SQS, logs e eventos;
- desligamento ordenado do SDK.

Na subfase 12A, o comportamento é provado com exporter in-memory, endpoint OTLP
indisponível e `/metrics` em formato Prometheus servido pela própria API. A configuração
do Collector/Tempo pertence à fase posterior, evitando misturar instrumentação da
aplicação com provisionamento dos backends.

As fases de domínio adicionam spans e métricas de negócio no momento em que cada fluxo
é implementado. A fase dedicada à observabilidade completa métricas, redaction, health
e dashboards; não posterga toda a instrumentação para o final.

## Sinais

### Logs

Pino JSON no stdout, com correlation, trace/span id e identificadores operacionais.
Tokens, headers, payload completo e valores financeiros são removidos. IDs de alta
cardinalidade pertencem a logs/traces, não a labels de métrica.

### Métricas

- transações por kind/status/source;
- duplicatas;
- retries e DLQ;
- lock conflicts;
- latência;
- outbox pending/lag;
- referências pendentes, tentativas e expirações;
- divergências de reconciliação.

### Traces

HTTP/SQS, caso de uso, transação SQL, espera de lock, inbox/outbox e publicação. Uma
falha do exporter não pode falhar a operação financeira.

## Topologia local

```text
API/workers ──OTLP traces──> OpenTelemetry Collector ──> Tempo
API/workers ──/metrics─────────────────────────────────> Prometheus
API/workers ──JSON stdout──> Grafana Alloy ────────────> Loki
                                      Grafana consulta ─┴─ backends
```

## Docker

- `docker/compose.yaml`: aplicação, PostgreSQL e LocalStack;
- `docker/compose.observability.yaml`: overlay opcional;
- `docker/observability/`: Collector, Prometheus, Tempo, Loki, Alloy e provisioning do
  Grafana.

Readiness depende de PostgreSQL e SQS, nunca do collector ou dos backends visuais.
Liveness verifica somente o processo.

`GET /metrics` é público e expõe somente métricas com labels de baixa cardinalidade
(`kind`, `status` e `source`, quando aplicável). IDs de transação, wallet, provider,
mensagem e evento ficam disponíveis em logs/traces, mas nunca são labels.

## Risco Bun/OpenTelemetry

O SDK JavaScript é direcionado ao ecossistema Node.js e a compatibilidade de cada
pacote sob Bun deve ser provada cedo. A Fase 1 inclui smoke test e trava versões no
lockfile. Logs JSON e métricas obrigatórias não devem ser sacrificados caso uma
instrumentação automática específica seja incompatível.
