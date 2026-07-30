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
async function dados() {
  if (cache.json && Date.now() - cache.at < TTL) return cache.json;
  try {
    const d = await carregar();
    cache = { at: Date.now(), json: d, erro: null };
    return d;
  } catch (e) {
    console.error('[carregar]', e.message);
    if (cache.json) { cache.erro = e.message; return cache.json; }   // serve o ultimo bom
    throw e;
  }
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
}).listen(PORT, () => console.log('cells-analytics on :' + PORT));
