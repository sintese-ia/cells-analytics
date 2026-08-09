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

// --- 1. extrair e checar a sintaxe do script do template
const m = TPL.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.error('FALHA: nao achei o <script> no template'); process.exit(1); }
const JS = m[1];
try { new vm.Script(JS.replace('__DATA__', '{}'), { filename: 'template.html<script>' }); }
catch (e) { console.error('FALHA DE SINTAXE no template: ' + e.message); process.exit(1); }
console.log('ok  sintaxe do <script> valida (' + JS.split('\n').length + ' linhas)');

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
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false, statement_timeout: 180000 });
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

  const PGS = ['resumo','canais','tipo','mensal','semanal','matriz','resultado','definicoes','config'];
  const FN = {};
  for (const n of Object.getOwnPropertyNames(ctx)) if (/^pg[A-Z]/.test(n) && typeof ctx[n] === 'function') FN[n] = ctx[n];
  console.log('ok  ' + Object.keys(FN).length + ' funcoes de pagina encontradas: ' + Object.keys(FN).join(', '));

  // --- 3. cenarios de filtro
  const canais = [...new Set((D.dias || []).map(r => r.canal_aq).filter(Boolean))].slice(0, 5);
  const cats   = [...new Set((D.dias || []).map(r => r.categoria).filter(Boolean))];
  const grupos = [null, 'Pago', 'Orgânico', 'Outros'];
  const CEN = [{}];
  canais.forEach(c => CEN.push({ can: c }));
  cats.forEach(c => CEN.push({ cat: c }));
  grupos.filter(Boolean).forEach(g => CEN.push({ gru: g }));
  CEN.push({ per: '7d' }, { per: '30d' }, { per: '90d' }, { per: 'ytd' }, { per: 'all' });
  CEN.push({ mod: 'first' }, { mod: 'last' }, { bruto: 1 });
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
