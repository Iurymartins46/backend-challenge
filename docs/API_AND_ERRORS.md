# API, Swagger e contrato de erros

## 1. Swagger

O bootstrap configura `@nestjs/swagger`:

- interface em `GET /docs`;
- OpenAPI JSON em `GET /docs-json`;
- health marcado como público;
- DTOs compartilhados de dinheiro, sucesso e erro;
- exemplos de request/response;
- descrição dos códigos de erro que cada endpoint pode retornar.

Cada alteração que adiciona uma rota deve adicionar, na mesma mudança, seus schemas,
exemplos, respostas de sucesso e erros. O Swagger não deve ser escrito somente no fim.

## 2. Formato padrão

O desafio não exige RFC 9457/Problem Details. Para manter o contrato simples, erros
HTTP usam `application/json` e este formato próprio:

```json
{
  "status": 422,
  "title": "Transaction rejected",
  "detail": "The transaction could not be processed.",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "errors": [
    {
      "code": "error.wager.insufficient_funds",
      "detail": "The wallet does not have sufficient funds for this bet."
    }
  ]
}
```

Campos obrigatórios:

| Campo | Uso |
|---|---|
| `status` | repete o status HTTP para facilitar clientes e logs persistidos |
| `title` | resumo curto da categoria para humanos |
| `detail` | resumo seguro desta ocorrência |
| `traceId` | correlação direta com o trace e os logs da requisição |
| `errors` | lista não vazia com os códigos e detalhes que o cliente deve tratar |

O cliente toma decisões por `status` e `errors[].code`. `title`, `detail` e os detalhes
dos itens são informativos e podem ser melhorados sem quebrar integrações.

Cada item de `errors` possui:

| Campo | Obrigatório | Uso |
|---|---|---|
| `code` | sim | identificador estável e legível por máquina |
| `detail` | sim | explicação segura daquele erro |
| `field` | não | caminho do campo quando o erro pertence a uma entrada específica |

Uma resposta de erro nunca retorna `errors: []`. Sucessos usam seus próprios DTOs e não
incluem esse array.

## 3. Convenção dos códigos

Códigos usam letras minúsculas, segmentos separados por ponto e nomes em `snake_case`:

```text
error.<contexto>.<motivo>
```

Exemplos:

```text
error.request.invalid_json
error.request.idempotency_key_required
error.money.invalid_format
error.money.invalid_scale
error.money.invalid_currency
error.money.negative
error.money.out_of_range
error.money.currency_mismatch
error.wallet.not_found
error.wallet.already_exists
error.idempotency.payload_conflict
error.wager.external_transaction_conflict
error.wager.wallet_context_mismatch
error.wager.transaction_not_found
error.wager.insufficient_funds
error.wager.reversal_negative_balance
error.wager.reference_not_found
error.wager.reference_amount_mismatch
error.infrastructure.dependency_unavailable
```

Regras:

- o significado de um código publicado não pode mudar;
- códigos não carregam texto variável, ids ou nomes de campos;
- um código novo deve ser adicionado ao Swagger com descrição, status e orientação de
  retry/correção;
- mensagens internas, SQL, stack trace e detalhes de infraestrutura não são expostos;
- os mesmos códigos são reutilizados no HTTP e, quando fizer sentido, como
  `failureCode` persistido na transação.

No Swagger, cada código deve informar:

| Código | HTTP | Significado | Ação do cliente |
|---|---:|---|---|
| `error.money.invalid_scale` | 400 | amount não possui exatamente duas casas | corrigir payload |
| `error.money.negative` | 400 | contrato externo não aceita valor negativo | enviar valor não negativo |
| `error.money.out_of_range` | 400 | amount excede o BIGINT suportado em centavos | corrigir o valor |
| `error.idempotency.payload_conflict` | 409 | mesma chave foi usada com outro payload | corrigir chave/payload |
| `error.wager.external_transaction_conflict` | 409 | mesmo external id do provedor já foi usado | usar a transação original ou outro external id |
| `error.wager.wallet_context_mismatch` | 422 | player ou moeda não correspondem à wallet | corrigir o contexto da wallet |
| `error.wager.transaction_not_found` | 404 | transação de aposta inexistente | conferir o identificador |
| `error.wager.insufficient_funds` | 422 | saldo insuficiente para a BET | não repetir sem mudança de saldo |
| `error.wager.reference_not_found` | 422 | referência não apareceu dentro do limite | enviar/disponibilizar a referência |
| `error.infrastructure.dependency_unavailable` | 503 | dependência temporariamente indisponível | respeitar `Retry-After` |

As regras de referência também usam os códigos estáveis
`error.wager.reference_invalid_kind`, `error.wager.reference_context_mismatch` e
`error.wager.reversal_already_processed`, todos com HTTP 422. O primeiro indica uma
operação incompatível com o tipo da referência; o segundo indica divergência de
provider, player, wallet, rodada, jogo ou moeda; o terceiro indica que a mesma
referência já foi revertida pelo mesmo tipo.

Assim, não é necessário enviar `retryable` em todas as respostas: a regra pertence à
documentação estável de `errors[].code`. Para indisponibilidade transitória, o header HTTP
`Retry-After` informa quando repetir.

## 4. Rejeição de uma transação persistida

Quando a operação foi aceita, persistida e terminou como `REJECTED`, retornar também o
`transactionId`. Ele permite consulta posterior e suporte operacional, mas não faz
parte do erro-base.

Esse endpoint também mantém `idempotentReplay`, pois o desafio exige distinguir a
primeira submissão de um replay. O campo é específico do resultado de submissão de uma
transação, não de todos os erros da API.

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/json
```

```json
{
  "status": 422,
  "title": "Transaction rejected",
  "detail": "The transaction could not be processed.",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "idempotentReplay": false,
  "errors": [
    {
      "code": "error.wager.insufficient_funds",
      "detail": "The wallet does not have sufficient funds for this bet."
    }
  ]
}
```

Não retornar `balance`: ele não é necessário para identificar ou tratar o erro e
amplia desnecessariamente a resposta. O saldo pode ser consultado no endpoint da wallet
por quem tiver autorização.

## 5. Validação com mais de um erro

Toda resposta de erro usa o mesmo array. Quando houver somente um problema, `errors`
contém um item. Quando uma requisição tiver vários problemas independentes, todos são
retornados no mesmo array.

```json
{
  "status": 400,
  "title": "Invalid request",
  "detail": "One or more fields are invalid.",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "errors": [
    {
      "field": "money.amount",
      "code": "error.money.invalid_scale",
      "detail": "Amount must contain exactly two decimal places."
    },
    {
      "field": "money.currency",
      "code": "error.money.invalid_currency",
      "detail": "Currency must be a valid ISO-4217 code."
    }
  ]
}
```

Não retornar array vazio. Erros sem associação com um campo, como conflito de
idempotência ou saldo insuficiente, simplesmente omitem `field` no item.

## 6. Infraestrutura transitória

```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/json
Retry-After: 2
```

```json
{
  "status": 503,
  "title": "Dependency unavailable",
  "detail": "The operation could not be completed at this time.",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "errors": [
    {
      "code": "error.infrastructure.dependency_unavailable",
      "detail": "A required dependency is temporarily unavailable."
    }
  ]
}
```

## 7. Campos que não fazem parte do erro-base

| Campo removido | Motivo |
|---|---|
| `type` | exigiria manter uma taxonomia de URIs; `errors[].code` já identifica o erro |
| `code` no nível superior | todos os códigos ficam em `errors`, sempre no mesmo local |
| `correlationId` | `traceId` cumpre a mesma finalidade sem duplicação |
| `timestamp` | o HTTP já possui `Date`, e logs/traces registram o instante exato |
| `retryable` | a política fica documentada por `errors[].code`; 503 usa `Retry-After` |
| `idempotentReplay` | pertence apenas ao resultado de submissão exigido pelo desafio, não ao erro-base |
| `balance` | não é necessário para identificar/tratar o erro |

`transactionId` é uma extensão opcional somente para erros associados a uma transação
persistida. `idempotentReplay` é específico da submissão de transações. `errors` é
obrigatório e deve conter pelo menos um item em toda resposta de erro.

## 8. Evolução do contrato

A base do contrato contém:

- `ErrorResponseDto`;
- `ErrorItemDto`, com `code`, `detail` e `field` opcional;
- filtro global de exceções;
- extração do `traceId` ativo do OpenTelemetry;
- schemas e exemplos base no Swagger.

O mesmo `ErrorResponseDto` atende validação, domínio, conflito e infraestrutura. Cada
módulo adiciona seus códigos ao catálogo e acrescenta somente campos opcionais já
previstos, como `transactionId` ou `idempotentReplay`. Não criar formatos paralelos.

`POST /wagering/transactions` aceita `BET`, `WIN`, `LOSS`, `REFUND` e
`ROLLBACK`. `WIN` pode informar uma referência opcional; `REFUND` exige referência de
`BET`, e `ROLLBACK` exige referência de `BET`, `WIN` ou `REFUND`. A chave do header é
arbitrada com o par `(providerId, idempotencyKey)` no PostgreSQL e o hash
SHA-256 usa o payload de negócio canonizado em RFC 8785; header e metadados de
transporte ficam fora do hash. Uma primeira operação processada retorna `201`, replay
idêntico retorna `200`, rejeição persistida retorna `422` com `transactionId` e
`idempotentReplay`, e falha transitória após retry retorna `503` com `Retry-After`.

Quando a referência ainda não existe, a operação é persistida como `PENDING_REFERENCE`,
emite `WagerTransactionPendingReference` pela outbox e retorna `202`. Uma nova
submissão idêntica pode resolver a pendência depois que a referência for confirmada.

`GET /wagering/transactions/:transactionId` e
`GET /providers/:providerId/wagering/transactions/:externalTransactionId` expõem um
DTO de leitura, nunca a entidade TypeORM.

`POST /wallets/:walletId/reconciliation` retorna `200` com
`storedBalance`, `calculatedBalance`, `difference` assinada, `consistent` e
`checkedEntries`. Wallet inexistente retorna `404/error.wallet.not_found`; uma
indisponibilidade transitória do PostgreSQL retorna `503` com
`error.infrastructure.dependency_unavailable` e `Retry-After`. A rota nunca corrige a
wallet nem o ledger.

Mapeamento inicial:

| Situação | HTTP |
|---|---:|
| recurso criado/processado | `201` |
| replay idempotente | `200` |
| aguardando referência | `202` |
| validação/header inválido | `400` |
| inexistente | `404` |
| duplicata/idempotência divergente | `409` |
| rejeição persistida de domínio | `422` |
| dependência transitória após retries | `503` |
