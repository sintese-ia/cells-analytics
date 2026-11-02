#!/bin/zsh
# =============================================================================
# Responde a fila do "pergunte à cells" (jarvis.dash_pergunta) SEM API —
# usa o Claude Code da ASSINATURA (claude -p), rodando neste Mac.
#
# Instalar (opcional, torna o respondedor independente da sessão do Claude):
#   crontab -e  →  */2 8-23 * * * /Users/gabrielrodrigues/Documents/MAGNUS/cells/apps/cells-analytics/responder-fila.sh >>/tmp/responder-fila.log 2>&1
#
# Sem pergunta pendente o script sai na hora, sem invocar o claude (custo zero).
# Claim atômico (FOR UPDATE SKIP LOCKED): pode coexistir com outro respondedor
# (ex.: a sessão interativa do Claude) sem responder duas vezes.
# =============================================================================
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"

PERGUNTA_JSON=$(python3 - <<'PY'
import os, re, json, sys
import psycopg2
def url():
    for line in open(os.path.expanduser('~/Documents/cells-crm-app/.env.local')):
        m = re.match(r'\s*(?:export\s+)?DATABASE_URL\s*=\s*["\']?([^"\'\n]+)', line)
        if m: return m.group(1)
conn = psycopg2.connect(url()); conn.autocommit = True
cur = conn.cursor()
cur.execute("""update jarvis.dash_pergunta set status='respondendo'
 where id = (select id from jarvis.dash_pergunta where status='pendente'
             order by criado_em limit 1 for update skip locked)
 returning id, pergunta""")
r = cur.fetchone()
print(json.dumps({'id': r[0], 'pergunta': r[1]} if r else None))
PY
)
[ "$PERGUNTA_JSON" = "null" ] && exit 0

ID=$(echo "$PERGUNTA_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
PERGUNTA=$(echo "$PERGUNTA_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin)['pergunta'])")

RESPOSTA=$(claude -p "Você é o agente 'pergunte à cells' do dash. Pergunta do Gabriel: \"$PERGUNTA\"

Responda consultando o Postgres da Cells em SOMENTE LEITURA: python3 + psycopg2, connection string na linha DATABASE_URL de ~/Documents/cells-crm-app/.env.local. Guia da camada semântica (quais views usar): $DIR/agente-contexto.md — leia antes de escrever SQL. Nunca escreva no banco. Seja direto: número com contexto curto, em PT-BR, sem markdown pesado (o widget mostra texto puro). No fim, imprima APENAS a resposta final entre <resposta> e </resposta>." \
  --allowedTools "Bash,Read" --max-turns 20 2>/dev/null | sed -n 's/.*<resposta>\(.*\)<\/resposta>.*/\1/p' | tail -1)

# resposta vai por env var — interpolar texto livre dentro de heredoc python quebraria com aspas
export RESPOSTA ID
python3 - <<'PY'
import os, re
import psycopg2
def url():
    for line in open(os.path.expanduser('~/Documents/cells-crm-app/.env.local')):
        m = re.match(r'\s*(?:export\s+)?DATABASE_URL\s*=\s*["\']?([^"\'\n]+)', line)
        if m: return m.group(1)
resposta = os.environ.get('RESPOSTA', '').strip()
pid = int(os.environ['ID'])
conn = psycopg2.connect(url()); conn.autocommit = True
cur = conn.cursor()
if resposta:
    cur.execute("update jarvis.dash_pergunta set status='respondida', resposta=%s, respondido_em=now() where id=%s",
                (resposta, pid))
else:
    cur.execute("update jarvis.dash_pergunta set status='erro', resposta='o respondedor não conseguiu fechar a resposta — reformula?', respondido_em=now() where id=%s",
                (pid,))
PY
