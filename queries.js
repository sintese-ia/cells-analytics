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
  jor: `with am as (select coalesce(cid,email) k,min(created_at) p from core.vw_app_pedido where categoria='amostra' group by 1),
pr as (select coalesce(cid,email) k,min(created_at) p,(array_agg(categoria order by created_at))[1] cat
 from core.vw_app_pedido where categoria<>'amostra' group by 1),
e as (select coalesce(cid,email) k,created_at,categoria,liquido,
 row_number() over (partition by coalesce(cid,email) order by created_at) rn
 from core.vw_app_pedido where categoria<>'amostra'),
rv as (select coalesce(cid,email) k,row_number() over (partition by coalesce(cid,email) order by created_at) r
 from core.vw_app_pedido where categoria='recorrente')
select 'am_total' e,count(*) n,0::numeric v from am
union all select 'am_sem',count(*),0 from am left join pr on pr.k=am.k and pr.p>am.p where pr.k is null
union all select 'am_avulso',count(*),0 from am join pr on pr.k=am.k and pr.p>am.p where pr.cat='novo_avulso'
union all select 'am_assin',count(*),0 from am join pr on pr.k=am.k and pr.p>am.p where pr.cat='novo_assinatura'
union all select 'p1_avulsa',count(*),round(sum(liquido)::numeric,2) from e where rn=1 and categoria='novo_avulso'
union all select 'p1_sem_recompra',count(*),0 from (select k from e where rn=1 and categoria='novo_avulso' and k not in (select k from e where rn>1)) t
union all select 'p1_2a_avulsa',count(distinct b.k),0 from e a join e b on b.k=a.k and b.rn=2 and b.categoria like '%avulso' where a.rn=1 and a.categoria='novo_avulso'
union all select 'p1_para_assin',count(distinct b.k),0 from e a join e b on b.k=a.k and b.rn>1 and b.categoria='antigo_inicio_assinatura' where a.rn=1 and a.categoria='novo_avulso'
union all select 'assin_ini',count(*),round(sum(liquido)::numeric,2) from core.vw_app_pedido where categoria in ('novo_assinatura','antigo_inicio_assinatura')
union all select 'rv1',count(*),0 from rv where r=1
union all select 'rv2',count(*),0 from rv where r=2
union all select 'rv3',count(*),0 from rv where r=3
union all select 'rv4',count(*),0 from rv where r>=4
union all select 'falha',count(*),round(sum(total)::numeric,2) from commerce.woo_orders where status='failed'
union all select 'cancel',count(*),0 from commerce.orders_enriched where cancelled_at is not null`,
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
};
