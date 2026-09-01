# Arquitetura — Distributed Wagering Processor

> Este documento contém somente as decisões arquiteturais que afetam correção,
> consistência e evolução do sistema. Detalhes de implementação ficam em `docs/`.
> O bootstrap da Fase 1 e o domínio puro da Fase 3 já existem; persistência, transporte
> e processamento financeiro ainda são arquitetura-alvo para as fases seguintes.

## 1. Objetivo arquitetural

Processar operações financeiras por HTTP e SQS mantendo as invariantes abaixo com
mensagens duplicadas, fora de ordem, falhas de processo e três ou mais instâncias:

- saldo nunca negativo;
- nenhum débito ou crédito duplicado;
- toda mudança de saldo possui exatamente um lançamento correspondente no ledger;
- ledger é imutável;
- eventos confirmados não são perdidos;
- replay idempotente devolve o resultado original;
- wallet materializada e saldo reconstruído pelo ledger permanecem iguais.

O PostgreSQL é a autoridade final dessas garantias. SQS FIFO, locks da aplicação e
validações de domínio ajudam o processamento, mas não substituem transações,
constraints e índices únicos.

## 2. Visão do sistema

```text
HTTP ─────────────┐
                  ├─> ProcessWagerTransaction ─> PostgreSQL
SQS command ─Inbox┘        │                     wallet + transaction
                           │                     ledger + inbox + outbox
                           └─ mesma transação SQL

PostgreSQL outbox ─> publishers concorrentes ─> SQS events
Pending references ─> workers concorrentes ───> mesmo caso de uso financeiro
```

Entradas HTTP e SQS reutilizam o mesmo caso de uso. Workers não reproduzem regras de
negócio; apenas selecionam trabalho persistido e chamam a aplicação.

## 3. Organização e boundaries

O código será dividido em domínio, aplicação, infraestrutura e apresentação:

- **domínio:** `Money`, agregados, estados, regras e eventos; não importa NestJS,
  TypeORM ou AWS SDK;
- **aplicação:** casos de uso e portas; coordena operações sem acessar banco diretamente;
- **repositórios e Unit of Work:** possuem persistência, locks e fronteira transacional;
- **infraestrutura:** TypeORM, PostgreSQL, SQS, logging e telemetria;
- **apresentação:** controllers HTTP, DTOs, Swagger e consumidor SQS.

Entidades TypeORM são separadas das entidades de domínio. Mappers explícitos usam
`rehydrate()` para reconstruir estado persistido sem reexecutar transições antigas.

## 4. Decisões arquiteturais

### 4.1 TypeORM

TypeORM é aceito pelo desafio e foi escolhido por familiaridade profissional, reduzindo
o risco do timebox. Todos os writes financeiros usam repositories ligados ao mesmo
`EntityManager` fornecido pelo Unit of Work; manager global não é usado dentro da
transação.

### 4.2 Dinheiro em centavos com `bigint`

O contrato recebe e devolve string decimal com duas casas. O domínio converte para
centavos em `bigint`, e o PostgreSQL persiste em `BIGINT` junto da moeda `CHAR(3)`.
Nenhum caminho monetário passa por `number`.

Essa decisão é apropriada porque o desafio fixa escala 2. Caso o produto passe a
aceitar moedas com escalas variáveis ou ultrapasse a faixa de `BIGINT`, o caminho de
evolução é `NUMERIC(p,s)` e decimal arbitrário.

Detalhes: [docs/MONEY.md](docs/MONEY.md).

### 4.3 Lock pessimista por wallet

A unidade de concorrência é `walletId`. Toda operação que pode alterar saldo adquire
`SELECT ... FOR UPDATE` somente na linha da wallet. Isso impede lost update e torna
determinístico o cenário de duas apostas disputando o mesmo saldo sem criar lock global.

Wallets diferentes continuam em paralelo. Deadlocks e timeouts de lock são falhas
transitórias, com retry limitado da transação completa.

### 4.4 Idempotência persistente

A chave do header é persistida e protegida por índice único. SHA-256 de JSON canônico
do payload de negócio detecta a reutilização da mesma chave com conteúdo diferente.

A transação persiste `resultBalance` e `resultWalletVersion`. Assim, um replay devolve
o saldo observado originalmente, mesmo que a wallet tenha mudado depois.

### 4.5 Inbox e transactional outbox

Inbox, transação de aposta, wallet, ledger e outbox participam da mesma transação SQL.
O consumidor apaga a mensagem SQS somente depois do commit.

Publishers da outbox usam claim com lease e `FOR UPDATE SKIP LOCKED`. Publicação é
at-least-once: morte após publicar e antes de marcar pode duplicar o evento; `eventId`
estável permite deduplicação no consumidor.

Comandos entram em `wager-transactions.fifo`; eventos saem por
`wager-events.fifo`. Misturar os dois contratos na mesma fila criaria acoplamento e
risco de o consumidor tratar um evento como comando.

Detalhes: [docs/MESSAGING.md](docs/MESSAGING.md).

### 4.6 Referências fora de ordem

Referência ausente é persistida como `PENDING_REFERENCE`, não tratada como falha do
transporte. Um worker com backoff consulta registros vencidos, obtém o mesmo lock da
wallet e reutiliza o processamento financeiro. Limite ou TTL esgotado produz rejeição
auditável e evento correspondente.

### 4.7 Ledger e garantias no schema

O banco aplica:

- unique wallet por `(playerId, currency)`;
- unique idempotency key e external transaction por provider;
- `CHECK balance >= 0`;
- no máximo um ledger por transação/wallet;
- aritmética `before ± amount = after` no ledger;
- unicidade de reversão processada por referência e tipo;
- trigger que rejeita `UPDATE` e `DELETE` do ledger;
- FKs compostas que preservam wallet, player e moeda.

A aplicação ainda aplica as mesmas regras para produzir erros de domínio legíveis. As
constraints são a última defesa contra bugs e escritas concorrentes.

Detalhes: [docs/DATABASE.md](docs/DATABASE.md).

### 4.8 Autenticação adiada, boundary mantido

Autenticação não vale pontos e não será implementada no primeiro corte. O bootstrap
terá `ProviderIdentityPort`, guard global e adapter explícito `AUTH_MODE=none`.

Uma implementação futura troca apenas o adapter por OIDC externo, preferencialmente
Keycloak com client credentials. Health permanece público; mensagens SQS são canal
interno, mas o `providerId` continua validado pelo domínio. Não haverá tabela local de
senhas.

### 4.9 Observabilidade desde o bootstrap

OpenTelemetry é inicializado antes do NestJS para que auto-instrumentação não perca os
primeiros imports. A Fase 1 cria resource, propagação, traces básicos, correlation id e
exporter OTLP configurável. As métricas e spans de negócio entram junto dos casos de
uso; a stack visual é adicionada depois.

Logs JSON continuam sendo o contrato primário porque o sinal de logs do SDK JavaScript
do OpenTelemetry ainda tem maturidade inferior a traces e métricas. Telemetria nunca
participa da transação financeira nem torna readiness dependente de Grafana.

Detalhes: [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md).

### 4.10 Infraestrutura Docker separada por responsabilidade

Todos os artefatos Docker ficam em `docker/`:

```text
docker/
  api/Dockerfile
  compose.yaml
  compose.observability.yaml
  localstack/
  postgres/
  observability/
```

`docker/compose.yaml` contém aplicação, PostgreSQL, LocalStack e inicialização das
filas. `docker/compose.observability.yaml` é um overlay com Collector, Prometheus,
Tempo, Loki, Alloy e Grafana. São serviços distintos, mas ficam no mesmo repositório
para manter o ambiente local reproduzível.

## 5. Transação financeira

Para uma operação nova:

1. validar contrato, canonicalizar payload e calcular hash;
2. abrir transação SQL e registrar inbox quando a origem for SQS;
3. arbitrar a idempotency key por índice único;
4. em replay, comparar hash e devolver snapshot persistido;
5. adquirir lock da wallet;
6. revalidar wallet, moeda e referência sob o lock;
7. executar a transição de domínio;
8. persistir wallet, ledger, transaction, inbox e outbox;
9. commit;
10. somente então responder HTTP ou executar `DeleteMessage`.

Uma falha antes do commit não deixa efeitos parciais. Uma falha depois do commit é
recuperada por replay, inbox ou outbox.

## 6. Estados e regras essenciais

```text
PENDING ───────────────> PROCESSED
   │
   ├──> PENDING_REFERENCE ──> PROCESSED
   │            └───────────> REJECTED
   ├────────────────────────> REJECTED
   └────────────────────────> FAILED
```

`PROCESSED`, `REJECTED` e `FAILED` são terminais. `LOSS` processa sem ledger e sem
alterar a versão da wallet. `REFUND` referencia BET; `ROLLBACK` referencia BET, WIN ou
REFUND. Valor, provider, player, wallet, moeda e rodada devem corresponder.

A leitura literal adotada é uma reversão processada por `(reference, kind)`: no máximo
um REFUND e um ROLLBACK diretos para a mesma referência. Essa interpretação deve ser
confirmada com o avaliador como decisão de produto.

## 7. API e documentação

Swagger será disponibilizado desde o bootstrap e incrementado a cada endpoint. Erros
seguem um contrato JSON único com status, título, detalhe, trace id e um array não vazio
de erros com códigos de máquina.
Rejeições persistidas podem acrescentar transaction id; validação múltipla pode
acrescentar uma lista de erros. O schema inicial nasce na Fase 1 e não é reinventado
por cada módulo.

Detalhes e exemplos: [docs/API_AND_ERRORS.md](docs/API_AND_ERRORS.md).

## 8. Testes como evidência arquitetural

Testes unitários usam `bun:test`; integração e concorrência usam PostgreSQL e LocalStack
reais. A suíte distribuída sobe no mínimo três processos e inclui redelivery, crash
pós-commit/pré-ack, publishers concorrentes, referência fora de ordem e restart.

O invariante final de todo cenário é wallet igual ao saldo reconstruído pelo ledger.

Detalhes: [docs/TESTING.md](docs/TESTING.md).

## 9. Trade-offs assumidos

| Decisão | Benefício | Custo |
|---|---|---|
| TypeORM | menor risco e maior velocidade | não usa o ORM preferencial do enunciado |
| `bigint` em centavos | exatidão e aritmética simples | escala fixa e serialização explícita |
| lock pessimista | correção simples da hot wallet | espera sob contenção |
| outbox at-least-once | não perde evento confirmado | publicação duplicada é possível |
| autenticação adiada | protege o caminho crítico | demo HTTP inicia sem proteção real |
| observabilidade em overlay | núcleo local menor | dashboard não sobe por padrão |

## 10. Documentos relacionados

- [Enunciado original](docs/CHALLENGE.md)
- [Plano de implementação](docs/IMPLEMENTATION_PLAN.md)
- [Dinheiro](docs/MONEY.md)
- [Banco e constraints](docs/DATABASE.md)
- [API, Swagger e erros](docs/API_AND_ERRORS.md)
- [Mensageria](docs/MESSAGING.md)
- [Observabilidade](docs/OBSERVABILITY.md)
- [Estratégia de testes](docs/TESTING.md)
