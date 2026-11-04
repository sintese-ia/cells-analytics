// Agente "perguntar ao dado" — Haiku 4.5 + tool consulta_sql (SELECT-only).
// O cérebro é agente-contexto.md (camada semântica condensada). Sem chave configurada
// (ANTHROPIC_API_KEY), a rota responde erro amigável e o resto do painel nem percebe.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const CONTEXTO = fs.readFileSync(path.join(__dirname, 'agente-contexto.md'), 'utf8');
const MODEL = process.env.AGENTE_MODEL || 'claude-haiku-4-5-20251001';

// pool próprio, read-only na sessão + timeout curto: o pior caso vira uma query lenta de 15s
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_AGENTE || process.env.DATABASE_URL,
  ssl: false, max: 2, idleTimeoutMillis: 30000,
  options: '-c default_transaction_read_only=on -c statement_timeout=15000',
});
pool.on('connect', c => c.query('SET jit = off').catch(() => {}));

let _client = null;
function client() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) {
    const Anthropic = require('@anthropic-ai/sdk');
    _client = new Anthropic({ maxRetries: 2 });
  }
  return _client;
}

const TOOLS = [{
  name: 'consulta_sql',
  description: 'Executa UMA consulta SELECT/WITH no Postgres da Cells (só leitura) e devolve as linhas em JSON.',
  input_schema: {
    type: 'object',
    properties: { sql: { type: 'string', description: 'Apenas SELECT ou WITH; sem ponto e vírgula; use LIMIT em listas.' } },
    required: ['sql'],
  },
}];

// O REGEX NÃO É A BARREIRA — A TRANSAÇÃO É (04/11/2026, achado F6-04 da auditoria do Codex).
// O guarda abaixo é só triagem barata, e sozinho ele VAZA. Provado offline pela auditoria:
//   /^\s*(select|with)\b/ aceita  SELECT set_config('default_transaction_read_only','off',false)
//   /^\s*(select|with)\b/ aceita  WITH x AS (UPDATE t SET n=1 RETURNING n) SELECT * FROM x
// E o `default_transaction_read_only=on` do pool é só o DEFAULT DA SESSÃO: um set_config o
// desliga. A credencial em uso (claude_b2b) tem INSERT em 65 objetos, UPDATE em 63 e DELETE em
// 53 — ou seja, a única coisa entre um SQL gerado por LLM e uma escrita era uma expressão regular.
//
// `begin read only` fecha isso de verdade: o modo read-only é fixado NA TRANSAÇÃO e não pode ser
// alterado depois que ela começa. Dentro dela o próprio Postgres recusa INSERT/UPDATE/DELETE/DDL
// ("cannot execute UPDATE in a read-only transaction"), e o CTE com UPDATE cai junto. O rollback
// no fim garante que nada atravessa, e cada pergunta abre a sua própria transação — então nem um
// set_config que tenha escapado numa chamada anterior afeta a seguinte.
async function rodarSql(sql) {
  if (!/^\s*(select|with)\b/i.test(sql) || sql.includes(';'))
    return JSON.stringify({ erro: 'Só SELECT/WITH, uma consulta, sem ";".' });
  let cli;
  try {
    cli = await pool.connect();
    await cli.query('begin read only');
    const r = await cli.query(sql);
    let s = JSON.stringify(r.rows.slice(0, 200));
    if (s.length > 20000) s = s.slice(0, 20000) + ' …(truncado)';
    return JSON.stringify({ linhas: r.rowCount, dados: s });
  } catch (e) {
    return JSON.stringify({ erro: e.message });
  } finally {
    if (cli) {
      // rollback sempre, e reafirma o default da sessão caso algum set_config o tenha mexido
      try { await cli.query('rollback'); } catch (e) {}
      try { await cli.query('set default_transaction_read_only = on'); } catch (e) {}
      cli.release();
    }
  }
}

// mensagens: [{role:'user'|'assistant', content:'texto'}] — histórico vem do browser
async function perguntar(mensagens) {
  const c = client();
  if (!c) return 'O agente ainda não foi ativado: falta a ANTHROPIC_API_KEY no serviço.';
  const msgs = mensagens.slice(-8).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 4000),
  }));
  for (let i = 0; i < 6; i++) {
    const resp = await c.messages.create({
      model: MODEL, max_tokens: 1500,
      system: [{ type: 'text', text: CONTEXTO, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS, messages: msgs,
    });
    if (resp.stop_reason !== 'tool_use')
      return resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n') || '(sem resposta)';
    msgs.push({ role: 'assistant', content: resp.content });
    const results = [];
    for (const b of resp.content) if (b.type === 'tool_use')
      results.push({ type: 'tool_result', tool_use_id: b.id, content: await rodarSql(String(b.input.sql || '')) });
    msgs.push({ role: 'user', content: results });
  }
  return 'Não consegui fechar a resposta em 6 passos — tenta uma pergunta mais específica.';
}

module.exports = { perguntar };
