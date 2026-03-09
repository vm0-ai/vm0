#!/bin/bash
# Configure Cloudflare Access (Zero Trust) protection for a tunnel hostname.
# Creates a self-hosted Access application with an email-based allow policy,
# so only the specified email can access the service after authenticating.
#
# Account ID is extracted from ~/.cloudflared/cert.pem automatically.
# Only CF_ACCESS_TOKEN needs to be set (API token with Access permissions).
#
# Idempotent — updates existing app if it already exists.
#
# Usage: scripts/tunnel-access.sh <hostname> [email]
#   hostname  - The FQDN to protect (e.g., ethan-vm04.vnc.vm7.ai)
#   email     - Allowed email (default: git config user.email)
#
# Environment:
#   CF_ACCESS_TOKEN  - Cloudflare API token with Access:Edit permission

set -euo pipefail

log() { echo -e "[access] $1" >&2; }

# --- Args ---
if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <hostname> [email]" >&2
  exit 1
fi

HOSTNAME="$1"
EMAIL="${2:-$(git config user.email 2>/dev/null || true)}"

if [[ -z "${CF_ACCESS_TOKEN:-}" ]]; then
  log "CF_ACCESS_TOKEN not set, skipping Access protection"
  log "Create one at https://dash.cloudflare.com/profile/api-tokens"
  log "  Required permission: Access: Apps and Policies - Edit"
  exit 0
fi

if [[ -z "$EMAIL" ]]; then
  log "No email provided and git email not configured, skipping Access protection"
  exit 0
fi

# --- Extract account ID from cert.pem ---
CERT_PEM="${HOME}/.cloudflared/cert.pem"
if [[ ! -f "$CERT_PEM" ]]; then
  log "No cert.pem found. Run 'cloudflared tunnel login' first."
  exit 1
fi

CF_ACCOUNT_ID=$(python3 -c "
import re, json, base64
with open('${CERT_PEM}') as f:
    content = f.read()
m = re.search(r'-----BEGIN ARGO TUNNEL TOKEN-----\n(.*?)\n-----END ARGO TUNNEL TOKEN-----', content, re.DOTALL)
data = json.loads(base64.b64decode(m.group(1)))
print(data['accountID'])
")

API_BASE="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access"

cf_api() {
  local method="$1" path="$2" data="${3:-}"
  local args=(
    -s -X "$method"
    -H "Authorization: Bearer ${CF_ACCESS_TOKEN}"
    -H "Content-Type: application/json"
  )
  if [[ -n "$data" ]]; then
    args+=(-d "$data")
  fi
  curl "${args[@]}" "${API_BASE}${path}"
}

# --- Check if Access app already exists for this hostname ---
log "Checking existing Access apps for ${HOSTNAME}..."
EXISTING_APPS=$(cf_api GET "/apps")

APP_ID=$(echo "$EXISTING_APPS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for app in data.get('result', []):
    if app.get('domain') == '${HOSTNAME}':
        print(app['id'])
        break
" 2>/dev/null || true)

APP_NAME="vnc-${HOSTNAME%%.*}"

if [[ -n "$APP_ID" ]]; then
  log "Access app already exists (id: ${APP_ID}), updating..."

  cf_api PUT "/apps/${APP_ID}" "$(cat <<APPJSON
{
  "name": "${APP_NAME}",
  "domain": "${HOSTNAME}",
  "type": "self_hosted",
  "session_duration": "24h",
  "auto_redirect_to_identity": false
}
APPJSON
  )" >/dev/null

else
  log "Creating Access app for ${HOSTNAME}..."

  RESULT=$(cf_api POST "/apps" "$(cat <<APPJSON
{
  "name": "${APP_NAME}",
  "domain": "${HOSTNAME}",
  "type": "self_hosted",
  "session_duration": "24h",
  "auto_redirect_to_identity": false
}
APPJSON
  )")

  APP_ID=$(echo "$RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if data.get('success'):
    print(data['result']['id'])
else:
    errors = data.get('errors', [])
    print('ERROR: ' + '; '.join(e.get('message','') for e in errors), file=sys.stderr)
    sys.exit(1)
" 2>&1)

  if [[ "$APP_ID" == ERROR:* ]]; then
    log "$APP_ID"
    exit 1
  fi

  log "Created Access app (id: ${APP_ID})"
fi

# --- Ensure allow policy exists for the email ---
log "Configuring policy to allow ${EMAIL}..."

EXISTING_POLICIES=$(cf_api GET "/apps/${APP_ID}/policies")
POLICY_ID=$(echo "$EXISTING_POLICIES" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for p in data.get('result', []):
    if p.get('name') == 'allow-owner':
        print(p['id'])
        break
" 2>/dev/null || true)

POLICY_JSON=$(cat <<POLICYJSON
{
  "name": "allow-owner",
  "decision": "allow",
  "include": [
    {
      "email": {
        "email": "${EMAIL}"
      }
    }
  ],
  "precedence": 1
}
POLICYJSON
)

if [[ -n "$POLICY_ID" ]]; then
  cf_api PUT "/apps/${APP_ID}/policies/${POLICY_ID}" "$POLICY_JSON" >/dev/null
  log "Updated allow policy for ${EMAIL}"
else
  cf_api POST "/apps/${APP_ID}/policies" "$POLICY_JSON" >/dev/null
  log "Created allow policy for ${EMAIL}"
fi

log "Access protection enabled: ${HOSTNAME} -> only ${EMAIL} allowed"
