// SQL extraído de /tmp/ex4.py — mesma camada semântica do snapshot.
module.exports = {
  dias: `select created_at::date dia, canal, canal_aq, sistema, categoria,
 count(*) pedidos, count(distinct coalesce(cid,email)) clientes,
 round(sum(bruto)::numeric,2) bruto, round(sum(desconto)::numeric,2) desc_,
 round(sum(reembolso)::numeric,2) reemb, round(sum(liquido)::numeric,2) liq,
 round(sum(cmv)::numeric,2) cmv, round(sum(margem)::numeric,2) marg,
 sum((cmv_ok)::int) cmv_ok,
 sum((coalesce(basis,'session') in ('session','landing'))::int) med,
 sum((basis='inherited')::int) inf
from core.vw_app_pedido where created_at>='2026-01-01' group by 1,2,3,4,5`,
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
  am_dias: `with am as (select coalesce(cid,email) k,min(created_at) p from core.vw_app_pedido where categoria='amostra' group by 1),
pr as (select coalesce(cid,email) k,min(created_at) p from core.vw_app_pedido where categoria<>'amostra' group by 1)
select round(avg(extract(day from pr.p-am.p))) media,
 round(percentile_cont(0.5) within group (order by extract(day from pr.p-am.p))) mediana,
 count(*) n from am join pr using(k) where pr.p>am.p`,
  am_mes: `with am as (select coalesce(cid,email) k,min(created_at) p from core.vw_app_pedido where categoria='amostra' group by 1),
pr as (select coalesce(cid,email) k,min(created_at) p,(array_agg(categoria order by created_at))[1] cat
 from core.vw_app_pedido where categoria<>'amostra' group by 1)
select to_char(date_trunc('month',am.p),'YYYY-MM') mes,count(*) amostras,
 sum((pr.k is not null)::int) conv, sum((pr.cat='novo_assinatura')::int) conv_assin
from am left join pr on pr.k=am.k and pr.p>am.p group by 1 order by 1`,
  spend: `select dia,fonte,round(sum(custo)::numeric,2) custo,max(origem_do_custo) origem from core.vw_mvp_custo_dia where dia>='2026-01-01' group by 1,2`,
  saude: `select fonte,tipo,sla_horas,idade_horas,status,linhas from core.vw_pipeline_saude`,
  fontes: `select fonte_bruta,canal,subcanal,pago from core.fonte_canonica`,
  pcusto: `select sku,descricao,tipo_produto,custo_unitario,confianca from commerce.produto_custo`,
  params: `select chave,valor,unidade,observacao from commerce.parametros_financeiros`,
  churn: `with mens as (select coalesce(cid,email) k, date_trunc('month',created_at)::date mes
  from core.vw_app_pedido where categoria in ('recorrente','novo_assinatura','antigo_inicio_assinatura') group by 1,2),
m as (select mes, count(distinct k) ativos from mens group by 1),
d as (select a.mes, count(*) n from mens a
  where not exists(select 1 from mens b where b.k=a.k and b.mes>a.mes)
    and a.mes < (select max(mes) from mens) group by 1)
select to_char(m.mes,'YYYY-MM') mes, m.ativos::int, coalesce(d.n,0)::int perdidos,
 round(100.0*coalesce(d.n,0)/m.ativos,1) churn_pct
from m left join d on d.mes=m.mes where m.mes < (select max(mes) from mens) order by 1`,
  camp: `select campanha, conjunto, ids_no_nome, de, ate, spend, impr, cliques,
 compras_plat, receita_plat, ped_total, rec_total, ped_amostra, rec_amostra,
 ped_aquisicao, rec_aquisicao, assin_novo, marg_total, marg_aquisicao
from core.vw_campanha_dia
where spend>0 or ped_total>0`,
  sess: `select dia, canal, canal_aq, categoria, sessoes, dias, primeira_sessao, pedidos, receita
from core.vw_sessoes_ate_compra`,
  // PAYBACK REAL. cac_aprox = gasto do mes / clientes cuja 1a compra PAGA foi atribuida ao canal
  // naquele mes. Nao usa is_new_customer (aquele campo conta quem so tinha amostra e inflou
  // a contagem 156 vs 53 em julho, produzindo um CAC 5x otimista).
  payback: `select mes, canal, clientes, idade_dias, spend, cac_aprox,
 ltv_30, ltv_90, ltv_180, margem_180_por_cliente, margem_sobre_cac_180, payback_meses
from core.vw_payback_coorte order by mes, canal`,
  // Custo real por amostra: gasto das campanhas que ENTREGAM amostra (ped_amostra>aquisicao)
  // dividido pelas amostras que elas entregaram. Substitui o R$ 9,32 hardcoded que era falso.
  amcusto: `with t as (select to_char(dia,'YYYY-MM') mes, campanha, sum(spend) sp,
   sum(coalesce(ped_amostra,0)) am, sum(coalesce(pedidos_aquisicao,0)) aq
  from core.vw_criativo_dia group by 1,2)
select mes, round((sum(sp) filter (where am>aq))::numeric,2) spend_am,
 coalesce(sum(am) filter (where am>aq),0)::int am_atrib,
 round((sum(sp) filter (where am>aq)/nullif(sum(am) filter (where am>aq),0))::numeric,2) custo_por_amostra
from t group by 1 order by 1`,
};
