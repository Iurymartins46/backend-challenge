# Mapa da documentação

Esta pasta aprofunda contratos e aspectos operacionais do projeto. Ela não substitui o
guia de primeira execução nem mistura o enunciado original com as decisões tomadas na
implementação.

## Onde procurar cada informação

| Documento                                                      | Papel                                                                                      | Público principal                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| [`../README.md`](../README.md)                                 | Instalação do zero, primeira execução, endpoints e todos os comandos do `package.json`.    | Quem abriu o repositório pela primeira vez. |
| [`CHALLENGE.md`](CHALLENGE.md)                                 | Enunciado e critérios originais do desafio. Deve permanecer como referência de requisitos. | Avaliador e pessoa desenvolvedora.          |
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md)                     | Decisões importantes, alternativas, motivos, trade-offs, limitações e riscos.              | Avaliador e manutenção técnica.             |
| [`API_AND_ERRORS.md`](API_AND_ERRORS.md)                       | Contrato HTTP, Swagger, autenticação e envelope de erros.                                  | Integrações e frontend.                     |
| [`MONEY.md`](MONEY.md)                                         | Representação monetária entre API, domínio, TypeORM e PostgreSQL.                          | Domínio e persistência.                     |
| [`DATABASE.md`](DATABASE.md)                                   | Tabelas, constraints, transações, locks, snapshots e migrations.                           | Backend e banco de dados.                   |
| [`MESSAGING.md`](MESSAGING.md)                                 | SQS, inbox, outbox, ack, redelivery, leases e referências fora de ordem.                   | Backend e operação.                         |
| [`OBSERVABILITY.md`](OBSERVABILITY.md)                         | Logs, métricas, traces, health e overlay visual.                                           | Operação e diagnóstico.                     |
| [`TESTING.md`](TESTING.md)                                     | O que cada nível de teste prova e como executar infraestrutura real.                       | Desenvolvimento e avaliação.                |
| [`LOAD_TEST.md`](LOAD_TEST.md)                                 | Metodologia, configuração e interpretação do experimento de carga.                         | Performance e avaliação.                    |
| [`DELIVERY.md`](DELIVERY.md)                                   | Rastreabilidade requisito → implementação → evidência e registro da validação executada.   | Avaliador.                                  |
| [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)             | Histórico das fases e critérios usados para construir a solução.                           | Manutenção e contexto histórico.            |
| [`../docker/README.md`](../docker/README.md)                   | Imagens, serviços, volumes, overlays Compose e limitações locais.                          | Desenvolvimento e operação local.           |
| [`../tests/http/curl/README.md`](../tests/http/curl/README.md) | Pré-requisitos e escopo do smoke HTTP com cURL.                                            | Desenvolvimento e avaliação rápida.         |

## Trilhas de leitura

### Primeira avaliação

1. `README.md`: execute a aplicação e o smoke HTTP.
2. `ARCHITECTURE.md`: entenda decisões e limitações.
3. `DELIVERY.md`: relacione requisitos com evidências.
4. `TESTING.md`: diferencie testes unitários de provas reais/distribuídas.

### Manutenção de uma regra financeira

1. confirme o requisito em `CHALLENGE.md`;
2. revise a decisão em `ARCHITECTURE.md`;
3. consulte `MONEY.md`, `DATABASE.md` e/ou `MESSAGING.md`;
4. atualize contrato, implementação e testes na mesma mudança;
5. registre nova evidência em `DELIVERY.md` apenas depois de executá-la.

## Hierarquia das fontes

- `CHALLENGE.md` diz **o que foi pedido**.
- `ARCHITECTURE.md` diz **por que a solução escolheu este desenho**.
- Os documentos temáticos dizem **como cada contrato funciona**.
- `README.md` diz **como executar e verificar**.
- Código, migrations e testes mostram **o que está implementado e provado**.
- `DELIVERY.md` registra uma execução passada; números de versão, tempo e performance
  não devem ser tratados como medição atual sem nova execução.

Se dois documentos divergirem, não escolha silenciosamente um deles. Confirme o
comportamento no contrato executável e corrija a documentação na mesma alteração.
