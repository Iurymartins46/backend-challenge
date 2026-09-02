# Arquitetura — Distributed Wagering Processor

> Este documento contém somente as decisões arquiteturais que afetam correção,
> consistência e evolução do sistema. Detalhes de implementação ficam em `docs/`.
> O bootstrap da Fase 1, o domínio puro da Fase 3, a persistência da Fase 4, a
> vertical HTTP de wallet/ledger, o processamento HTTP síncrono de BET/WIN/LOSS da
> Fase 6, de REFUND/ROLLBACK da Fase 7 e o consumidor SQS/inbox da Fase 8 já existem;
> o publisher da outbox da Fase 9 já existe; o worker agendado de referências pendentes
> da Fase 10 também existe.

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
o risco do timebox. A Fase 4 registra entidades de infraestrutura, migration reversível,
mappers explícitos e `FinancialUnitOfWork`. Todos os writes financeiros usam repositories
ligados ao mesmo `EntityManager` fornecido pelo Unit of Work; manager global não é usado
dentro da transação. `BIGINT` permanece string na entidade TypeORM e só é convertido para
`bigint` no mapper de `Money`.

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
O consumidor SQS recebe um envelope `WagerTransactionCommand` versionado. O
`messageId` do envelope é a identidade da mensagem de aplicação e é separado do
`MessageId` de transporte retornado pelo SQS. O caso de uso calcula o hash financeiro
normal para idempotência da aposta e a inbox calcula um hash do `data` completo,
incluindo a chave de idempotência, para detectar reuso divergente do message id.

A inserção da inbox usa a chave `(consumer_name, message_id)` e `ON CONFLICT DO NOTHING`,
permitindo que duas entregas concorrentes arbitrem a mesma mensagem no PostgreSQL. A
mensagem é marcada como processada na mesma transação que o caso de uso financeiro;
`DeleteMessage` só ocorre depois do commit. Falhas transitórias deixam a mensagem
invisível até a redelivery, enquanto envelopes permanentes permanecem sem ack para a
redrive policy encaminhá-los à DLQ.

O consumidor usa long polling, limite de concorrência, heartbeat de visibility timeout
e shutdown com drenagem limitada; mensagens ainda em processamento têm a visibilidade
devolvida ao expirar o timeout de shutdown.

Publishers da outbox usam claim com lease e `FOR UPDATE SKIP LOCKED`. Publicação é
at-least-once: morte após publicar e antes de marcar pode duplicar o evento; `eventId`
estável permite deduplicação no consumidor.

O claim é confirmado em uma transação curta com owner e `locked_until`. A chamada ao SQS
acontece somente depois desse commit; a marcação de sucesso e o agendamento de retry são
updates condicionados ao mesmo owner enquanto o lease não expirou. Um publisher parado
é recuperado quando outro encontra o lease vencido. Falhas usam backoff exponencial com
jitter; ao atingir o limite operacional, `attempts` fica saturado no teto e o evento
continua pendente com o atraso máximo, sem descarte silencioso.

Comandos entram em `wager-transactions.fifo`; eventos saem por
`wager-events.fifo`. Misturar os dois contratos na mesma fila criaria acoplamento e
risco de o consumidor tratar um evento como comando.

Detalhes: [docs/MESSAGING.md](docs/MESSAGING.md).

### 4.6 Referências fora de ordem

Referência ausente é persistida como `PENDING_REFERENCE`, não tratada como falha do
transporte. O fluxo síncrono revalida a referência depois do lock da wallet e permite
que uma nova submissão idempotente conclua a pendência. O worker seleciona registros
vencidos com `FOR UPDATE SKIP LOCKED`, grava claim/lease e contador de tentativas antes
de soltar a transação curta e então reutiliza o mesmo caso de uso financeiro e lock da
wallet. A policy é 2 s exponencial com jitter, teto de 5 min, 10 tentativas e TTL de
30 min. No limite, o mesmo caso de uso faz a última revalidação sob lock; referência
ainda ausente gera `REJECTED/error.wager.reference_not_found` e outbox correspondente.
Crash entre tentativas só deixa o lease expirar: agenda e contador permanecem no banco.

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
uso. O consumidor SQS expõe contadores processuais de recebimento, processamento,
duplicata, rejeição, redelivery transitória, DLQ, ack e heartbeat; eles são
diagnósticos e não substituem o estado financeiro no PostgreSQL. A stack visual é
adicionada depois.

O publisher da outbox expõe contadores processuais de claims, publicações, falhas,
retries, leases perdidos e os gauges de quantidade pendente e lag. IDs de eventos e
wallets ficam em logs/traces, não em labels de métricas.

O worker de referências expõe claims, tentativas, processamentos, reagendamentos,
expirações, leases perdidos e falhas, além dos gauges de pendências e tentativas
acumuladas. Esses valores são diagnósticos locais; PostgreSQL continua sendo a fonte da
verdade.

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
REFUND. Valor, provider, player, wallet, moeda e rodada devem corresponder. A abertura
`OPENING` é uma transação interna do ciclo de vida da wallet: ela grava um único evento
`WalletBalanceChanged`; os eventos de processamento de apostas começam com a entrada
de provedor na Fase 6.

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
