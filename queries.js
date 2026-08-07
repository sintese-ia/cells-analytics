// SQL extraído de /tmp/ex4.py — mesma camada semântica do snapshot.
module.exports = {
  // `ks` = ids densos das identidades do grupo. Sem isso o app somava count(distinct) de cada
  // grupo para achar "clientes unicos", e quem compra em cinco dias contava cinco vezes: no ano
  // de 2026 dava 1.053 contra 624 reais (+69%), e Receita por cliente saia 41% subestimada.
  // Com o array o app faz a uniao real por periodo/filtro. Sao ~2,2 mil pedidos no historico
  // inteiro — o custo de payload e irrelevante perto de errar o numero.
  // Piso em 2025-01-01: o banco comeca em 16/01/2025 e o painel so enxergava 2026, entao o total
  // de clientes nunca podia fechar (1.206 pagantes no historico, 1.391 com amostra).
  dias: `with b as (
 select created_at, canal, canal_aq, sistema, categoria, bruto, desconto, reembolso,
        liquido, cmv, margem, cmv_ok, basis,
        dense_rank() over (order by coalesce(cid,email)) kid
   from core.vw_app_pedido where created_at>='2025-01-01')
select created_at::date dia, canal, canal_aq, sistema, categoria,
 count(*) pedidos, count(distinct kid) clientes, array_agg(distinct kid) ks,
 round(sum(bruto)::numeric,2) bruto, round(sum(desconto)::numeric,2) desc_,
 round(sum(reembolso)::numeric,2) reemb, round(sum(liquido)::numeric,2) liq,
 round(sum(cmv)::numeric,2) cmv, round(sum(margem)::numeric,2) marg,
 sum((cmv_ok)::int) cmv_ok,
 sum((coalesce(basis,'session') in ('session','landing'))::int) med,
 sum((basis='inherited')::int) inf
from b group by 1,2,3,4,5`,
  plat: `select date_start::date dia,
 sum((select (a->>'value')::numeric from jsonb_array_elements(actions::jsonb) a where a->>'action_type'='purchase')) compras,
 round(sum((select (v->>'value')::numeric from jsonb_array_elements(action_values::jsonb) v where v->>'action_type'='purchase'))::numeric,2) receita
 from ads.meta_ads_raw where date_start>='2026-01-01' group by 1`,
  adsets: `select adset_name adset,to_char(dia,'YYYY-MM') mes,round(sum(spend)::numeric,2) spend,
 sum(pedidos_aquisicao) ped,round(sum(receita)::numeric,2) rec,round(sum(margem)::numeric,2) marg
 from core.vw_criativo_dia where dia>='2026-01-01' group by 1,2 having sum(spend)>0 or sum(pedidos_aquisicao)>0`,
  heat: `with p as (select coalesce(cid,email) k,min(created_at) prim,(array_agg(canal_aq order by created_at))[1] canal,
  (array_agg(categoria order by created_at))[1] cat1 from core.vw_app_pedido where categoria<>'amostra' group by 1)
select to_char(date_trunc('month',p.prim),'YYYY-MM') co, p.canal, p.cat1,
 ((extract(year from o.created_at)-extract(year from p.prim))*12
  +(extract(month from o.created_at)-extract(month from p.prim)))::int mn,
 count(distinct p.k) cli, count(*) ped, round(sum(o.liquido)::numeric,2) rec
from p join core.vw_app_pedido o on coalesce(o.cid,o.email)=p.k and o.categoria<>'amostra'
group by 1,2,3,4`,
  cbase: `with p as (select coalesce(cid,email) k,min(created_at) prim,(array_agg(canal_aq order by created_at))[1] canal,
  (array_agg(categoria order by created_at))[1] cat1 from core.vw_app_pedido where categoria<>'amostra' group by 1)
select to_char(date_trunc('month',prim),'YYYY-MM') co,canal,cat1,count(*) cli,
 round(avg(extract(day from now()-prim))) idade from p group by 1,2,3`,
  jor: `with ini as (select coalesce(cid,email) k, min(created_at) inicio
  from core.vw_app_pedido where categoria in ('novo_assinatura','antigo_inicio_assinatura') group by 1),
rv as (select coalesce(cid,email) k, count(*) n from core.vw_app_pedido where categoria='recorrente' group by 1),
am as (select coalesce(cid,email) k, min(created_at) p from core.vw_app_pedido where categoria='amostra' group by 1),
pr as (select coalesce(cid,email) k, min(created_at) p, (array_agg(categoria order by created_at))[1] cat
  from core.vw_app_pedido where categoria<>'amostra' group by 1),
e as (select coalesce(cid,email) k, created_at, categoria,
  row_number() over (partition by coalesce(cid,email) order by created_at) rn
  from core.vw_app_pedido where categoria<>'amostra'),
mens as (select coalesce(cid,email) k, date_trunc('month',created_at)::date mes
  from core.vw_app_pedido where categoria in ('recorrente','novo_assinatura','antigo_inicio_assinatura') group by 1,2)
select 'am_total' e, count(*)::int n, 0::numeric v from am
union all select 'am_sem', count(*)::int, 0 from am left join pr on pr.k=am.k and pr.p>am.p where pr.k is null
union all select 'am_avulso', count(*)::int, 0 from am join pr on pr.k=am.k and pr.p>am.p where pr.cat='novo_avulso'
union all select 'am_assin', count(*)::int, 0 from am join pr on pr.k=am.k and pr.p>am.p where pr.cat='novo_assinatura'
union all select 'p1_avulsa', count(*)::int, 0 from e where rn=1 and categoria='novo_avulso'
union all select 'p1_sem_recompra', count(*)::int, 0 from (select k from e where rn=1 and categoria='novo_avulso' and k not in (select k from e where rn>1)) t
union all select 'p1_2a_avulsa', count(distinct b.k)::int, 0 from e a join e b on b.k=a.k and b.rn=2 and b.categoria like '%avulso' where a.rn=1 and a.categoria='novo_avulso'
union all select 'p1_para_assin', count(distinct b.k)::int, 0 from e a join e b on b.k=a.k and b.rn>1 and b.categoria='antigo_inicio_assinatura' where a.rn=1 and a.categoria='novo_avulso'
-- CURVA DE ASSINATURA: pessoas, com inicio registrado, e SO coorte madura o suficiente
union all select 'assin_base1', count(*)::int, 0 from ini where now()-inicio > interval '35 days'
union all select 'assin_ren1', count(*)::int, 0 from ini left join rv using(k) where now()-inicio > interval '35 days' and coalesce(rv.n,0)>=1
union all select 'assin_base2', count(*)::int, 0 from ini where now()-inicio > interval '65 days'
union all select 'assin_ren2', count(*)::int, 0 from ini left join rv using(k) where now()-inicio > interval '65 days' and coalesce(rv.n,0)>=2
union all select 'assin_base3', count(*)::int, 0 from ini where now()-inicio > interval '95 days'
union all select 'assin_ren3', count(*)::int, 0 from ini left join rv using(k) where now()-inicio > interval '95 days' and coalesce(rv.n,0)>=3
union all select 'assin_ini_total', count(*)::int, 0 from ini
union all select 'woo_sem_inicio', count(distinct coalesce(cid,email))::int, 0 from core.vw_app_pedido where sistema='woocommerce'
union all select 'falha', count(*)::int, round(sum(total)::numeric,2) from commerce.woo_orders where status='failed'
union all select 'voltou_apos_falha', count(*)::int, 0 from mens a
  where not exists(select 1 from mens b where b.k=a.k and b.mes=a.mes+interval '1 month')
    and exists(select 1 from mens c where c.k=a.k and c.mes>a.mes+interval '1 month')`,
  spend: `select dia,fonte,round(sum(custo)::numeric,2) custo,max(origem_do_custo) origem from core.vw_mvp_custo_dia where dia>='2026-01-01' group by 1,2`,
  saude: `select fonte,tipo,sla_horas,idade_horas,status,linhas from core.vw_pipeline_saude`,
  fontes: `select fonte_bruta,canal,subcanal,pago from core.fonte_canonica`,
  pcusto: `select sku,descricao,tipo_produto,custo_unitario,confianca from commerce.produto_custo`,
  params: `select chave,valor,unidade,observacao from commerce.parametros_financeiros`,
  // GRAO DE DIA, nao de periodo. `vw_campanha_dia` (nome mentiroso) agrupa por campanha+conjunto
  // sem dia e expoe min(date_start)/max(date_stop); a tela filtrava por SOBREPOSICAO e somava a
  // campanha INTEIRA em qualquer janela que encostasse nela. Em 06/08/2026, numa leitura de 7 dias:
  // gasto R$ 12.385 contra R$ 3.630 reais (+241%) e CAC R$ 179,50 pintado de VERDE onde o real era
  // R$ 605,02. Ver cells-infra/fixes/2026-08-06-vw-campanha-dia-real.sql.
  camp: `select dia, campanha, conjunto, ids_no_nome, spend, impr, cliques,
 compras_plat, receita_plat, ped_total, rec_total, ped_amostra, rec_amostra,
 ped_aquisicao, rec_aquisicao, assin_novo, marg_total, marg_aquisicao
from core.vw_campanha_dia_real
where spend>0 or ped_total>0`,
  // PAYBACK REAL. cac_aprox = gasto do mes / clientes cuja 1a compra PAGA foi atribuida ao canal
  // naquele mes. Nao usa is_new_customer (aquele campo conta quem so tinha amostra e inflou
  // a contagem 156 vs 53 em julho, produzindo um CAC 5x otimista).
  payback: `select mes, canal, clientes, idade_dias, spend, cac_aprox,
 ltv_30, ltv_90, ltv_180, margem_180_por_cliente, margem_sobre_cac_180, payback_meses
from core.vw_payback_coorte order by mes, canal`,
  // --- Semanal / realizado x projetado (04/08/2026) ---
  k7:   `select * from core.vw_kpi_7d where ate >= current_date - 90 order by ate`,
  ksem: `select * from core.vw_kpi_semana where semana >= current_date - 120 order by semana`,
  kmes: `select * from core.vw_kpi_mes where mes >= '2026-05-01' order by mes`,
  plano:`select * from core.plano_mes order by mes`,
  // Objetivo DECLARADO do conjunto, com vigencia — intencao nao se deduz do resultado.
  // Conjunto de amostra e julgado por custo por amostra, nunca por CAC: o CJ_kit_exp aparecia
  // com CAC de R$ 940 pintado de vermelho e nunca tentou comprar cliente direto.
  // DDL e a classificacao em cells-infra/fixes/2026-08-07-campanha-objetivo.sql.
  objetivo: `select dia, conjunto, objetivo, classificado
 from core.vw_campanha_objetivo_dia where dia >= current_date - 90`,
  // --- Grid de midia: canal > campanha > conjunto > anuncio ---
  grid: `select dia, canal, campanha, conjunto, coalesce(anuncio,'(sem anuncio)') anuncio,
   nao_identificado, spend, impressoes, ob_clicks, plat_lpv, plat_atc, plat_checkout,
   plat_compras, pedidos, nc_pedidos, receita, nc_receita, conta, margem, nc_margem
  from core.vw_ads_metricas_dia where dia >= current_date - 60 order by dia`,
};
