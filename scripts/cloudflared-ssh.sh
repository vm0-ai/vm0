#!/bin/bash
# Manage Cloudflare Tunnels for SSH access to metal machines.
#
# Uses locally-managed tunnels with cert.pem (from `cloudflared tunnel login`).
# No API token needed — only the cert.pem file obtained via interactive login.
#
# Prerequisites:
#   - cloudflared installed locally
#   - cert.pem at ~/.cloudflared/cert.pem (run `cloudflared tunnel login` to generate)
#
# Usage:
#   scripts/cloudflared-ssh.sh provision <host> [--domain vm3.ai] [--user ubuntu] [--version 2026.2.0]
#   scripts/cloudflared-ssh.sh deprovision <host> [--domain vm3.ai] [--user ubuntu]
#
# Examples:
#   scripts/cloudflared-ssh.sh provision prod-1.aws.vm3.ai
#   scripts/cloudflared-ssh.sh deprovision prod-1.aws.vm3.ai

set -euo pipefail

DEFAULT_DOMAIN="vm3.ai"
DEFAULT_USER="ubuntu"
DEFAULT_VERSION="2026.2.0"

log() { echo -e "\033[1;34m[cloudflared-ssh]\033[0m $1" >&2; }
err() { echo -e "\033[1;31m[cloudflared-ssh]\033[0m $1" >&2; }

# --- Validate prerequisites ---
require_cloudflared() {
  if ! command -v cloudflared &>/dev/null; then
    err "cloudflared is not installed. Install it first."
    exit 1
  fi
  local cert_path="${CLOUDFLARED_CERT:-$HOME/.cloudflared/cert.pem}"
  if [[ ! -f "$cert_path" ]]; then
    err "cert.pem not found at ${cert_path}. Run 'cloudflared tunnel login' first."
    exit 1
  fi
}

# --- Derive names from host ---
parse_host() {
  local host="$1"
  if ! [[ "$host" =~ ^[a-z0-9-]+\.aws\.vm3\.ai$ ]]; then
    err "Host '${host}' does not match expected pattern (e.g. abc.aws.vm3.ai)"
    exit 1
  fi
  PREFIX="${host%%.*}"
  TUNNEL_NAME="${PREFIX}-ssh"
  TUNNEL_FQDN="${TUNNEL_NAME}.${2}"
}

# ==========================================
# Provision
# ==========================================
do_provision() {
  local host="" domain="$DEFAULT_DOMAIN" user="$DEFAULT_USER" version="$DEFAULT_VERSION"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain)  domain="$2"; shift 2 ;;
      --user)    user="$2"; shift 2 ;;
      --version) version="$2"; shift 2 ;;
      -*)        err "Unknown option: $1"; exit 1 ;;
      *)         host="$1"; shift ;;
    esac
  done
  if [[ -z "$host" ]]; then
    err "Usage: $0 provision <host> [--domain vm3.ai] [--user ubuntu] [--version 2026.2.0]"
    exit 1
  fi

  require_cloudflared
  parse_host "$host" "$domain"
  log "Provisioning tunnel ${TUNNEL_FQDN} for ${host}"

  # Step 1: Create or reuse tunnel
  local tunnel_id
  tunnel_id=$(cloudflared tunnel list -o json 2>/dev/null \
    | jq -r --arg name "$TUNNEL_NAME" '.[] | select(.name == $name and .deleted_at == null) | .id // empty' 2>/dev/null || echo "")

  if [[ -n "$tunnel_id" ]]; then
    log "Reusing existing tunnel: ${TUNNEL_NAME} (${tunnel_id})"
  else
    log "Creating tunnel: ${TUNNEL_NAME}"
    cloudflared tunnel create "$TUNNEL_NAME"
    tunnel_id=$(cloudflared tunnel list -o json \
      | jq -r --arg name "$TUNNEL_NAME" '.[] | select(.name == $name and .deleted_at == null) | .id')
    log "Created tunnel: ${tunnel_id}"
  fi

  # Step 2: Route DNS (creates CNAME: TUNNEL_FQDN -> tunnel_id.cfargotunnel.com)
  log "Configuring DNS: ${TUNNEL_FQDN}"
  local dns_output
  if ! dns_output=$(cloudflared tunnel route dns "$TUNNEL_NAME" "$TUNNEL_FQDN" 2>&1); then
    if echo "$dns_output" | grep -qi "already exists"; then
      log "DNS record already exists for ${TUNNEL_FQDN}"
    else
      err "Failed to route DNS: ${dns_output}"
      exit 1
    fi
  fi

  # Step 3: Deploy to host via SSH
  local remote="${user}@${host}"
  local cred_file="$HOME/.cloudflared/${tunnel_id}.json"

  if [[ ! -f "$cred_file" ]]; then
    err "Credentials file not found: ${cred_file}"
    exit 1
  fi

  log "Deploying cloudflared ${version} to ${host}..."

  # Install cloudflared binary if needed
  ssh "$remote" bash -s -- "$version" <<'INSTALL_SCRIPT'
set -euo pipefail
VERSION="$1"
if ! cloudflared --version 2>/dev/null | grep -q "$VERSION"; then
  echo "Downloading cloudflared ${VERSION}..."
  curl -sfL "https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-linux-arm64.deb" \
    -o "/tmp/cloudflared-${VERSION}.deb"
  sudo dpkg -i "/tmp/cloudflared-${VERSION}.deb"
else
  echo "cloudflared ${VERSION} already installed"
fi
INSTALL_SCRIPT

  # Copy credentials file to host (restrict permissions before writing content)
  log "Copying tunnel credentials to ${host}..."
  ssh "$remote" "sudo mkdir -p /etc/cloudflared && install -m 600 /dev/null /tmp/tunnel-cred.json"
  scp "$cred_file" "${remote}:/tmp/tunnel-cred.json"
  ssh "$remote" "sudo mv /tmp/tunnel-cred.json /etc/cloudflared/${tunnel_id}.json"

  # Write config file on host
  ssh "$remote" bash -s -- "$tunnel_id" "$TUNNEL_FQDN" <<'CONFIG_SCRIPT'
set -euo pipefail
TUNNEL_ID="$1"
TUNNEL_FQDN="$2"
sudo tee /etc/cloudflared/config.yml > /dev/null <<INNER_EOF
tunnel: ${TUNNEL_ID}
credentials-file: /etc/cloudflared/${TUNNEL_ID}.json
ingress:
  - hostname: ${TUNNEL_FQDN}
    service: ssh://localhost:22
  - service: http_status:404
INNER_EOF
CONFIG_SCRIPT

  # Install and start service
  ssh "$remote" bash <<'SERVICE_SCRIPT'
set -euo pipefail
sudo cloudflared service uninstall 2>/dev/null || true
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared

sleep 3
if systemctl is-active cloudflared > /dev/null 2>&1; then
  echo "cloudflared service is running"
else
  echo "ERROR: cloudflared service failed to start" >&2
  sudo journalctl -u cloudflared --no-pager -n 20 >&2
  exit 1
fi
SERVICE_SCRIPT

  log "Done! Tunnel ${TUNNEL_FQDN} is active (ID: ${tunnel_id})"
}

# ==========================================
# Deprovision
# ==========================================
do_deprovision() {
  local host="" domain="$DEFAULT_DOMAIN" user="$DEFAULT_USER"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain) domain="$2"; shift 2 ;;
      --user)   user="$2"; shift 2 ;;
      -*)       err "Unknown option: $1"; exit 1 ;;
      *)        host="$1"; shift ;;
    esac
  done
  if [[ -z "$host" ]]; then
    err "Usage: $0 deprovision <host> [--domain vm3.ai] [--user ubuntu]"
    exit 1
  fi

  require_cloudflared
  parse_host "$host" "$domain"
  log "Deprovisioning tunnel ${TUNNEL_FQDN}"

  local tunnel_id
  tunnel_id=$(cloudflared tunnel list -o json 2>/dev/null \
    | jq -r --arg name "$TUNNEL_NAME" '.[] | select(.name == $name and .deleted_at == null) | .id // empty' 2>/dev/null || echo "")

  if [[ -z "$tunnel_id" ]]; then
    log "No tunnel found for ${TUNNEL_NAME}, nothing to do"
    return
  fi

  # Step 1: Uninstall service on host
  local remote="${user}@${host}"
  log "Stopping cloudflared service on ${host}..."
  ssh "$remote" "sudo cloudflared service uninstall 2>/dev/null || true" || \
    log "Warning: could not SSH to ${host} to uninstall service (host may be down)"

  # Step 2: Delete tunnel (--force to clean up connections)
  log "Deleting tunnel ${TUNNEL_NAME} (${tunnel_id})..."
  cloudflared tunnel delete --force "$TUNNEL_NAME"

  # Step 3: Clean up local credentials
  local cred_file="$HOME/.cloudflared/${tunnel_id}.json"
  if [[ -f "$cred_file" ]]; then
    rm "$cred_file"
    log "Removed local credentials: ${cred_file}"
  fi

  log "Done! Tunnel ${TUNNEL_NAME} removed"
}

# ==========================================
# Main
# ==========================================
if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <provision|deprovision> <host> [options]" >&2
  exit 1
fi

ACTION="$1"
shift

case "$ACTION" in
  provision)   do_provision "$@" ;;
  deprovision) do_deprovision "$@" ;;
  *)
    err "Unknown action: ${ACTION}"
    echo "Usage: $0 <provision|deprovision> <host> [options]" >&2
    exit 1
    ;;
esac
