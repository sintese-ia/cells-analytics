// Cells Analytics — servidor ao vivo. Le as views do Postgres pela rede interna
// do Easypanel (host = nome do servico), injeta no template e serve com senha.
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');
const Q = require('./queries');

const PORT   = process.env.PORT || 3000;
const SENHA  = process.env.SENHA || 'turbo';
const TTL    = (+process.env.CACHE_MIN || 10) * 60 * 1000;
const COOKIE = 'ca_sess';
const TOKEN  = require('crypto').createHash('sha256').update('ca|' + SENHA).digest('hex').slice(0, 32);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false, max: 4, idleTimeoutMillis: 30000, statement_timeout: 120000,
});

// jit=off. As views sao unions complexos com jsonb, entao o planner estima custo absurdo
// (762.851 na query de jornadas) e cruza o jit_above_cost padrao de 100.000. O Postgres entao
// COMPILA a query — e o dado real e minusculo (2.128 pedidos), logo a compilacao e puro
// desperdicio. Medido no EXPLAIN ANALYZE: Optimization 10,7s + Emission 8,0s = 19,2s dos 22,5s
// eram JIT, nao processamento. Com jit=off a carga completa cai de 33,3s para 13,8s e a query
// de jornadas de 22,9s para 4,7s, com contagem de linhas identica nas 7 queries testadas.
pool.on('connect', c => c.query('SET jit = off').catch(e => console.error('[jit]', e.message)));

const TPL = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
let cache = { at: 0, json: null, erro: null };

async function carregar() {
  const out = {};
  const cli = await pool.connect();
  try {
    for (const [k, sql] of Object.entries(Q)) {
      const r = await cli.query(sql);
      out[k] = r.rows.map(row => {
        const o = {};
        for (const [c, v] of Object.entries(row)) {
          o[c] = (v instanceof Date) ? v.toISOString().slice(0, 10)
               : (typeof v === 'string' && /^-?\d+\.?\d*$/.test(v) && c !== 'sku' && c !== 'mes' && c !== 'co') ? Number(v)
               : v;
        }
        return o;
      });
    }
  } finally { cli.release(); }
  out.ger = new Date().toISOString().slice(0, 16);
  return out;
}
// A carga fria custa ~35s (a query `jor` sozinha leva 21s, e ja era assim antes do split do
// google — medido 18,7s contra a view antiga). Fazer o usuario esperar isso e inaceitavel: em
// 30/07 o Gabriel clicou em Entrar quando o cache tinha acabado de expirar e a pagina ficou
// pendurada. Regra nova: NINGUEM espera uma recarga.
//
//  - stale-while-revalidate: se ha cache, devolve na hora e revalida por tras.
//  - pre-aquecimento no boot: o primeiro visitante ja encontra dado pronto.
//  - timer a cada TTL/2: o cache nunca chega a esfriar.
//  - uma recarga por vez (`emVoo`), senao 5 abas viram 5 cargas de 35s simultaneas.
let emVoo = null;

function recarregar() {
  if (emVoo) return emVoo;                      // coalesce: uma sozinha serve todos
  const t0 = Date.now();
  emVoo = carregar()
    .then(d => {
      cache = { at: Date.now(), json: d, erro: null };
      console.log(`[carga] ok em ${((Date.now()-t0)/1000).toFixed(1)}s`);
      return d;
    })
    .catch(e => {
      console.error('[carga] falhou:', e.message);
      if (cache.json) { cache.erro = e.message; return cache.json; }  // serve o ultimo bom
      throw e;
    })
    .finally(() => { emVoo = null; });
  return emVoo;
}

async function dados() {
  const idade = Date.now() - cache.at;
  if (cache.json) {
    if (idade >= TTL) recarregar();             // revalida SEM await — ninguem espera
    return cache.json;
  }
  return recarregar();                          // so no primeiro request depois do boot
}

const login = (erro) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Cells Analytics</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F7F7F5;
color:#111;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif}
.bx{background:#fff;border:1px solid #E3E3DF;border-radius:6px;padding:34px 32px;width:min(370px,92vw)}
.lg{font-weight:800;font-size:23px;letter-spacing:-.03em;margin:0 0 4px}.lg em{color:#F45E1A;font-style:normal}
p{color:#5A5A57;font-size:13px;margin:0 0 20px}
label{display:block;font-size:10.5px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:#8A8A86;margin-bottom:6px}
input{width:100%;border:1px solid #E3E3DF;border-radius:4px;padding:10px 11px;font-size:14px;font-family:inherit}
input:focus{outline:2px solid #F45E1A;outline-offset:1px;border-color:#F45E1A}
button{width:100%;margin-top:13px;background:#111;color:#fff;border:none;border-radius:4px;padding:11px;
font-size:14px;font-weight:650;cursor:pointer;font-family:inherit}button:hover{background:#242422}
.er{background:#FBEBE9;color:#B3261E;font-size:12.5px;padding:9px 11px;border-radius:4px;margin-bottom:14px;font-weight:600}
.ft{margin-top:18px;font-size:11px;color:#8A8A86;line-height:1.5}</style></head><body>
<form class="bx" method="POST" autocomplete="off"><div class="lg">c<em>e</em>lls analytics</div>
<p>Painel interno. Acesso restrito.</p>${erro ? '<div class="er">Senha incorreta.</div>' : ''}
<label for="s">Senha</label><input id="s" name="senha" type="password" required autofocus aria-label="Senha de acesso">
<button type="submit">Entrar</button><div class="ft">Dado ao vivo do Postgres · atualiza a cada ${TTL/60000} min</div>
</form></body></html>`;

const aquecendo = () => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5">
<title>Cells Analytics — preparando</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F7F7F5;
color:#111;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif}
.bx{background:#fff;border:1px solid #E3E3DF;border-radius:6px;padding:30px 32px;width:min(400px,92vw)}
.lg{font-weight:800;font-size:21px;letter-spacing:-.03em;margin:0 0 10px}.lg em{color:#F45E1A;font-style:normal}
p{color:#5A5A57;font-size:13px;line-height:1.6;margin:0 0 8px}
.br{height:3px;background:#EDEDE9;border-radius:2px;overflow:hidden;margin:16px 0 10px}
.br i{display:block;height:100%;width:40%;background:#F45E1A;border-radius:2px;animation:s 1.1s ease-in-out infinite}
@keyframes s{0%{margin-left:-40%}100%{margin-left:100%}}
.ft{font-size:11px;color:#8A8A86}
@media(prefers-reduced-motion:reduce){.br i{animation:none;width:100%}}</style></head><body>
<div class="bx"><div class="lg">c<em>e</em>lls analytics</div>
<p>Lendo o banco. A primeira carga depois de um deploy leva cerca de <b>35 segundos</b> — as views de jornada são pesadas.</p>
<div class="br"><i></i></div>
<p class="ft">Esta página se atualiza sozinha. Depois desta carga o painel responde instantâneo:
o cache é mantido quente por trás e ninguém mais espera.</p></div></body></html>`;

const erroPg = (m) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Cells Analytics</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#F7F7F5;color:#111;padding:40px;max-width:620px;margin:0 auto}
.bx{background:#fff;border:1px solid #E3E3DF;border-left:3px solid #B3261E;border-radius:5px;padding:20px}
h1{font-size:17px;margin:0 0 8px}code{background:#F4F4F1;padding:2px 5px;border-radius:3px;font-size:12px}
p{color:#5A5A57;font-size:13.5px;line-height:1.6}</style></head><body><div class="bx">
<h1>Não consegui ler o banco</h1><p>O painel não vai mostrar número errado nem número velho sem avisar — então parou aqui.</p>
<p><code>${String(m).replace(/[<>&]/g,'')}</code></p>
<p>Confira <code>DATABASE_URL</code> no serviço. Dentro do Easypanel o host é o nome do serviço: <code>bancodados:5432</code>.</p>
</div></body></html>`;

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/healthz') { res.writeHead(200, {'content-type':'text/plain'}); return res.end('ok'); }

  const ck = req.headers.cookie || '';
  const autenticado = ck.includes(`${COOKIE}=${TOKEN}`);

  if (req.method === 'POST') {
    let b = ''; req.on('data', c => { b += c; if (b.length > 4096) req.destroy(); });
    return req.on('end', () => {
      const v = new URLSearchParams(b).get('senha');
      if (v === SENHA) {
        res.writeHead(303, { 'Location': u.pathname + u.search,
          'Set-Cookie': `${COOKIE}=${TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` });
        return res.end();
      }
      res.writeHead(401, {'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
      res.end(login(true));
    });
  }
  if (!autenticado) {
    res.writeHead(401, {'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
    return res.end(login(false));
  }
  // Janela do boot: o pre-aquecimento leva ~35s. Nesse intervalo, dar feedback em vez de
  // pendurar o browser sem nada na tela — foi assim que o painel pareceu "quebrado" em 30/07.
  if (!cache.json) {
    res.writeHead(503, {'content-type':'text/html; charset=utf-8','cache-control':'no-store','retry-after':'5'});
    return res.end(aquecendo());
  }
  try {
    const d = await dados();
    const html = TPL.replace('__DATA__', JSON.stringify(d));
    res.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-store',
      'x-cells-cache': String(Math.round((Date.now()-cache.at)/1000)) + 's',
      'x-cells-degradado': cache.erro ? '1' : '0'});
    res.end(html);
  } catch (e) {
    res.writeHead(503, {'content-type':'text/html; charset=utf-8'});
    res.end(erroPg(e.message));
  }
}).listen(PORT, () => {
  console.log('cells-analytics on :' + PORT);
  // pre-aquece: o primeiro visitante depois de um deploy nao pode pegar 35s de carga fria
  recarregar().catch(e => console.error('[boot] pre-aquecimento falhou:', e.message));
  // e mantem quente, para o cache nunca expirar debaixo de um clique
  setInterval(() => recarregar().catch(() => {}), Math.max(60000, TTL / 2)).unref();
});
