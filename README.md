# Cells Analytics

Painel de analytics B2C da Cells. Le as views do Postgres **ao vivo** e serve o app
protegido por senha (checagem server-side — o HTML nao sai sem o cookie).

## Variaveis de ambiente

| Var | Exemplo | Nota |
|---|---|---|
| `DATABASE_URL` | `postgresql://user:pass@bancodados:5432/dadoscells` | dentro do Easypanel o host e o **nome do servico** |
| `SENHA` | `turbo` | senha unica de acesso |
| `CACHE_MIN` | `10` | minutos de cache das queries |
| `PORT` | `3000` | |

## Camada semantica

Nao ha SQL de negocio aqui: as queries em `queries.js` leem as views de `core.*`
(`vw_app_pedido`, `vw_margem_pedido`, `vw_ltv_coorte`, `vw_criativo_dia`,
`vw_mvp_custo_dia`, `vw_pipeline_saude`, `fonte_canonica`, `produto_custo`).
Definicao de metrica muda na view, nao no app.

## Comportamento em falha

Se o banco cair: serve o ultimo dado bom em cache e marca no header
`x-cells-degradado: 1`. Sem cache, mostra tela de erro explicita —
nunca numero errado ou velho sem aviso.

## Gate obrigatório antes de qualquer deploy

```bash
node smoke.js              # com dado real (precisa alcançar bancodados:5432)
node smoke.js --offline     # todas as views vazias — é o que o CI roda
```

O gate faz três coisas:

1. **Valida a sintaxe do `<script>` do template.** `node --check` não olha dentro do HTML.
   Em 30/07/2026 o painel foi ao ar com `SyntaxError` porque um bloco removido deixou um
   template literal aberto — o app subiu e serviu página em branco.
2. **Renderiza as 9 telas em 16–27 cenários de filtro** (canal, grupo, categoria, período,
   modelo de atribuição, bruto/líquido, combinações, e casos que devolvem conjunto vazio).
3. **Rejeita `undefined`, `NaN`, `Infinity` e `[object Object]`** no HTML gerado.

O modo `--offline` é o que o GitHub Actions consegue rodar: o Postgres só responde na rede
interna do Easypanel. Antes de mexer em qualquer **número**, rodar sem `--offline` é obrigatório.

## Regra de métrica

Métrica muda na **view** (`core.*`), não no app. Nada de constante de negócio hardcoded no
template: o `CAC de amostra` esteve fixo em `R$ 9,32` — valor que vinha do bug do
`is_new_customer` e era ~14x menor que o real. Hoje vem de `core.vw_criativo_dia`.
