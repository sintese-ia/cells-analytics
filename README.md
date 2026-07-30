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
