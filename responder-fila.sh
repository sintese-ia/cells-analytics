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

# PATH explícito: o cron roda com PATH mínimo e NÃO acha o `claude`
# (~/.local/bin) nem o python3 do Xcode — sem isto o script falha calado.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# ⚠️ psycopg2 só existe no python3 DO SISTEMA (/usr/bin/python3), não no do
# homebrew — e homebrew vem antes no PATH acima. Chamar `python3` solto resolvia
# pro homebrew e o script morria com ModuleNotFoundError no cron (03/11).

# Ambiente mínimo do login: sem estas o `claude` responde "Not logged in · Please run
# /login" e o script marca toda pergunta como erro (diagnosticado em 01/11 — o teste com
# `env -i HOME=...` reproduz; com USER/LOGNAME/SHELL/TMPDIR volta a autenticar).
export USER="${USER:-$(id -un)}"
export LOGNAME="${LOGNAME:-$USER}"
export SHELL="${SHELL:-/bin/zsh}"
export TMPDIR="${TMPDIR:-/tmp}"

PERGUNTA_JSON=$(/usr/bin/python3 - <<'PYEOF'
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
PYEOF
)
[ "$PERGUNTA_JSON" = "null" ] && exit 0

ID=$(echo "$PERGUNTA_JSON" | /usr/bin/python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
PERGUNTA=$(echo "$PERGUNTA_JSON" | /usr/bin/python3 -c "import json,sys;print(json.load(sys.stdin)['pergunta'])")

# `< /dev/null`: sob cron não há stdin e o claude espera 3s por ele antes de seguir.
BRUTO=$(claude -p "Você é o agente 'pergunte à cells' do dash. Pergunta do Gabriel: \"$PERGUNTA\"

Responda consultando o Postgres da Cells em SOMENTE LEITURA: python3 + psycopg2, connection string na linha DATABASE_URL de ~/Documents/cells-crm-app/.env.local. Guia da camada semântica (quais views usar): $DIR/agente-contexto.md — leia antes de escrever SQL. Nunca escreva no banco. Seja direto: número com contexto curto, em PT-BR, sem markdown pesado (o widget mostra texto puro). No fim, imprima APENAS a resposta final entre <resposta> e </resposta>." \
  --allowedTools "Bash,Read" --max-turns 20 < /dev/null 2>/dev/null)

# extração em python, NÃO sed: resposta de verdade tem várias linhas e o sed casa
# linha a linha — com <resposta> e </resposta> em linhas diferentes ele devolvia vazio
# e toda pergunta real virava 'erro' (pego no teste de 01/11).
RESPOSTA=$(printf '%s' "$BRUTO" | /usr/bin/python3 -c "
import re,sys
t=sys.stdin.read()
m=re.search(r'<resposta>(.*?)</resposta>', t, re.S)
print((m.group(1) if m else '').strip())
")

# resposta vai por env var — interpolar texto livre dentro de heredoc python quebraria com aspas
export RESPOSTA ID
/usr/bin/python3 - <<'PYEOF'
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
PYEOF
