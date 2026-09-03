# Observabilidade

## Estratégia

OpenTelemetry inicia antes do bootstrap do NestJS. Isso permite carregar
auto-instrumentação antes dos módulos que ela precisa observar.

A base inicial contém:

- `telemetry.ts` carregado antes de `main.ts`;
- resource com service name, version, environment e instance id;
- propagação W3C Trace Context;
- traces HTTP/PostgreSQL básicos;
- exporter OTLP configurável e não bloqueante;
- correlation id compartilhado entre HTTP, SQS, logs e eventos;
- desligamento ordenado do SDK.

O comportamento é provado com exporter in-memory, endpoint OTLP indisponível e
`/metrics` em formato Prometheus servido pela própria API. O overlay local recebe traces
no Collector, persiste-os no Tempo e provisiona Prometheus, Loki, Alloy, cAdvisor,
Blackbox Exporter e Grafana sem
tornar esses serviços dependências do caminho financeiro.

Spans e métricas de negócio são adicionados junto do fluxo que observam. A instrumentação
não é postergada para o final do desenvolvimento.

## Sinais

### Logs

Pino JSON no stdout, com correlation, trace/span id e identificadores operacionais.
Tokens, headers, payload completo e valores financeiros são removidos. IDs de alta
cardinalidade pertencem a logs/traces, não a labels de métrica.

### Métricas

- transações por kind/status/source;
- duplicatas;
- retries, falhas permanentes e quantidade real de mensagens na DLQ;
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
API ──OTLP traces──────> OpenTelemetry Collector ──> Tempo
API ──/metrics────────────────────────────────────> Prometheus
API ──JSON stdout──────> Grafana Alloy ───────────> Loki
API ──health probes───> Blackbox Exporter ────────> Prometheus
API ──container stats─> cAdvisor ─────────────────> Prometheus
                                      Grafana consulta ─┴─ backends
```

## Docker

- `docker/compose.yaml`: aplicação, PostgreSQL e LocalStack;
- `docker/compose.observability.yaml`: overlay opcional de observabilidade;
- `docker/observability/`: Collector, Prometheus, Tempo, Loki, Alloy, cAdvisor,
  Blackbox Exporter e provisioning do Grafana.

Readiness depende de PostgreSQL e SQS, nunca do Collector ou dos backends visuais.
Liveness verifica somente o processo. O overlay publica somente o Grafana no host; os
demais serviços usam `expose` e comunicação pela rede interna do Compose.

Os dashboards provisionados acompanham processamento/outbox, tráfego e latência por
rota, CPU/memória do container da API, probes de liveness/readiness, logs filtrados da
API no Loki e traces da API no Tempo. Os arquivos de configuração e provisioning ficam sob
`docker/observability/`; as imagens são pinadas por padrão no overlay e podem ser
substituídas por variáveis locais para testes de atualização.

O contador `wagering.sqs.consumer.permanent_failures` registra classificações locais do
consumidor. Separadamente, um monitor consulta periodicamente os atributos
`ApproximateNumberOfMessages`, `ApproximateNumberOfMessagesNotVisible` e
`ApproximateNumberOfMessagesDelayed` da DLQ. A soma é exposta pela gauge
`wagering.sqs.messages.dlq`; falhas nessa leitura preservam o último valor válido e são
contadas sem afetar o processamento financeiro.

`GET /metrics` é público e expõe somente métricas com labels de baixa cardinalidade
(`kind`, `status`, `source`, `method`, `route` e `status_class`, quando aplicável). As
rotas usam templates do framework; IDs de transação, wallet, provider, mensagem,
correlação e trace ficam disponíveis em logs/traces, mas nunca são labels.

O Alloy mantém somente os logs do container Compose `api`. Os logs de Grafana,
Prometheus, Loki, Tempo e demais componentes ficam fora do índice do Loki para evitar
volume e ruído desnecessários. O parsing JSON adiciona apenas `level` como label; IDs
permanecem no conteúdo do log para busca e correlação.

## Risco Bun/OpenTelemetry

O SDK JavaScript é direcionado ao ecossistema Node.js e a compatibilidade de cada
pacote sob Bun deve ser provada cedo. O projeto inclui smoke test e trava versões no
lockfile. Logs JSON e métricas obrigatórias não devem ser sacrificados caso uma
instrumentação automática específica seja incompatível.
