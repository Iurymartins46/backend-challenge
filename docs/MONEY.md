# Representação de dinheiro

## Contrato

Dinheiro entra e sai da aplicação como string decimal e moeda ISO-4217:

```json
{ "amount": "25.00", "currency": "BRL" }
```

O desafio fixa duas casas decimais. Internamente, `Money` armazena centavos em
`bigint`; PostgreSQL usa `BIGINT` e `CHAR(3)`.

| Contrato | Domínio/persistência |
|---|---:|
| `"0.00"` | `0n` |
| `"0.01"` | `1n` |
| `"25.00"` | `2500n` |
| `"1000.99"` | `100099n` |

## Regras

- nunca usar `number`, `parseFloat`, `parseInt` ou coerção numérica;
- formato canônico: `^(0|[1-9][0-9]*)\.[0-9]{2}$`;
- rejeitar vazio, espaços, vírgula, notação científica e casas diferentes de duas;
- `Money` pode representar sinal negativo internamente para `negate()` e diferença de
  reconciliação;
- DTOs de entrada rejeitam negativos;
- `0.00` é válido para saldo inicial, mas operações externas exigem valor positivo;
- operações entre moedas diferentes lançam erro de domínio;
- toda operação retorna uma nova instância.

Parsing ocorre por manipulação de string: separar parte inteira e centavos, concatenar
e chamar `BigInt`. Serialização usa divisão/resto de `bigint` e sempre preenche duas
casas.

## TypeORM

O driver PostgreSQL normalmente devolve `BIGINT` como string. Entidades de persistência
devem tipar a coluna como string; o mapper converte com `BigInt(value)`. Um transformer
que passe por `number` é proibido.

Colunas monetárias terminam em `_minor`, por exemplo `balance_minor` e `amount_minor`.

## Por que não `NUMERIC` ou PostgreSQL `MONEY`?

`NUMERIC(p,s)` também é exato e seria a escolha para escalas variáveis. Para escala 2,
centavos inteiros simplificam domínio, constraints e testes. O tipo PostgreSQL `MONEY`
não será usado porque sua apresentação depende de locale e ele não representa a moeda
ISO como parte do valor.

## Testes mínimos

- valores zero, mínimo, grande e limite de `BIGINT`;
- formato inválido e ausência de arredondamento (`1.005` é erro);
- soma, subtração, negação, comparação e imutabilidade;
- conflito de moeda;
- round-trip pelo PostgreSQL sem perda de precisão.
