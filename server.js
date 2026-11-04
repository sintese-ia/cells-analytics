// Cells Analytics — servidor ao vivo. Le as views do Postgres pela rede interna
// do Easypanel (host = nome do servico), injeta no template e serve com senha.
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');
const Q = require('./queries');
const AGENTE = require('./agente');

const PORT   = process.env.PORT || 3000;
const SENHA  = process.env.SENHA || 'turbo';
const TTL    = (+process.env.CACHE_MIN || 10) * 60 * 1000;
const COOKIE = 'ca_sess';
const TOKEN  = require('crypto').createHash('sha256').update('ca|' + SENHA).digest('hex').slice(0, 32);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Pool de REQUEST (/perguntar, agente). A carga do painel tem pool proprio (`poolCarga`),
  // justamente para nao consumir estas conexoes e travar o login enquanto recarrega.
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

const norm = row => {
  const o = {};
  for (const [c, v] of Object.entries(row)) {
    o[c] = (v instanceof Date) ? v.toISOString().slice(0, 10)
         : (typeof v === 'string' && /^-?\d+\.?\d*$/.test(v) && c !== 'sku' && c !== 'mes' && c !== 'co') ? Number(v)
         : v;
  }
  return o;
};

// DATA DE HOJE NO FUSO DE SAO PAULO, calculada aqui e enviada ao cliente.
// O container roda em UTC: depois das 21h BRT o `new Date()` do servidor ja virou o dia
// seguinte, e qualquer janela ancorada nele pularia um dia inteiro todas as noites.
const hojeBR = () => new Intl.DateTimeFormat('en-CA',
  { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const agoraBR = () => new Intl.DateTimeFormat('sv-SE',
  { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date());

// CARGA EM PARALELO. Era um `for` sequencial num unico cliente: medido em 04/11 contra o banco
// de producao, as 25 queries somavam 345s (dias 41s, tempo 49s, sess 34s, assinCiclo 31s...).
// O comentario abaixo dizia "~35s" e envelheceu dez vezes sem ninguem notar, porque o gate
// (smoke.js) roda OFFLINE e nunca cronometra o banco.
// Consequencia real: o timer de refresh dispara a cada TTL/2 = 300s, menor que os 345s da carga,
// entao o painel vivia RECARREGANDO SEM PARAR (coalescido por `emVoo`) — 100% de duty cycle no
// banco — e o dado na tela nunca tinha menos de 6 minutos. Com 6 trabalhadores a carga cai para
// a soma do maior balde (~60-90s) e o duty cycle para ~25%.
//
// CONCORRENCIA CALIBRADA, NAO CHUTADA. Com 6 trabalhadores a `dias` (41s sozinha) estourou o
// statement_timeout de 120s: as queries competem por CPU/IO e as pesadas se atropelam. Com 3 a
// carga cai para ~2min sem nenhuma passar nem perto do limite.
// O GARGALO DE VERDADE NAO E O LOOP, SAO AS VIEWS: `tempo` e um simples
// `select * from core.vw_tempo_entre_etapas` e leva 49s; `assinCiclo` 31s; `dias` 41s. Enquanto
// a camada semantica nao tiver materializacao, nenhum ajuste aqui resolve mais do que isto.
const CONC = +process.env.CARGA_CONC || 3;

// Pool SO da carga, com teto de tempo maior: ninguem espera por ela (stale-while-revalidate),
// entao derrubar uma query de 130s por um limite pensado para request interativo so produz o
// bloco furado que o painel acabou de aprender a denunciar. O pool de cima, que serve
// /perguntar e o agente, continua com os 120s de request.
const poolCarga = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false, max: CONC, idleTimeoutMillis: 30000, statement_timeout: 240000,
});
poolCarga.on('connect', c => c.query('SET jit = off').catch(e => console.error('[jit carga]', e.message)));
poolCarga.on('error', e => console.error('[pool carga]', e.message));

async function carregar() {
  const nomes = Object.keys(Q);
  const out = {}, tempos = {}, falhas = [];
  let i = 0;
  async function trabalhador() {
    for (;;) {
      const k = nomes[i++];
      if (!k) return;
      const t0 = Date.now();
      try {
        const r = await poolCarga.query(Q[k]);
        out[k] = r.rows.map(norm);
        tempos[k] = Date.now() - t0;
      } catch (e) {
        tempos[k] = Date.now() - t0;
        falhas.push(k);
        console.error(`[carga] ${k} falhou em ${tempos[k]}ms: ${e.message}`);
        // FALHA PARCIAL NAO DERRUBA O PAYLOAD INTEIRO. Antes, uma query ruim fazia o servidor
        // servir o cache antigo COMPLETO e calado — era por isso que "nao aparecia o dia de
        // hoje": o dado inteiro congelava na ultima carga boa, sem dizer nada na tela.
        // Agora so o bloco que falhou fica no valor anterior, e ele vai nomeado para o cliente.
        out[k] = (cache.json && cache.json[k]) || [];
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, nomes.length) }, trabalhador));

  // Banco fora do ar / credencial revogada: quase tudo falha de uma vez. Nesse caso e melhor
  // estourar e preservar o cache bom por inteiro do que publicar um painel de zeros.
  if (falhas.length > nomes.length / 3) {
    throw new Error(`${falhas.length} de ${nomes.length} queries falharam (${falhas.slice(0, 5).join(', ')}…)`);
  }

  const lentas = Object.entries(tempos).filter(([, ms]) => ms > 20000)
    .sort((a, b) => b[1] - a[1]).map(([k, ms]) => `${k} ${(ms / 1000).toFixed(0)}s`);
  if (lentas.length) console.log('[carga] lentas: ' + lentas.join(', '));

  out.ger   = agoraBR();          // QUANDO o dado foi lido (nao e a data do ultimo pedido)
  out.hoje  = hojeBR();           // ancora das janelas relativas no fuso certo
  out.falhas = falhas;            // blocos servindo valor anterior, para a tela avisar
  return out;
}
// A carga fria custa ~60-90s em paralelo (eram 345s em serie — ver `carregar`). Fazer o usuario
// esperar isso e inaceitavel: em 30/07 o Gabriel clicou em Entrar quando o cache tinha acabado de
// expirar e a pagina ficou pendurada. Regra nova: NINGUEM espera uma recarga.
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
  // SEPARA "processo vivo" de "dado válido" (achado F4-02 da auditoria). /healthz respondia 'ok'
  // sempre — inclusive com o cache parado há horas e blocos furados, que é justo o estado em que
  // alguém precisa saber.
  //
  // /healthz continua sendo LIVENESS e continua 200 incondicional, DE PROPÓSITO: se o EasePanel
  // usa esta rota como health check do container, devolver 503 durante a carga de boot (~2-4min,
  // quando ainda não há cache) poria o serviço num laço de restart — trocaria um problema de
  // observabilidade por uma queda de verdade.
  // /dado é a rota nova, para monitor: 200 só com dado presente e recente, 503 com o motivo.
  if (u.pathname === '/healthz') { res.writeHead(200, {'content-type':'text/plain'}); return res.end('ok'); }
  if (u.pathname === '/dado') {
    const idade = cache.at ? Math.round((Date.now() - cache.at) / 1000) : null;
    const falhas = (cache.json && cache.json.falhas) || [];
    const limite = Math.round((TTL * 3) / 1000);   // 3 TTLs sem recarregar = dado não confiável
    const problemas = [];
    if (!cache.json) problemas.push('sem dado carregado');
    else if (idade > limite) problemas.push(`cache com ${idade}s (limite ${limite}s)`);
    if (cache.erro) problemas.push('ultima recarga falhou: ' + cache.erro);
    if (falhas.length) problemas.push(`${falhas.length} bloco(s) com dado anterior: ${falhas.join(',')}`);
    const corpo = JSON.stringify({
      ok: problemas.length === 0, idade_s: idade, lido: cache.json ? cache.json.ger : null,
      blocos_furados: falhas, problemas,
    });
    res.writeHead(problemas.length ? 503 : 200,
      {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
    return res.end(corpo);
  }

  const ck = req.headers.cookie || '';
  const autenticado = ck.includes(`${COOKIE}=${TOKEN}`);

  // agente "perguntar ao dado" — mesma sessão do painel, resposta JSON.
  // SEM ANTHROPIC_API_KEY (pedido do Gabriel, 01/11): a pergunta vai pra fila
  // jarvis.dash_pergunta e quem responde é um Claude Code da ASSINATURA, por cron
  // local — sem API. O widget recebe {fila:id} e faz poll em /perguntar/status.
  if (req.method === 'POST' && u.pathname === '/perguntar') {
    if (!autenticado) { res.writeHead(401, {'content-type':'application/json'}); return res.end('{"erro":"sessão expirada — recarregue e entre de novo"}'); }
    let b = ''; req.on('data', c => { b += c; if (b.length > 60000) req.destroy(); });
    return req.on('end', async () => {
      try {
        const { mensagens } = JSON.parse(b || '{}');
        if (!Array.isArray(mensagens) || !mensagens.length) throw new Error('pergunta vazia');
        if (!process.env.ANTHROPIC_API_KEY) {
          const ultima = String((mensagens[mensagens.length - 1] || {}).content || '').slice(0, 2000);
          if (!ultima.trim()) throw new Error('pergunta vazia');
          const r = await pool.query(
            'insert into jarvis.dash_pergunta (pergunta) values ($1) returning id', [ultima]);
          res.writeHead(200, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
          return res.end(JSON.stringify({ fila: r.rows[0].id }));
        }
        const resposta = await AGENTE.perguntar(mensagens);
        res.writeHead(200, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        res.end(JSON.stringify({ resposta }));
      } catch (e) {
        console.error('[agente]', e.message);
        res.writeHead(500, {'content-type':'application/json; charset=utf-8'});
        res.end(JSON.stringify({ erro: e.message }));
      }
    });
  }

  // poll da fila: o widget pergunta "já respondeu?" até a resposta chegar
  if (req.method === 'GET' && u.pathname === '/perguntar/status') {
    if (!autenticado) { res.writeHead(401, {'content-type':'application/json'}); return res.end('{"erro":"sessão expirada"}'); }
    return (async () => {
      try {
        const id = parseInt(u.searchParams.get('id'), 10);
        if (!id) throw new Error('id inválido');
        const r = await pool.query(
          'select status, resposta from jarvis.dash_pergunta where id=$1', [id]);
        const row = r.rows[0] || { status: 'desconhecida', resposta: null };
        res.writeHead(200, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        res.end(JSON.stringify(row));
      } catch (e) {
        res.writeHead(500, {'content-type':'application/json; charset=utf-8'});
        res.end(JSON.stringify({ erro: e.message }));
      }
    })();
  }

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
  // e mantem quente, para o cache nunca expirar debaixo de um clique.
  //
  // INTERVALO ADAPTATIVO — o `setInterval(TTL/2)` fixo criava um laco de recarga PERMANENTE.
  // Medido em 04/11 com pg_stat_activity: tres amostras 20s apart pegaram o painel de producao
  // no meio de uma query (`dias`, `sess`, `cbase`), sempre uma ativa, nunca ocioso. A carga
  // levava 345s e o timer disparava a 300s, entao a proxima entrava antes de a anterior sair
  // (coalescida por `emVoo`) e o painel nunca parava de ler o banco — 100% de duty cycle.
  // Pior: era uma espiral, porque a propria recarga era a carga que deixava o banco lento.
  // Regra nova: a proxima recarga espera, no minimo, o DOBRO do que a ultima levou. Assim o duty
  // cycle fica <= 50% por construcao, mesmo que as views piorem. Se a carga ficar rapida, o
  // intervalo volta sozinho para TTL/2 e o dado volta a ser fresco — sem ninguem reconfigurar.
  let ultimaDuracao = 0;
  const agendar = () => {
    const espera = Math.max(60000, TTL / 2, ultimaDuracao * 2);
    setTimeout(() => {
      const t0 = Date.now();
      recarregar().catch(() => {}).finally(() => { ultimaDuracao = Date.now() - t0; agendar(); });
    }, espera).unref();
  };
  const t0 = Date.now();
  recarregar()
    .catch(e => console.error('[boot] pre-aquecimento falhou:', e.message))
    .finally(() => { ultimaDuracao = Date.now() - t0; agendar(); });
});
