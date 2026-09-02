# Arquitetura — Distributed Wagering Processor

Este documento registra as decisões que sustentam correção, consistência e evolução do
serviço. Ele explica o motivo das escolhas e seus trade-offs; contratos operacionais e
detalhes de uso ficam em [README.md](README.md) e em `docs/`.

## Objetivo arquitetural

Processar operações financeiras de apostas por HTTP e SQS sem violar estas invariantes:

- saldo de wallet nunca negativo;
- uma alteração de saldo gera exatamente um lançamento de ledger correspondente;
- ledger não pode ser alterado ou apagado;
- um comando repetido não produz efeitos financeiros duplicados;
- eventos confirmados no banco não se perdem por falha entre commit e publicação;
- wallet materializada e saldo reconstruído pelo ledger permanecem conciliáveis.

O PostgreSQL é a autoridade final. Filas FIFO, locks e validações de domínio reduzem
risco e melhoram fluxo, mas não substituem transações, constraints e índices únicos.

## Visão do sistema

```text
HTTP ────────────────────────────────┐
                                      v
SQS command ─> Inbox ─> ProcessWagerTransaction ─> PostgreSQL
                                      │              wallet + transaction
                                      │              ledger + inbox + outbox
                                      │                      │ commit
                                      v                      v
                          Pending-reference worker     Outbox publisher ─> SQS events

HTTP, consumidores e workers ──> logs JSON, métricas e traces
```

HTTP, SQS e o worker de referências convergem no mesmo caso de uso financeiro. Isso
evita regras diferentes conforme a origem do comando. A borda HTTP/SQS valida e adapta;
o domínio decide; repositories e a Unit of Work persistem.

## Organização e limites

- `src/modules/*/domain`: entidades, value objects e regras puras.
- `src/modules/*`: casos de uso, DTOs, controllers e contratos de portas.
- `src/infrastructure`: TypeORM, PostgreSQL, SQS, telemetria e logging.
- `tests/unit`: regras que não dependem de framework ou infraestrutura.
- `tests/integration` e `tests/concurrency`: provas contra PostgreSQL e LocalStack reais.

Services orquestram casos de uso; repositories são responsáveis por consultas e
persistência. Operações de escrita recebem DTOs nomeados e executam dentro de uma
`FinancialUnitOfWork`, evitando que lógica de negócio manipule o banco diretamente.

## Decisões arquiteturais

### Dinheiro em centavos com `bigint`

**Decisão.** A API recebe e devolve decimal como string (`"25.00"`); o domínio usa
centavos em `bigint` e o PostgreSQL usa `BIGINT`.

**Motivo.** Evita arredondamento IEEE-754 e permite representar o valor com precisão
idêntica no domínio e no banco.

**Trade-off.** Exige parsing, serialização e mapeamento explícitos; o driver retorna
`BIGINT` como string e esse limite deve ser respeitado. `NUMERIC` seria adequado para
escala variável, mas acrescentaria complexidade sem benefício para moeda de duas casas.

### Wallet materializada e ledger append-only

**Decisão.** A wallet guarda o saldo corrente; cada alteração gera um lançamento
imutável com saldo anterior e posterior. O banco impede `UPDATE` e `DELETE` do ledger.

**Motivo.** A leitura de saldo é rápida e a origem de cada mudança continua auditável.
O ledger permite reconstrução e reconciliação independente da lógica da aplicação.

**Trade-off.** Há dados redundantes que precisam permanecer coerentes. A redundância é
aceita porque a mesma transação grava wallet e ledger, e constraints/integrações provam
a invariante. Não há double-entry completo: ele seria um diferencial para um domínio
contábil mais amplo, mas não é necessário para o escopo atual.

### PostgreSQL como árbitro de concorrência

**Decisão.** Escritas financeiras obtêm lock pessimista `FOR UPDATE` na wallet dentro
de transação curta; workers elegíveis usam `FOR UPDATE SKIP LOCKED` com leases.

**Motivo.** O lock serializa débitos concorrentes na mesma wallet e preserva paralelismo
entre wallets distintas. `SKIP LOCKED` permite múltiplos publishers/workers sem lock
global e sem processar a mesma linha simultaneamente.

**Trade-off.** Há espera e conflitos em uma hot wallet. Esse custo é preferível a saldo
negativo ou a uma coordenação distribuída externa. Timeouts de lock e statement evitam
esperas indefinidas; o teste de carga torna esse limite observável.

### Idempotência persistente e hash canônico

**Decisão.** A transação é identificada por `(providerId, idempotencyKey)` e por
`(providerId, externalTransactionId)`. O payload de negócio recebe hash SHA-256
canônico e o resultado é persistido para replay.

**Motivo.** Retries HTTP, redelivery SQS e reinício não podem duplicar débito/crédito.
O hash distingue a repetição legítima da reutilização indevida da mesma chave.

**Trade-off.** O armazenamento aumenta e uma chave não pode ser reaproveitada para
outro comando. É uma regra explícita de contrato, mais segura que idempotência apenas
em memória ou no broker.

### Atomicidade por Unit of Work

**Decisão.** Wallet, transação, ledger, inbox e outbox são confirmados pela mesma
transação SQL. Repositories recebem o `EntityManager` transacional da Unit of Work.

**Motivo.** Elimina estados parcialmente confirmados: não existe saldo alterado sem
ledger, comando processado sem inbox ou resultado confirmado sem evento pendente.

**Trade-off.** A transação não engloba SQS, pois não há commit distribuído. Essa
limitação é resolvida pela outbox, e não por uma tentativa frágil de two-phase commit.

### Inbox e confirmação SQS pós-commit

**Decisão.** A inbox usa `(consumerName, messageId)` e hash de payload. A mensagem SQS
só recebe `DeleteMessage` depois do commit financeiro; falhas transitórias fazem
rollback e redelivery, e mensagens inválidas seguem a redrive policy.

**Motivo.** Garante que uma mensagem apagada já tem seu efeito persistido, enquanto
redeliveries são replays seguros.

**Trade-off.** O consumidor é at-least-once e pode ver mensagens repetidas. A inbox e
o caso de uso idempotente absorvem essa repetição; exatamente-once do broker não é
assumido.

### Transactional outbox com publicação at-least-once

**Decisão.** Eventos entram em `outbox_messages` na mesma transação financeira.
Publishers fazem claim/lease curto, publicam fora da transação e marcam sucesso somente
se ainda possuem o lease. Falhas recebem backoff com jitter.

**Motivo.** Uma queda após o commit não perde o evento. Uma queda após publicar e antes
da marcação o torna reenviável.

**Trade-off.** Um evento pode ser publicado mais de uma vez. O `eventId` é estável e
consumidores externos devem deduplicá-lo. A alternativa de marcar antes de publicar
evitaria duplicata, mas poderia perder eventos confirmados — risco inaceitável.

### Referências fora de ordem como estado durável

**Decisão.** Operações dependentes de uma referência ausente ficam
`PENDING_REFERENCE`, com agenda, tentativas e lease persistidos. Um worker reprocessa
as pendências com o mesmo caso de uso e o mesmo lock de wallet.

**Motivo.** A ordem entre produtores não é garantida globalmente; rejeitar de imediato
descartaria operações válidas. Persistir agenda e lease permite recuperação após restart.

**Trade-off.** A conclusão é eventualmente consistente e exige política de expiração.
Após o TTL, uma última revalidação rejeita de forma auditável, sem ledger, e emite o
evento de rejeição pela outbox.

### Reconciliação somente para leitura

**Decisão.** A reconciliação consulta wallet e soma do ledger no mesmo snapshot
`REPEATABLE READ`, calcula a diferença e nunca autocorrige.

**Motivo.** A resposta representa uma fotografia consistente e uma divergência é um
sinal que precisa de investigação, não uma autorização para modificar dados financeiros.

**Trade-off.** Não há reparo automático. Isso aumenta o trabalho operacional em caso de
incidente, mas preserva auditabilidade e evita que um diagnóstico destrua evidências.

### Contratos HTTP e autenticação como boundary

**Decisão.** DTOs/schema validam a borda, Swagger publica o contrato e erros usam um
envelope uniforme com códigos estáveis. A identidade de provedor é uma porta; o adapter
atual `AUTH_MODE=none` é explícito.

**Motivo.** Clientes podem integrar pelo contrato sem depender de mensagens internas.
A porta de identidade permite adicionar OIDC/JWT sem acoplar o domínio ao mecanismo.

**Trade-off.** O modo atual é apropriado para demonstração e desenvolvimento, não para
exposição pública. A autenticação deve ser implantada antes de um ambiente não confiável.

### Observabilidade não bloqueante

**Decisão.** Logs JSON, correlation id, métricas e traces são emitidos desde o
bootstrap. Exportação OTLP e a stack visual são opcionais e não entram na readiness.

**Motivo.** Falhas financeiras precisam de evidência correlacionável, mas a falha de um
backend de observabilidade não pode bloquear transações ou saúde da API.

**Trade-off.** Pode haver perda de telemetria durante indisponibilidade do exporter. O
sistema prefere preservar operação e registrar o problema a transformar observabilidade
em ponto único de falha.

### Infraestrutura local em Compose

**Decisão.** O Compose base reúne API, PostgreSQL, LocalStack e inicialização das filas;
o stack visual é um overlay separado. Serviços internos usam nomes DNS do Compose.

**Motivo.** Uma inicialização local é reproduzível, enquanto observabilidade permanece
opt-in e não pesa no caminho habitual.

**Trade-off.** A API containerizada usa URLs diferentes das do host; `.env.example`
mantém ambas explícitas para não mascarar essa diferença.

## Estados e fluxo financeiro

Uma operação passa por validação de contrato, identificação de wallet, lock, decisão de
domínio e persistência atômica. `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` geram
lançamentos conforme suas regras; reversões exigem referência e não podem levar o saldo
abaixo de zero. A referência ausente cria a pendência durável descrita acima.

Um replay com mesma chave e mesmo payload devolve o resultado gravado. Mesma chave ou
identificador externo com payload incompatível é conflito. Falhas de regra podem ser
persistidas como `REJECTED`; falhas de infraestrutura fazem rollback e recebem resposta
transitória. O catálogo de status e códigos está em [docs/API_AND_ERRORS.md](docs/API_AND_ERRORS.md).

## Evidência e documentos relacionados

- [Requisitos do desafio](docs/CHALLENGE.md)
- [API e erros](docs/API_AND_ERRORS.md)
- [Banco de dados](docs/DATABASE.md)
- [Dinheiro](docs/MONEY.md)
- [Mensageria](docs/MESSAGING.md)
- [Observabilidade](docs/OBSERVABILITY.md)
- [Estratégia de testes](docs/TESTING.md)
- [Registro de entrega](docs/DELIVERY.md)

Os testes de unidade protegem regras puras. Integração e concorrência usam PostgreSQL e
LocalStack reais, incluindo crash pós-commit/pré-ack, múltiplos processos, referências
fora de ordem, publishers concorrentes e constraints SQL. A lista de evidências está em
[docs/DELIVERY.md](docs/DELIVERY.md).
