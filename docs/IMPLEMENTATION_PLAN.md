# Plano de implementação — Distributed Wagering Processor

Este plano foi escrito para ser executado por etapas. Cada fase deve terminar com
testes e um diff revisável antes da próxima começar.

## 1. Instrução permanente para cada fase

Ao pedir uma fase ao Codex, usar estas regras:

1. ler integralmente `README.md`, `ARCHITECTURE.md`, `docs/CHALLENGE.md`, este plano e
   os documentos temáticos relacionados à fase antes de alterar código;
2. implementar apenas a fase solicitada e suas dependências diretas;
3. mostrar qualquer ambiguidade que mude regra financeira antes de assumi-la;
4. preservar alterações preexistentes e conferir `git status` antes/depois;
5. nunca usar `number`, `float`, `double`, `parseFloat` ou coerção numérica para dinheiro,
   inclusive em DTOs, mappers, testes, métricas ou fixtures;
6. manter domínio sem imports de NestJS/TypeORM;
7. executar as verificações proporcionais à fase e distinguir teste estático de teste
   real com PostgreSQL/LocalStack;
8. atualizar documentação quando uma decisão implementada divergir do desenho;
9. não iniciar autenticação, load test ou double-entry ledger enquanto algum cenário
   obrigatório estiver pendente;
10. ao encerrar, informar arquivos alterados, testes executados, limitações e a próxima
    fase recomendada;
11. toda rota nova deve entregar, na mesma fase, DTOs, schemas Swagger, exemplos e
    códigos de erro específicos sobre o contrato base.

Prompt curto reutilizável:

```text
Implemente somente a Fase N de docs/IMPLEMENTATION_PLAN.md. Antes de alterar código,
leia README.md, ARCHITECTURE.md, docs/CHALLENGE.md, a fase completa e os documentos
temáticos que ela referencia. Preserve o worktree, cumpra os critérios de aceite,
execute as verificações indicadas e não faça commit. Ao final, relate diff, testes
reais executados e pendências sem avançar para a próxima fase.
```

## 2. Estratégia de tempo

### P0 — não negociável

Fases 0 a 14, exceto o overlay visual 12B. Elas cobrem as falhas eliminatórias e os
100 pontos obrigatórios. Se o tempo apertar, reduza acabamento visual, nunca testes de
concorrência, constraints, inbox/outbox ou recuperação.

### P1 — diferencial de observabilidade

Subfase 12B: Tempo, Loki, Prometheus e Grafana provisionados. O bootstrap do
OpenTelemetry, logs JSON, métricas e health checks permanecem P0.

### P2 — somente se P0 e P1 estiverem verdes

Fases 15 e 16: autenticação real e teste de carga. Partidas dobradas ficam fora desta
entrega, pois mudariam o modelo central tarde demais.

Regra de parada: qualquer diferencial é interrompido se quebrar migration, teste de
integração, concorrência ou o invariante wallet/ledger.

## 3. Fases

## Fase 0 — Congelar decisões e critérios

**Objetivo:** começar sem deixar decisões estruturais para o meio da implementação.

### Atividades

- revisar as decisões de `ARCHITECTURE.md` contra `docs/CHALLENGE.md`;
- preservar o enunciado original em `docs/CHALLENGE.md`;
- registrar novas interpretações neste arquivo ou em ADRs curtos;
- criar um quadro simples de requisitos com estado `pending/passing`.

### Critério de aceite

- autenticação, ORM, dinheiro, locks, inbox/outbox, retry e observabilidade têm decisão;
- toda restrição eliminatória possui uma fase e um teste associado.

### Quadro de requisitos e evidências

`passing` significa que a decisão ou o rastreamento já está definido nesta fase;
`pending` significa que a garantia ainda depende da implementação e do teste real da
fase indicada. Nenhum item `pending` deve ser tratado como comportamento já validado.

| ID | Requisito ou decisão | Estado | Fase responsável | Evidência prevista |
|---|---|---|---|---|
| F0-01 | Autenticação fica adiada, com `ProviderIdentityPort`, guard e `AUTH_MODE=none` como extensão explícita. | passing | 1 e 15 | smoke do guard no-op; testes OIDC somente na fase opcional |
| F0-02 | TypeORM é o ORM escolhido; repositórios financeiros usam o `EntityManager` da mesma Unit of Work. | passing | 4 | integração de transação e rollback com PostgreSQL |
| F0-03 | Dinheiro usa string de duas casas na borda, `bigint` de centavos no domínio e `BIGINT` no PostgreSQL. | passing | 2 e 4 | unitários de `Money` e round-trip PostgreSQL |
| F0-04 | Concorrência é serializada por `walletId` com lock pessimista apenas na wallet; wallets diferentes permanecem paralelas. | passing | 6 e 13 | corrida 80/80, 50 submissões e teste com wallets distintas |
| F0-05 | Inbox, wallet, transação, ledger e outbox confirmam na mesma transação; ack SQS ocorre somente após o commit. | passing | 8 e 9 | atomicidade, redelivery e failpoint pós-commit/pré-ack |
| F0-06 | Falhas transitórias usam retry limitado/backoff; negócio terminal recebe ack e falha permanente vai para DLQ. | passing | 6, 8, 9 e 10 | testes reais de retry, DLQ, lease e recuperação |
| F0-07 | Observabilidade começa no bootstrap, com logs estruturados, traces, métricas e health separados sem entrar no caminho financeiro. | passing | 1 e 12 | exporter/collector indisponível, logs redigidos, métricas e readiness |
| F0-08 | Não usar `number`, `float` ou `double` para dinheiro. | pending | 2 e 13 | unitários de `Money` e auditoria `rg` de código/testes |
| F0-09 | Idempotência não depende de memória; chave e hash do payload são persistidos e sobrevivem a restart. | pending | 4, 6, 8 e 13 | constraints, replay/conflito e restart com PostgreSQL real |
| F0-10 | SQS FIFO não é a garantia final de consistência nem de deduplicação. | pending | 8 e 13 | redelivery real e deduplicação persistente via inbox |
| F0-11 | Eventos nunca são publicados antes do commit financeiro. | pending | 9 e 13 | failpoint pós-commit/pré-publicação e auditoria da outbox |
| F0-12 | Ledger é auditável e não pode ser atualizado nem excluído. | pending | 4 e 13 | trigger/constraints e tentativa de `UPDATE`/`DELETE` via SQL |
| F0-13 | Não existe lock global compartilhado por todas as wallets. | pending | 6 e 13 | processamento paralelo de wallets distintas |
| F0-14 | Saldo não usa `read → calculate → update` sem controle de concorrência. | pending | 6 e 13 | duas BETs concorrentes sobre saldo 100 e auditoria final |
| F0-15 | A solução permanece correta com três ou mais instâncias. | pending | 13 | harness com pelo menos três processos reais |
| F0-16 | Unicidade, imutabilidade e não-negatividade são garantidas no schema PostgreSQL. | pending | 4 e 13 | migration `up/down/up`, SQL direto e constraints reais |

O quadro é deliberadamente conservador: `passing` nesta fase não substitui os testes
de integração e concorrência posteriores. A matriz geral de rastreabilidade abaixo
resume os mesmos vínculos por requisito do desafio.

---

## Fase 1 — Bootstrap, qualidade e infraestrutura principal

**Objetivo:** obter um serviço NestJS mínimo executando em Bun, com padrões transversais
e dependências locais reproduzíveis, sem implementar o domínio financeiro.

### Atividades

- iniciar projeto NestJS/TypeScript strict com Fastify e validação Standard Schema/Zod;
- configurar scripts Bun: `dev`, `start`, `build`, `typecheck`, `lint`, `test`,
  `test:unit`, `test:integration`, `test:concurrency` e migrations;
- fazer um smoke test antecipado, sob Bun, dos pacotes escolhidos para NestJS,
  TypeORM/pg, AWS SDK e OpenTelemetry; travar as versões que funcionarem no lockfile;
- configurar formatter/linter sem relaxar `strict`;
- criar configuração tipada com validação e `.env.example` sem segredos;
- criar `telemetry.ts` carregado antes de `main.ts`, com resource, propagação W3C,
  traces básicos, exporter OTLP configurável e shutdown do SDK;
- configurar Pino JSON, correlation id e integração inicial com trace/span id;
- criar `ErrorResponseDto`, `ErrorItemDto`, array `errors` obrigatório, filtro global e
  catálogo inicial de códigos conforme `docs/API_AND_ERRORS.md`;
- configurar Swagger em `/docs` e OpenAPI JSON em `/docs-json`, com schemas base de
  health, dinheiro e erros; cada fase posterior complementa os endpoints;
- criar `docker/api/Dockerfile` multi-stage com usuário sem privilégios e graceful
  shutdown;
- criar `docker/compose.yaml` com PostgreSQL, LocalStack, initializer das filas e API;
- manter LocalStack Community 4.14.0 como padrão sem credencial e documentar que a linha
  2026.03.0+ exige `LOCALSTACK_AUTH_TOKEN` local não versionado;
- reservar `docker/compose.observability.yaml` e `docker/observability/` para a
  configuração posterior, sem subir a stack visual nesta fase;
- configurar healthchecks dos containers e volumes nomeados;
- provisionar a fila FIFO de comandos, sua DLQ/redrive policy (`maxReceiveCount = 5`)
  e a fila FIFO separada para eventos da outbox;
- criar `ProviderIdentityPort`, guard global e adapter explícito `AUTH_MODE=none`, sem
  implementar JWT/IdP;
- criar módulo raiz e liveness inicial; readiness completa entra quando os adapters de
  PostgreSQL e SQS estiverem disponíveis.

### Testes/verificações

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
docker compose --env-file .env -f docker/compose.yaml config
docker compose --env-file .env -f docker/compose.yaml up -d postgres localstack localstack-init
docker compose --env-file .env -f docker/compose.yaml ps
```

Validar por comando AWS contra o LocalStack que as três filas existem e que a fila de
comandos aponta para sua DLQ.

### Critério de aceite

- aplicação inicia com Bun;
- PostgreSQL e SQS ficam saudáveis;
- configuração inválida impede startup com mensagem clara;
- Swagger expõe os schemas base;
- um erro de validação retorna o contrato padronizado, lista de erros e `traceId`;
- um span HTTP básico é capturado por exporter in-memory no teste, e endpoint OTLP
  indisponível não torna a requisição dependente dele;
- nenhum código financeiro foi criado ainda.

---

## Fase 2 — `Money` exato e primitives de domínio

**Objetivo:** eliminar o maior risco financeiro antes de persistência e HTTP.

### Atividades

- implementar `Money` imutável baseado em `bigint` de centavos;
- separar factory para contrato não negativo de reconstrução/uso interno assinado;
- implementar zero, soma, subtração, negação, comparações e igualdade;
- implementar parsing estrito e serialização com duas casas;
- implementar erros de moeda, formato, range e sinal;
- manter `0.00` válido no value object/saldo inicial, mas rejeitar valor zero nos DTOs
  de operações externas;
- adicionar `Clock`, gerador de ids e erros-base de domínio, sem framework;
- proibir serialização acidental de `bigint` fora de `Money.toJSON()`.

### Casos mínimos de teste

- `0.00`, `0.01`, `25.00`, valor grande e zeros internos;
- vazio, espaço, `1`, `.10`, `1.0`, `1.000`, `01.00`, `1,00`, `1e2`, `NaN`,
  `Infinity` e valor negativo no contrato;
- overflow do `BIGINT` escolhido;
- operações entre BRL/BRL e conflito BRL/USD;
- imutabilidade e inversão exata;
- ausência de arredondamento: `1.005` é erro.

### Verificações

```bash
bun test tests/unit/money
bun run typecheck
bun run lint
rg -n "parseFloat|parseInt|Number\(|: number" src tests
```

O último comando é auditoria: `number` continua permitido para versão, tentativas,
limites e tempo; cada ocorrência deve ser revisada para garantir que não é dinheiro.

### Critério de aceite

- nenhum caminho monetário passa por IEEE-754;
- contrato sempre recebe/devolve string fixa;
- testes cobrem todas as entradas proibidas do enunciado.

---

## Fase 3 — Domínio de wallet, transação, ledger e eventos

**Objetivo:** implementar todas as regras como classes puras antes do banco.

### Atividades

- implementar `Wallet.open/rehydrate`, `debit` e `credit`;
- implementar `WagerTransaction.create/rehydrate` e máquina de estados;
- implementar `WalletLedgerEntry.create/rehydrate` e `isBalanced`;
- implementar Inbox/Outbox e retry policy pura;
- implementar `IntegrationEvent` abstrato e quatro subclasses mínimas;
- implementar semântica de BET, WIN, LOSS, REFUND e ROLLBACK;
- definir failure codes estáveis;
- separar evento com alteração de saldo de evento de transação processada.

### Testes

- invariantes e versionamento da wallet;
- tabela completa de operações e direções;
- saldo insuficiente de BET versus reversão negativa;
- referência errada em kind, valor, contexto e moeda;
- uma reversão por tipo;
- terminalidade dos estados;
- `LOSS` processada sem ledger nem mudança de versão;
- payload de evento contém `MoneyProps`, nunca `Money`/`bigint`.

### Critério de aceite

- domínio não importa NestJS, TypeORM ou AWS SDK;
- toda transição inválida falha antes da persistência;
- saldo e ledger são produzidos como uma única decisão de domínio.

---

## Fase 4 — Schema, migrations, mappers e Unit of Work

**Objetivo:** transferir as garantias para PostgreSQL e criar a única fronteira de
transação usada pelos casos de uso.

### Atividades

- criar entidades TypeORM exclusivas da infraestrutura;
- criar primeira migration com todas as tabelas, FKs, checks e índices descritos;
- criar trigger append-only do ledger;
- criar mappers explícitos de/para domínio;
- implementar repositories port/adapters;
- implementar `FinancialUnitOfWork` que fornece repositories presos ao mesmo
  `EntityManager` transacional;
- configurar lock timeout e statement timeout;
- garantir que nenhum adapter use manager global dentro da transação.

### Testes de integração reais

- migration `up/down/up` em banco vazio;
- unique wallet, idempotency key, external transaction e ledger;
- rejeição de saldo negativo e ledger desbalanceado via SQL direto;
- rejeição de `UPDATE/DELETE` do ledger;
- round-trip de todos os agregados e de valores monetários grandes;
- rollback conjunto quando qualquer insert falha.

### Critério de aceite

- invariantes de unicidade, imutabilidade e não-negatividade existem no schema;
- todos os writes de uma operação compartilham a mesma transação;
- migrations são reversíveis.

---

## Fase 5 — Vertical de wallet e ledger

**Objetivo:** entregar a primeira fatia HTTP persistente e reconciliável.

### Atividades

- DTOs e validação de `POST /wallets`;
- criar wallet, `OPENING`, ledger e outbox na mesma transação;
- implementar conflito `(playerId, currency)`;
- implementar `GET /wallets/:walletId`;
- implementar ledger com cursor Base64URL versionado e limite 1..100;
- documentar endpoints no OpenAPI;
- adicionar os códigos e schemas de erro de wallet ao contrato base da Fase 1.

### Testes

- wallet zero sem opening/ledger;
- wallet positiva com exactly one opening/ledger/outbox;
- falha intermediária não deixa registro parcial;
- duplicata retorna 409;
- cursor sem lacunas/duplicatas quando timestamps empatam;
- payload monetário sempre string.

### Critério de aceite

- abertura respeita o mesmo invariante final das transações de aposta;
- consultas não expõem entidade TypeORM;
- paginação é estável e opaca.

---

## Fase 6 — Processamento HTTP, idempotência e lock da wallet

**Objetivo:** implementar o coração síncrono do desafio com concorrência real.

### Atividades

- implementar canonicalização RFC 8785 e SHA-256 do payload de negócio;
- implementar `ProcessWagerTransactionUseCase` independente do transporte;
- inserir/arbitrar idempotência no PostgreSQL;
- adquirir `FOR UPDATE` na wallet e aplicar BET/WIN/LOSS;
- persistir snapshot do saldo/version para replay;
- persistir ledger e eventos na mesma transação;
- implementar POST e os dois GETs de transação;
- mapear 201/200/202/409/422/503 conforme arquitetura;
- documentar no Swagger respostas de sucesso, replay, pending, conflito, rejeição e
  indisponibilidade, especializando o contrato de erro base;
- retry limitado para erros transitórios de lock/transação.

### Testes

- replay idêntico retorna mesmo transaction id e saldo histórico;
- mesma key com payload diferente retorna 409 sem efeito;
- mesmo external id com outra key retorna conflito;
- 50 BETs idênticas em paralelo geram um débito;
- duas BETs de 80 sobre 100 geram um processed, um rejected e saldo 20;
- duas wallets avançam em paralelo;
- LOSS não altera versão nem ledger;
- falha antes do commit não deixa outbox órfã.

### Critério de aceite

- testes usam conexões paralelas reais, não Promises que chamam mocks sequencialmente;
- replay permanece correto depois de outras operações mudarem o saldo;
- invariante wallet/ledger é conferido por SQL no final.

---

## Fase 7 — Referências, REFUND e ROLLBACK

**Objetivo:** completar as regras financeiras dependentes e operações fora de ordem no
fluxo síncrono.

### Atividades

- resolver referência por `(providerId, referenceExternalTransactionId)`;
- revalidar referência depois de adquirir o lock da wallet;
- validar contexto, kind, valor e status;
- implementar REFUND e as três direções possíveis de ROLLBACK;
- persistir `PENDING_REFERENCE` quando a referência não existe;
- proteger reversão concorrente por constraint e regra de domínio;
- diferenciar aposta sem saldo de reversão que deixaria saldo negativo.

### Testes

- matriz completa de referências válidas/inválidas;
- refund/rollback concorrentes do mesmo tipo;
- valor divergente, player/wallet/provider/round/currency divergentes;
- rollback de WIN/REFUND sem saldo suficiente;
- referência ausente retorna 202 e outbox pending;
- referência processada exatamente no limite da corrida é recuperável pelo worker.

### Critério de aceite

- nenhuma reversão parcial;
- operações rejeitadas são auditáveis e não geram ledger;
- constraints impedem dupla reversão processada mesmo fora do caso de uso.

---

## Fase 8 — Consumidor SQS e inbox

**Objetivo:** usar o mesmo caso de uso por SQS, com ack pós-commit e deduplicação
persistente.

### Atividades

- implementar adapter AWS SDK apontável para LocalStack;
- validar envelope e separar `messageId` de transport MessageId;
- propagar correlation/causation ids;
- registrar inbox na transação financeira;
- implementar long polling, concorrência limitada e visibility heartbeat;
- classificar erro de negócio, transitório e permanente;
- implementar DLQ/redrive e métricas;
- implementar shutdown: parar polling, drenar e devolver visibility no timeout.

### Testes reais

- mensagem válida produz o mesmo resultado do HTTP;
- redelivery do mesmo message id não duplica efeito;
- mesmo message id com payload divergente chega à DLQ;
- erro de negócio confirma inbox e recebe ack;
- indisponibilidade transitória não recebe ack;
- morte pós-commit/pré-ack causa redelivery seguro;
- duas instâncias consomem wallets diferentes em paralelo.

### Critério de aceite

- `DeleteMessage` só ocorre após confirmação do commit;
- inbox, transação, wallet, ledger e outbox são atômicos;
- a correção não depende de FIFO/dedup do SQS.

---

## Fase 9 — Publisher da outbox

**Objetivo:** publicar todos os eventos confirmados apesar de crash e múltiplos
publishers.

### Atividades

- implementar claim curto com `FOR UPDATE SKIP LOCKED` e lease;
- publicar fora da transação de claim;
- marcar sucesso condicionado ao lease;
- implementar attempts, backoff, jitter, recuperação de lease e limite operacional;
- publicar apenas em `wager-events.fifo`, usando `eventId` como deduplication id e
  `walletId` como group id;
- medir quantidade e lag da outbox;
- garantir que nenhuma chamada ao SQS aconteça antes do commit financeiro.

### Testes

- dois publishers não perdem nem publicam indefinidamente o mesmo claim;
- crash depois do commit financeiro e antes de publicar é recuperado;
- crash depois de publicar e antes de marcar pode duplicar, mas preserva `eventId`;
- SQS indisponível agenda retry sem alterar transação financeira;
- tipos e versões dos quatro eventos estão corretos.

### Critério de aceite

- todo evento confirmado termina publicado quando a dependência volta;
- duplicidade residual é explicitamente at-least-once e deduplicável;
- publisher pode rodar em todas as instâncias.

---

## Fase 10 — Worker de referências pendentes

**Objetivo:** finalizar operações entregues fora de ordem sem intervenção manual.

### Atividades

- selecionar vencidas com claim/lease e `SKIP LOCKED`;
- aplicar policy 2 s, exponencial, jitter, teto 5 min, 10 tentativas/TTL 30 min;
- reusar o processamento financeiro e o lock por wallet;
- ao sucesso, gravar ledger/eventos/snapshot atomicamente;
- ao esgotar, rejeitar com failure code específico e emitir evento;
- expor métricas de pendência, attempts e expiração.

### Testes

- REFUND e ROLLBACK chegam antes e concluem após a referência;
- dois workers disputam o mesmo pending sem duplicar;
- restart entre tentativas preserva agenda;
- TTL/limite rejeita e permanece auditável;
- clock fake elimina sleeps longos na suíte comum.

### Critério de aceite

- referência fora de ordem obrigatória passa em três instâncias;
- terminalidade e ledger continuam corretos após restart.

---

## Fase 11 — Reconciliação

**Objetivo:** comprovar e expor a consistência entre saldo materializado e ledger.

### Atividades

- implementar `POST /wallets/:walletId/reconciliation`;
- ler wallet e agregado do ledger em `REPEATABLE READ`;
- devolver stored, calculated, signed difference, consistent e checked entries;
- emitir log error e métrica em divergência;
- nunca corrigir automaticamente;
- documentar sucesso, wallet inexistente e falha transitória no Swagger.

### Testes

- wallet zero, somente opening e várias operações;
- leitura concorrente com nova operação não mistura snapshots;
- cenário de divergência controlada via fixture SQL é detectado e não alterado.

### Critério de aceite

- resultado é determinístico e monetário em string;
- divergência deixa evidência observável sem escrita corretiva.

---

## Fase 12 — Health, logs, métricas e tracing

**Objetivo:** completar a base criada na Fase 1 com telemetria de negócio, health e a
stack visual, sem tornar observabilidade parte do caminho crítico.

### Atividades

- revisar Pino JSON, AsyncLocalStorage e correlation id criados na Fase 1;
- mascarar/remover tokens, headers, payload e valores financeiros;
- instrumentar HTTP, SQS, transações, locks, workers e outbox com spans;
- criar métricas de baixa cardinalidade listadas na arquitetura;
- implementar liveness aberta e readiness PostgreSQL/SQS aberta;
- readiness usa deadline e não declara pronto durante shutdown;

### Subfase 12A — obrigatória

- completar logs JSON, métricas OpenTelemetry, traces OTLP e health checks;
- manter exporter assíncrono/não bloqueante e um endpoint Prometheus para validação;
- testar comportamento com o endpoint OTLP indisponível.

### Subfase 12B — P1, depois de a suíte distribuída estar verde

- criar `docker/compose.observability.yaml` e configurações em
  `docker/observability/` para Collector, Prometheus, Tempo, Loki, Alloy e Grafana;
- provisionar datasources e um dashboard mínimo de processamento/outbox.

### Testes/verificações

- logs contêm correlação e não contêm amount/token/payload;
- parar PostgreSQL ou LocalStack derruba readiness, não liveness;
- parar Collector não falha requisição financeira;
- na 12A, métricas são expostas e spans são exportados para um collector de teste;
- na 12B, métricas aparecem no Prometheus, trace HTTP → transação/outbox aparece no
  Tempo e logs correlatos aparecem no Loki/Grafana.

### Critério de aceite

- `docker compose --env-file .env -f docker/compose.yaml` funciona sem overlay;
- quando a 12B for executada, o overlay sobe toda a stack e não expõe backends além do
  necessário;
- ids de alta cardinalidade aparecem em logs/traces, nunca em labels de métrica.

---

## Fase 13 — Suíte distribuída e auditoria eliminatória

**Objetivo:** reunir evidência automatizada de que a solução funciona com falhas e três
processos, não apenas provar componentes isolados.

### Atividades

- criar harness que sobe banco/SQS limpos e três processos da aplicação;
- implementar os oito cenários obrigatórios da seção 13 do desafio;
- implementar failpoint pós-commit/pré-ack e encerramento real do processo;
- executar dois publishers reais;
- usar barreira de início para corridas e polling com timeout para resultados;
- criar helper SQL que audita wallet = ledger ao final de todo cenário;
- testar migrations e constraints também na pipeline completa;
- repetir cenários críticos várias vezes para detectar flakiness.

### Comando-alvo

```bash
bun run test:unit
bun run test:integration
bun run test:concurrency
```

### Checklist eliminatório

- [ ] nenhum `number` monetário;
- [ ] nenhum saldo negativo por race;
- [ ] nenhum débito/crédito duplicado;
- [ ] idempotência persiste após restart;
- [ ] três instâncias passam;
- [ ] nenhum evento é publicado antes do commit;
- [ ] ledger existe e é imutável;
- [ ] PostgreSQL e SQS reais são usados.

### Critério de aceite

- todos os cenários passam repetidamente;
- falha imprime correlation ids e estado suficiente para diagnóstico;
- não há timers/processos/containers órfãos após a suíte.

---

## Fase 14 — Documentação final, CI e apresentação

**Objetivo:** transformar a implementação validada em uma entrega reproduzível e
defensável tecnicamente.

### Atividades

- confirmar e completar o `README.md` com setup, comandos, endpoints, filas e
  troubleshooting, sem recolocar nele o enunciado preservado em `docs/CHALLENGE.md`;
- atualizar `ARCHITECTURE.md` de desenho-alvo para decisões realmente implementadas;
- registrar limitações e o que não foi executado, sem afirmar validação inexistente;
- incluir diagrama final e tabela requisito → teste;
- criar coleção HTTP/cURL de smoke test;
- configurar CI com Bun, lint, typecheck, unit e integração;
- rodar scan de segredos, revisar imagens/dependências e remover código temporário;
- registrar versões, máquina e duração da suíte de concorrência;
- preparar roteiro de demonstração: duplicata, corrida 80/80, out-of-order, crash e
  Grafana/reconciliação.

### Verificação final

```bash
git status --short
git diff --check
bun run lint
bun run typecheck
bun run test:unit
bun run test:integration
bun run test:concurrency
docker compose --env-file .env -f docker/compose.yaml config
# Executar somente se a subfase 12B tiver sido implementada:
docker compose --env-file .env -f docker/compose.yaml -f docker/compose.observability.yaml config
```

### Critério de aceite

- uma pessoa nova sobe e valida o projeto seguindo apenas o README;
- cada afirmação importante aponta para teste, constraint ou métrica;
- limitações são honestas e coerentes com o diff.

---

## Fase 15 — Opcional: autenticação OIDC

**Pré-condição:** fases 0–14 verdes e tempo realmente disponível.

### Atividades

- adicionar Keycloak em overlay/profile separado e importar realm/client de demo;
- implementar `AUTH_MODE=oidc` no `ProviderIdentityPort` já existente;
- validar JWT por issuer, audience, assinatura, expiração e JWKS;
- usar client credentials para providers;
- garantir que principal autenticado corresponda ao `providerId` da operação;
- implementar scopes, cache/rotação de JWKS e testes;
- manter health aberto e SQS como canal interno;
- documentar que `AUTH_MODE=none` é apenas desenvolvimento.

### Critério de aceite

- token ausente/inválido/expirado e provider divergente são rejeitados;
- rotação/indisponibilidade do IdP tem comportamento definido;
- ativar auth não altera o caso de uso financeiro.

Se não houver tempo para todos esses itens, não implementar uma versão parcial.

---

## Fase 16 — Opcional: teste de carga

**Pré-condição:** zero flakiness nos testes distribuídos obrigatórios.

### Atividades

- criar `bun run test:load` com cenário reproduzível;
- separar carga entre hot wallet e muitas wallets;
- aquecimento, janela de medição e cooldown;
- capturar throughput, p50/p95/p99, erros, lock conflicts e outbox lag;
- registrar hardware, número de instâncias, pool, volume de dados e limitações;
- não ajustar consistência para melhorar RPS.

## 4. Matriz de rastreabilidade

| Requisito do desafio | Implementação principal | Evidência |
|---|---|---|
| Money exato | Fases 2 e 4 | unitários + round-trip PostgreSQL |
| wallet/ledger | Fases 3–6 | constraints + integração |
| concorrência | Fases 6, 7 e 13 | corridas reais + três processos |
| idempotência | Fases 6 e 8 | 50 chamadas + redelivery/restart |
| referência fora de ordem | Fases 7 e 10 | pending → processed/rejected |
| SQS/inbox/DLQ | Fase 8 | LocalStack real + kill pós-commit |
| outbox | Fase 9 | publishers concorrentes + crash |
| reconciliação | Fase 11 | snapshot consistente + divergência |
| observabilidade | Fase 12 | logs, Prometheus, Tempo, Loki e health |
| testes obrigatórios | Fase 13 | suíte distribuída completa |
| documentação | Fases 0 e 14 | setup, arquitetura, limites e demo |
| autenticação opcional | Fase 15 | OIDC externo ou decisão documentada |

## 5. Gate final antes dos diferenciais

Só avançar para autenticação ou carga quando todas as respostas forem “sim”:

- a mesma operação repetida após restart devolve o snapshot original?
- duas apostas de 80 sobre 100 terminam em 20 com um ledger?
- três processos concorrentes mantêm wallet igual ao ledger?
- REFUND/ROLLBACK antes da referência termina corretamente depois?
- crash pós-commit/pré-ack não duplica saldo?
- crash pós-commit/pré-publicação não perde evento?
- dois publishers e dois workers não perdem trabalho?
- migrations sobem/descem e constraints resistem a SQL direto?
- logs/métricas permitem explicar uma falha sem revelar valor financeiro?
- o projeto sobe do zero apenas com os comandos documentados?

Se qualquer resposta for “não”, o próximo trabalho pertence à fase correspondente,
não aos diferenciais.
