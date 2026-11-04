// GATE OBRIGATORIO antes de qualquer deploy. Em 30/07 o app foi ao ar com SyntaxError
// porque um bloco removido deixou template literal aberto. Este script:
//   1. valida a sintaxe de todo o JS do template (node --check nao ve dentro do <script>)
//   2. renderiza as 9 telas contra o dado REAL do banco, sob N cenarios de filtro
//   3. falha com exit 1 na primeira excecao, string "undefined" ou "NaN" no HTML
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Pool } = require('pg');
const Q = require('./queries');

const TPL = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');

// --- 1. extrair e checar a sintaxe de CADA bloco <script> do template.
// Nao-gulosa e por bloco: desde o widget do agente ha 2 blocos, e a regex gulosa antiga
// capturava os dois como um so ("</script>...<script>" no meio) — o gate falhava sempre.
const BLOCOS = [...TPL.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]);
if (!BLOCOS.length) { console.error('FALHA: nao achei <script> no template'); process.exit(1); }
BLOCOS.forEach((b, i) => {
  try { new vm.Script(b.replace('__DATA__', '{}'), { filename: `template.html<script#${i + 1}>` }); }
  catch (e) { console.error(`FALHA DE SINTAXE no bloco ${i + 1}: ` + e.message); process.exit(1); }
});
// o app e o bloco que carrega __DATA__; os demais (agente) so precisam compilar
const JS = BLOCOS.find(b => b.includes('__DATA__')) || BLOCOS[0];
console.log('ok  sintaxe valida em ' + BLOCOS.length + ' blocos <script> (app: ' + JS.split('\n').length + ' linhas)');

// --offline: sem banco. Roda com TODAS as views vazias — e exatamente a classe de bug que o
// gate pegou (tela que estoura quando o filtro devolve conjunto vazio). E o que o CI consegue
// fazer: o Postgres so responde na rede interna do Easypanel, o GitHub Actions nao o alcanca.
const OFFLINE = process.argv.includes('--offline') || !process.env.DATABASE_URL;

(async () => {
  const D = {};
  if (OFFLINE) {
    for (const k of Object.keys(Q)) D[k] = [];
    console.log('ok  modo OFFLINE: ' + Object.keys(Q).length + ' views com zero linhas');
  } else {
    // MESMO timeout do server (120s): o gate tem que reprovar o que a produção reprova.
    // Com 180s aqui, a query jor de 96–188s passava no smoke e estourava no server — o dash
    // vivia de cache e ninguém via (achado da planning-d5, 01/11).
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false, statement_timeout: 120000 });
    // ... e MESMO jit=off do server: sem isto o Postgres compila as queries (JIT) e tudo
    // demora um múltiplo do real — o gate reprovava query que a produção roda em segundos.
    pool.on('connect', c => c.query('SET jit = off').catch(() => {}));
    const cli = await pool.connect();
    for (const [k, sql] of Object.entries(Q)) {
      const r = await cli.query(sql);
      D[k] = r.rows.map(row => {
        const o = {};
        for (const [c, v] of Object.entries(row)) {
          o[c] = (v instanceof Date) ? v.toISOString().slice(0, 10)
               : (typeof v === 'string' && /^-?\d+\.?\d*$/.test(v) && c !== 'sku' && c !== 'mes' && c !== 'co') ? Number(v)
               : v;
        }
        return o;
      });
      console.log('    ' + k.padEnd(9) + ' ' + String(D[k].length).padStart(6) + ' linhas');
    }
    cli.release(); await pool.end();
  }
  D.ger = new Date().toISOString().slice(0, 16);
  // O servidor manda `hoje` (data real no fuso de SP) e `falhas`. Sem eles aqui, o gate testava
  // um payload que a producao nunca produz — e a ancora das janelas caia no fallback do browser.
  D.hoje = new Intl.DateTimeFormat('en-CA',
    { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  D.falhas = [];

  // --- 2. sandbox com DOM minimo: so o suficiente para as funcoes de pagina rodarem
  const els = {};
  const mkEl = () => ({ innerHTML: '', value: '', style: {}, classList: { add(){}, remove(){}, toggle(){} },
                        addEventListener(){}, querySelectorAll: () => [], querySelector: () => null,
                        getAttribute: () => null, setAttribute(){}, appendChild(){}, focus(){}, dataset: {} });
  const document = {
    getElementById: id => els[id] || (els[id] = mkEl()),
    querySelectorAll: () => [], querySelector: () => null,
    createElement: mkEl, addEventListener(){},
    body: mkEl(), documentElement: mkEl(),
  };
  const ctx = {
    document, console,
    window: { addEventListener(){}, matchMedia: () => ({ matches: false, addEventListener(){} }),
              location: { hash: '', search: '' }, localStorage: { getItem: () => null, setItem(){} },
              requestAnimationFrame: f => f(), setTimeout: () => 0 },
    localStorage: { getItem: () => null, setItem(){} },
    setTimeout: () => 0, requestAnimationFrame: f => f(),
    addEventListener(){}, removeEventListener(){},
    matchMedia: () => ({ matches: false, addEventListener(){} }),
    location: { hash: '', search: '' }, history: { replaceState(){}, pushState(){} },
    navigator: { userAgent: 'smoke' }, Intl, URL, URLSearchParams, Blob: class {},
  };
  ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  try { new vm.Script(JS.replace('__DATA__', JSON.stringify(D)), { filename: 'tpl' }).runInContext(ctx); }
  catch (e) { console.error('FALHA ao executar o template: ' + e.stack); process.exit(1); }

  // S e declarado com const dentro do script, entao nao vira propriedade do contexto.
  try { new vm.Script('globalThis.__S = S;').runInContext(ctx); }
  catch (e) { console.error('FALHA: nao consegui alcancar o estado S: ' + e.message); process.exit(1); }
  ctx.S = ctx.__S;

  const PGS = ['visao','resultado','aquisicao','amostras','base','jornada','canais','definicoes','config'];
  const FN = {};
  for (const n of Object.getOwnPropertyNames(ctx)) if (/^pg[A-Z]/.test(n) && typeof ctx[n] === 'function') FN[n] = ctx[n];
  console.log('ok  ' + Object.keys(FN).length + ' funcoes de pagina encontradas: ' + Object.keys(FN).join(', '));

  // --- 2b. PERIODOS LIDOS DO PROPRIO APP, nunca redigitados aqui.
  // Lista escrita a mao no gate foi o que permitiu testar cinco periodos inexistentes durante
  // meses. Extraindo do seletor, o gate nao pode mais divergir do app em silencio.
  const PERIODOS = [...JS.matchAll(/const PER=\[(.*?)\];/gs)]
    .flatMap(m => [...m[1].matchAll(/\['([a-z0-9]+)'/g)].map(x => x[1]));
  if (PERIODOS.length < 5) {
    console.error('FALHA: nao consegui ler a lista de periodos do template (achei ' + PERIODOS.length + ')');
    process.exit(1);
  }
  console.log('ok  ' + PERIODOS.length + ' periodos lidos do seletor: ' + PERIODOS.join(', '));

  // CADA PERIODO TEM QUE PRODUZIR UMA JANELA PROPRIA. Se dois caem na mesma janela, algum deles
  // nao esta implementado e esta escorregando para o `default` do switch — exatamente o defeito
  // que o Gabriel sentia como "filtrei e nao foi". `custom` fica fora: depende de d1/d2.
  const janelas = {};
  for (const p of PERIODOS.filter(p => p !== 'custom')) {
    ctx.S.per = p;
    let j;
    try { j = new vm.Script('jan()').runInContext(ctx); }
    catch (e) { console.error(`FALHA: jan() estourou no periodo '${p}': ${e.message}`); process.exit(1); }
    if (!Array.isArray(j) || !j[0] || !j[1]) { console.error(`FALHA: periodo '${p}' devolveu janela invalida: ${JSON.stringify(j)}`); process.exit(1); }
    janelas[p] = j.join('..');
  }
  const dup = Object.entries(janelas).filter(([p, v]) =>
    Object.entries(janelas).some(([q, w]) => q !== p && w === v));
  if (dup.length) {
    console.error('FALHA: periodos com a MESMA janela (algum nao esta implementado): '
      + dup.map(([p, v]) => `${p}=${v}`).join(' | '));
    process.exit(1);
  }
  // E "hoje" tem que ser HOJE, nao o ultimo dia com pedido — a confusao que fazia o painel
  // mostrar um dia velho quando a manha estava sem venda ou o cache estava parado.
  ctx.S.per = 'hoje';
  const jHoje = new vm.Script('jan()').runInContext(ctx);
  if (jHoje[0] !== D.hoje || jHoje[1] !== D.hoje) {
    console.error(`FALHA: periodo 'hoje' devolveu ${jHoje.join('..')} e hoje e ${D.hoje}`);
    process.exit(1);
  }
  console.log('ok  periodo "hoje" = ' + D.hoje + ' e as ' + Object.keys(janelas).length + ' janelas sao distintas');
  ctx.S.per = '30';

  // --- 3. cenarios de filtro
  const canais = [...new Set((D.dias || []).map(r => r.canal_aq).filter(Boolean))].slice(0, 5);
  const cats   = [...new Set((D.dias || []).map(r => r.categoria).filter(Boolean))];
  const grupos = [null, 'Pago', 'Orgânico', 'Outros'];
  const CEN = [{}];
  canais.forEach(c => CEN.push({ can: c }));
  cats.forEach(c => CEN.push({ cat: c }));
  grupos.filter(Boolean).forEach(g => CEN.push({ gru: g }));
  // PERIODOS REAIS. Ate 04/11 estavam aqui '7d','30d','90d','ytd','all' — valores que o app NAO
  // conhece: todos caiam no `default` do `switch` de `jan()`, entao o gate NUNCA testou um unico
  // periodo de verdade em 22 cenarios. Foi assim que bug de data passou deploy atras de deploy
  // enquanto o gate dizia "TUDO OK". Os valores abaixo sao exatamente os do seletor da barra.
  PERIODOS.forEach(p => CEN.push({ per: p }));
  CEN.push({ per: 'custom', d1: D.hoje, d2: D.hoje });                    // um dia so
  CEN.push({ per: 'custom', d1: '2025-01-01', d2: D.hoje });              // historico inteiro
  CEN.push({ per: 'custom', d1: D.hoje, d2: '2025-01-01' });              // invertido, de proposito
  CEN.push({ per: 'custom', d1: '', d2: '' });                            // vazio
  CEN.push({ mod: 'first' }, { mod: 'last' }, { rec: 'bruto' });
  CEN.push({ can: canais[0], cat: cats[0] });
  CEN.push({ can: 'canal_que_nao_existe' });          // caso vazio
  CEN.push({ cat: 'categoria_inexistente' });          // caso vazio
  CEN.push({ can: canais[0], gru: 'Pago', cat: cats[0], per: '7d' });
  // Baldes de negocio (amostra/compras/mrr). MRR nas telas de midia devolve so um aviso, e
  // 'amostra' restringe a poucos conjuntos — os dois sao caminhos de conjunto quase vazio,
  // que e exatamente onde divisao por zero costuma escapar.
  CEN.push({ bal: 'amostra' }, { bal: 'compras' }, { bal: 'mrr' });
  CEN.push({ bal: 'amostra', per: '7d' }, { bal: 'compras', can: canais[0] });
  CEN.push({ bal: 'balde_inexistente' });              // caso vazio

  let n = 0, falhas = 0;
  for (const cen of CEN) {
    for (const pg of PGS) {
      Object.assign(ctx.S, { pg }, cen);
      const fname = Object.keys(FN).find(f => f.toLowerCase() === 'pg' + pg.toLowerCase())
                 || Object.keys(FN).find(f => f.toLowerCase().startsWith('pg' + pg.slice(0, 5).toLowerCase()));
      if (!fname) continue;
      n++;
      let html;
      try { html = FN[fname].call(ctx); }
      catch (e) { console.error(`FALHA ${fname} cenario ${JSON.stringify(cen)}: ${e.message}`); falhas++; continue; }
      if (typeof html !== 'string' || !html.length) { console.error(`FALHA ${fname} ${JSON.stringify(cen)}: html vazio`); falhas++; continue; }
      for (const bad of ['undefined', 'NaN', '[object Object]', 'Infinity']) {
        if (html.includes('>' + bad) || html.includes(bad + '<') || html.includes('R$ ' + bad)) {
          console.error(`FALHA ${fname} ${JSON.stringify(cen)}: encontrou "${bad}" no HTML`); falhas++; break;
        }
      }
    }
  }
  console.log(`\n${n} renders em ${CEN.length} cenarios x ${PGS.length} telas`);
  if (falhas) { console.error(`${falhas} FALHAS`); process.exit(1); }
  console.log('TUDO OK');
})().catch(e => { console.error('FALHA: ' + e.stack); process.exit(1); });
