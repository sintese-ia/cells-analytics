// SQL extraído de /tmp/ex4.py — mesma camada semântica do snapshot.
module.exports = {
  // `ks` = ids densos das identidades do grupo. Sem isso o app somava count(distinct) de cada
  // grupo para achar "clientes unicos", e quem compra em cinco dias contava cinco vezes: no ano
  // de 2026 dava 1.053 contra 624 reais (+69%), e Receita por cliente saia 41% subestimada.
  // Com o array o app faz a uniao real por periodo/filtro. Sao ~2,2 mil pedidos no historico
  // inteiro — o custo de payload e irrelevante perto de errar o numero.
  // Piso em 2025-01-01: o banco comeca em 16/01/2025 e o painel so enxergava 2026, entao o total
  // de clientes nunca podia fechar (1.206 pagantes no historico, 1.391 com amostra).
  // HIERARQUIA COMPLETA no grao: canal > campanha > conjunto > anuncio, de UMA fonte so.
  // Antes a tela de Midia lia vw_ads_metricas_dia e a de Atribuicao lia vw_app_pedido, e as duas
  // discordavam do Meta em 35% em julho (R$ 20.688,70 contra R$ 15.377,07; 196 pedidos contra
  // 169) — first click contra last click. Empilhar as duas daria um pai que nao bate com os
  // filhos. Agora receita, pedidos, clientes e margem saem TODOS de vw_app_pedido em qualquer
  // nivel; do grid do Meta vem so gasto e as colunas reportadas pela plataforma.
  // A hierarquia vem da PROPRIA SESSAO DE ORIGEM (web.sessions via first_session_id), nao dos
  // campos first_touch_* do bridge. Motivo, achado pelo Gabriel em 08/08: o bridge monta o first
  // touch pegando o primeiro valor nao-vazio de CADA CAMPO separadamente, e nao todos os campos da
  // mesma sessao. O pedido 7711120261254 saiu com campanha '22181464268' (Google, sessao de 22/07)
  // e conjunto 'W1_ELETROLITO' (Meta, sessao de 28/07) — conjunto do Meta pendurado embaixo do
  // Google na tela. Sao 93 pedidos com campos de sessoes diferentes.
  // Lendo da sessao, os quatro campos passam a descrever o MESMO clique.
  // `canal_aq` continua vindo do bridge: ROAS e CAC por canal nao mudam, so a hierarquia abaixo.
  // Custo do grao mais fino: 1.241 -> 1.327 grupos (+7%).
  dias: `with cn as (
   -- (canal, campanha) e (canal, conjunto) que REALMENTE existem em sessao. Serve de sanidade para
   -- o pedido SEM sessao de origem, onde o bridge e a unica fonte e nao ha o que conferir: se o
   -- nome nunca apareceu numa sessao daquele canal, ele nao pertence ali. Foi assim que
   -- 'CJ_teste_energybydesign' (conjunto exclusivo do Meta) parou de aparecer embaixo de 'direct'.
   select distinct regexp_replace(coalesce(fc.canal, w.source_norm, ''), '^google_.*$', 'google') canal,
          nullif(w.utm_campaign,'') campanha, nullif(w.utm_content,'') conjunto
     from web.sessions w
     left join core.fonte_canonica fc on fc.fonte_bruta = w.source_norm
 ), b as (
 select p.dia, p.canal, p.canal_aq, p.sistema, p.categoria,
        -- SE A SESSAO EXISTE, ELA MANDA — inclusive quando esta vazia. Cair de volta no bridge
        -- quando a sessao vem vazia foi o que reintroduziu o Frankenstein: 4 pedidos com sessao de
        -- origem SEM campanha nenhuma apareciam com '2026_06_VENDAS' pendurado embaixo de 'direct'.
        -- Bridge so entra quando nao ha sessao (woo legado, pedido importado) — ai nao ha o que checar.
        case when s.first_session_id is null then
                  (case when exists (select 1 from cn where cn.campanha = p.campanha
                          and cn.canal = regexp_replace(p.canal_aq,'^google_.*$','google'))
                        then p.campanha end)
             when fs.coerente then nullif(fs.utm_campaign,'') end campanha,
        case when s.first_session_id is null then
                  (case when exists (select 1 from cn where cn.conjunto = p.adset
                          and cn.canal = regexp_replace(p.canal_aq,'^google_.*$','google'))
                        then p.adset end)
             when fs.coerente then nullif(fs.utm_content,'')  end adset,
        case when s.first_session_id is null then null
             when fs.coerente then nullif(fs.utm_term,'')     end anuncio,
        -- MESMA construcao para o LAST touch, para o modelo Last click ter a hierarquia dele.
        case when s.last_session_id is null then
                  (case when exists (select 1 from cn where cn.campanha = s.last_touch_campaign
                          and cn.canal = regexp_replace(p.canal,'^google_.*$','google'))
                        then nullif(s.last_touch_campaign,'') end)
             when ls.coerente then nullif(ls.utm_campaign,'') end campanha_l,
        case when s.last_session_id is null then
                  (case when exists (select 1 from cn where cn.conjunto = s.last_touch_content
                          and cn.canal = regexp_replace(p.canal,'^google_.*$','google'))
                        then nullif(s.last_touch_content,'') end)
             when ls.coerente then nullif(ls.utm_content,'')  end conjunto_l,
        case when s.last_session_id is null then null
             when ls.coerente then nullif(ls.utm_term,'')     end anuncio_l,
        p.bruto, p.desconto, p.reembolso, p.liquido, p.cmv, p.margem, p.cmv_ok, p.basis,
        dense_rank() over (order by coalesce(p.cid,p.email)) kid
   from core.vw_app_pedido p
   left join core.bridge_order_session s on s.order_id = p.order_id
   left join lateral (
     select w.utm_campaign, w.utm_content, w.utm_term,
            -- COERENCIA: so aproveita a hierarquia se a sessao for do MESMO canal que canal_aq.
            -- google_ads e google_organico contam como o mesmo 'google' (o que os separa e o gclid,
            -- nao a campanha). Quando diverge, campanha/conjunto/anuncio ficam NULOS e a linha cai
            -- em "(sem campanha)" — melhor um vazio honesto que uma campanha do canal errado.
            coalesce(regexp_replace(coalesce(fc.canal, w.source_norm, ''), '^google_.*$', 'google'), '')
              = regexp_replace(p.canal_aq, '^google_.*$', 'google') as coerente
       from web.sessions w
       left join core.fonte_canonica fc on fc.fonte_bruta = w.source_norm
      where w.session_id = s.first_session_id
      order by w.timestamp
      limit 1) fs on true
   left join lateral (
     select w.utm_campaign, w.utm_content, w.utm_term,
            coalesce(regexp_replace(coalesce(fc.canal, w.source_norm, ''), '^google_.*$', 'google'), '')
              = regexp_replace(p.canal, '^google_.*$', 'google') as coerente
       from web.sessions w
       left join core.fonte_canonica fc on fc.fonte_bruta = w.source_norm
      where w.session_id = s.last_session_id
      order by w.timestamp desc
      limit 1) ls on true
  where p.created_at>='2025-01-01')
-- NIVEL REAL DO META, nao o que a UTM diz. As campanhas nao usam a mesma convencao:
--   2026_07_W1_LPS_ANGULOS  content=conjunto           term=anuncio        (certo)
--   TP_CP3_..._040826       content=ANUNCIO            term=adset_id       (deslocado 1 nivel)
-- Sem resolver, a TP_CP3 abria direto em anuncio enquanto a W1 abria em conjunto — e o gasto do
-- grid (que vem na hierarquia certa do Meta) nao casava com chave nenhuma abaixo da campanha.
-- core.vw_utm_meta traduz os dois jeitos usando o proprio dicionario do Meta. Cobre 96,7%; o que
-- nao resolve cai no valor cru de sempre.
-- campanha_real (13/08): quando a UTM trouxe o ID numerico no lugar do nome ({{campaign.id}},
-- jul/26), a receita abria uma linha "120245..." sem gasto. O coalesce funde com a linha do nome.
select b.dia, b.canal, b.canal_aq, b.sistema, b.categoria,
 nullif(coalesce(uf.campanha_real, b.campanha),'') campanha,
 nullif(coalesce(uf.conjunto_real, b.adset),'')   conjunto,
 nullif(coalesce(uf.anuncio_real,  b.anuncio),'') anuncio,
 coalesce(ul.campanha_real, b.campanha_l) campanha_l,
 coalesce(ul.conjunto_real, b.conjunto_l) conjunto_l,
 coalesce(ul.anuncio_real,  b.anuncio_l)  anuncio_l,
 count(*) pedidos, count(distinct b.kid) clientes, array_agg(distinct b.kid) ks,
 round(sum(b.bruto)::numeric,2) bruto, round(sum(b.desconto)::numeric,2) desc_,
 round(sum(b.reembolso)::numeric,2) reemb, round(sum(b.liquido)::numeric,2) liq,
 round(sum(b.cmv)::numeric,2) cmv, round(sum(b.margem)::numeric,2) marg,
 sum((b.cmv_ok)::int) cmv_ok,
 sum((coalesce(b.basis,'session') in ('session','landing'))::int) med,
 sum((b.basis='inherited')::int) inf
from b
left join core.vw_utm_meta uf on uf.campanha = b.campanha
 and uf.content is not distinct from b.adset      and uf.term is not distinct from b.anuncio
left join core.vw_utm_meta ul on ul.campanha = b.campanha_l
 and ul.content is not distinct from b.conjunto_l and ul.term is not distinct from b.anuncio_l
group by 1,2,3,4,5,6,7,8,9,10,11`,
  // SINTESE = ATRIBUICAO LINEAR. Mesmo formato de `dias`, mas cada pedido ja entra RATEADO pela
  // jornada: 10 sessoes -> 10% para cada toque, 3 sessoes -> 33%. Quem nao tem jornada
  // reconstruivel (33% do faturamento: `inherited`, woo legado, cliente que voltou sem passar no
  // site) cai no canal de AQUISICAO com peso 1 — sem isso um terco da receita viraria "nao sei".
  // Regra e medicoes em cells-infra/fixes/2026-08-09-vw-atribuicao-linear.sql.
  dlin: `with w as (
   select p.order_id, p.dia, p.sistema, p.categoria,
          p.bruto, p.desconto, p.reembolso, p.liquido, p.cmv, p.margem, p.cmv_ok, p.basis,
          coalesce(al.canal, p.canal_aq) canal,
          al.campanha, al.conjunto, al.anuncio,
          coalesce(al.peso,1) peso,
          dense_rank() over (order by coalesce(p.cid,p.email)) kid
     from core.vw_app_pedido p
     left join core.vw_atribuicao_linear al on al.order_id = p.order_id
    where p.created_at >= '2025-01-01')
 -- MESMA traducao de nivel da query dias. O modelo Sintese le daqui, entao sem isto a arvore
 -- ficava resolvida no First/Last click e torta no modelo padrao — que e o que a tela abre.
 select w.dia, w.canal, w.canal canal_aq, w.sistema, w.categoria,
   coalesce(u.campanha_real, w.campanha) campanha,
   coalesce(u.conjunto_real, w.conjunto) conjunto,
   coalesce(u.anuncio_real,  w.anuncio)  anuncio,
   coalesce(u.campanha_real, w.campanha) campanha_l,
   coalesce(u.conjunto_real, w.conjunto) conjunto_l,
   coalesce(u.anuncio_real,  w.anuncio)  anuncio_l,
   round(sum(w.peso)::numeric,4) pedidos,
   count(distinct w.kid) clientes, array_agg(distinct w.kid) ks,
   round(sum(w.bruto*w.peso)::numeric,2) bruto, round(sum(w.desconto*w.peso)::numeric,2) desc_,
   round(sum(w.reembolso*w.peso)::numeric,2) reemb, round(sum(w.liquido*w.peso)::numeric,2) liq,
   round(sum(w.cmv*w.peso)::numeric,2) cmv, round(sum(w.margem*w.peso)::numeric,2) marg,
   round(sum((w.cmv_ok)::int*w.peso)::numeric,2) cmv_ok,
   round(sum((coalesce(w.basis,'session') in ('session','landing'))::int*w.peso)::numeric,2) med,
   round(sum((w.basis='inherited')::int*w.peso)::numeric,2) inf
 from w
 left join core.vw_utm_meta u on u.campanha = w.campanha
  and u.content is not distinct from w.conjunto and u.term is not distinct from w.anuncio
 group by 1,2,3,4,5,6,7,8`,
  // SESSOES e VISITANTES NOVOS por (dia, canal, campanha, conjunto, anuncio) — o que faltava para
  // igualar Sessions / NV / Cost NV do Triple Whale. `nv` = sessao que E a primeira do user_id na
  // base: e o proxy padrao de visitante novo, e como o user_id e por aparelho, quem volta de outro
  // celular conta de novo. Julho: 14.191 sessoes, 12.410 novos (87%).
  sess: `with s as (
   select w.session_id, min(w.timestamp) ts, min(w.user_id) user_id,
     (array_agg(nullif(w.utm_campaign,'') order by w.timestamp))[1] campanha,
     (array_agg(nullif(w.utm_content,'')  order by w.timestamp))[1] conjunto,
     (array_agg(nullif(w.utm_term,'')     order by w.timestamp))[1] anuncio,
     (array_agg(case when coalesce(fc.canal,w.source_norm)='google'
        then case when coalesce(w.gclid,'')<>'' or w.utm_medium in ('cpc','ppc','paid')
                  then 'google_ads' else 'google_organico' end
        else coalesce(fc.canal,w.source_norm,'nao-atribuido') end order by w.timestamp))[1] canal
    from web.sessions w
    left join core.fonte_canonica fc on fc.fonte_bruta = w.source_norm
   where w.timestamp >= '2026-01-01' group by 1),
  prim as (select user_id, min(ts) primeira from s where user_id is not null group by 1)
 -- mesma traducao de nivel da query dias: sem ela Sessions/NV se penduram numa chave que a arvore
 -- (ja resolvida) nao tem mais, e a coluna zera justo nas campanhas de convencao torta.
 select s.ts::date dia, s.canal, coalesce(u.campanha_real, s.campanha) campanha,
   coalesce(u.conjunto_real, s.conjunto) conjunto,
   coalesce(u.anuncio_real,  s.anuncio)  anuncio,
   count(*) sessoes,
   count(*) filter (where p.primeira is not null and s.ts = p.primeira) nv
 from s left join prim p on p.user_id = s.user_id
 left join core.vw_utm_meta u on u.campanha = s.campanha
  and u.content is not distinct from s.conjunto and u.term is not distinct from s.anuncio
 group by 1,2,3,4,5`,
  // OBJETIVO REAL do Meta, que ja vinha coletado em ads.meta_ads_raw e eu nao usava. Separa topo de
  // funil de conversao SEM ninguem rotular nada. (Nao resolve "amostra x venda": para o Meta as duas
  // sao OUTCOME_SALES — foi por isso que a classificacao manual de 07/08 falhou.)
  metaobj: `select campaign_name campanha, adset_name conjunto,
   mode() within group (order by objective) objetivo
  from ads.meta_ads_raw where date_start >= '2026-01-01'
  group by 1,2`,
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
  saude: `select fonte,tipo,sla_horas,idade_horas,dias_faltando,status,linhas from core.vw_pipeline_saude`,
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
  // REMOVIDA em 08/08/2026: a query `objetivo` (core.vw_campanha_objetivo_dia). A ideia era rotular
  // cada conjunto como amostra/venda/topo para dividir o gasto por balde. O dado derrubou a
  // premissa: o mesmo conjunto entrega os dois. Em julho o W1_ENERGETICO fez 11 amostras + 5
  // compras de aquisicao + 2 assinaturas novas com um orcamento so. Rotular escondia metade.
  // O gasto agora pertence a conta (ver `custoBalde` no template) e custo por amostra virou
  // coluna de CONJUNTO no grid, onde as duas contas aparecem lado a lado sem esconder linha.
  // A tabela core.campanha_objetivo continua no banco, sem uso pelo app.
  // DRE de contribuicao por dia. Fecha o buraco do FRETE: a `margem` das outras views e
  // `margem_antes_frete` e o custo de envio nao entrava de lado nenhum, sendo que 93% dos pedidos
  // de julho sairam com frete gratis. O custo vem do parametro declarado `frete_medio_por_envio`
  // O frete e o custo REAL por pedido, de commerce.frete_pedido (Bling, logisticas/objetos).
  // Pedido sem volume_id cai no parametro declarado `frete_medio_por_envio` — `pedidos_frete_estimado`
  // conta quantos, para a tela nunca apresentar estimativa como medicao.
  // Ver cells-infra/fixes/2026-08-08-vw-dre-dia.sql e 2026-08-08-frete-real-bling.sql.
  //
  // 11/08: a view passou a ler `core.vw_app_pedido` (Shopify + WooCommerce) no lugar de
  // `commerce.orders_enriched` (so Shopify), com a fronteira de dia em America/Sao_Paulo, igual
  // ao resto do painel. Antes esta tela mostrava um faturamento DIFERENTE do das outras para o
  // mesmo mes — julho dava R$ 29.989,01 aqui e R$ 31.906,21 no Resumo, porque os 11 pedidos do
  // Woo (assinantes legado do CellsClub) nao existiam nesta tela. Agora bate com
  // `core.vw_kpi_mes.fat_total` em 20 de 20 meses. Ver 2026-08-11-vw-dre-dia-inclui-woo.sql.
  // `reembolsos` fecha a cascata (tabela - descontos - reembolso = faturamento) e
  // `pedidos_fora_do_bling` conta os pedidos que NUNCA terao frete medido (o Woo nao passa pelo
  // Bling), para a tela nao apresentar estimativa como medicao.
  dre: `select dia, pedidos, pedidos_sem_cmv, pedidos_frete_estimado, valor_tabela, descontos, faturamento,
   cmv, taxas, frete_cobrado, frete_liquido, midia, margem_contribuicao, resultado,
   reembolsos, pedidos_fora_do_bling
  from core.vw_dre_dia where dia >= '2025-01-01'`,
  // --- Grid de midia: canal > campanha > conjunto > anuncio ---
  grid: `select dia, canal, campanha, conjunto, coalesce(anuncio,'(sem anuncio)') anuncio,
   nao_identificado, spend, impressoes, ob_clicks, plat_lpv, plat_atc, plat_checkout,
   plat_compras, pedidos, nc_pedidos, receita, nc_receita, conta, margem, nc_margem
  from core.vw_ads_metricas_dia where dia >= '2026-01-01' order by dia`,
};
