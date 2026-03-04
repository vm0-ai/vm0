#!/bin/bash
# Manage Cloudflare Tunnels for SSH access to metal machines.
#
# Uses the cloudflared CLI directly — no API token needed.
# Authenticates via `cloudflared tunnel login` (browser-based, one-time).
#
# Provision: creates tunnel + DNS locally, deploys credentials + config to host via SSH.
# Deprovision: deletes tunnel from Cloudflare (no SSH needed).
#
# Usage:
#   scripts/cloudflared-ssh.sh provision <host> [--domain vm3.ai] [--user ubuntu] [--version 2026.2.0]
#   scripts/cloudflared-ssh.sh deprovision <host> [--domain vm3.ai]
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

# --- Ensure cloudflared is installed and authenticated ---
ensure_auth() {
  if ! command -v cloudflared &>/dev/null; then
    err "cloudflared is not installed. Run this inside the devcontainer."
    exit 1
  fi
  if [[ ! -f "$HOME/.cloudflared/cert.pem" ]]; then
    log "Not authenticated. Running cloudflared tunnel login..."
    cloudflared tunnel login
  fi
}

# --- Derive names from host ---
parse_host() {
  local host="$1" domain="$2"
  if ! [[ "$host" =~ ^[a-z0-9-]+\.aws\.vm3\.ai$ ]]; then
    err "Host '${host}' does not match expected pattern (e.g. abc.aws.vm3.ai)"
    exit 1
  fi
  PREFIX="${host%%.*}"
  TUNNEL_NAME="${PREFIX}-ssh"
  TUNNEL_FQDN="${TUNNEL_NAME}.${domain}"
}

# --- Get tunnel ID by name (empty if not found) ---
get_tunnel_id() {
  local name="$1"
  cloudflared tunnel list --name "$name" 2>/dev/null | { grep "$name" || true; } | awk '{print $1}'
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

  ensure_auth
  parse_host "$host" "$domain"
  log "Provisioning tunnel ${TUNNEL_FQDN} for ${host}"

  # Step 1: Create or reuse tunnel
  local tunnel_id
  tunnel_id=$(get_tunnel_id "$TUNNEL_NAME")

  if [[ -n "$tunnel_id" ]]; then
    log "Reusing existing tunnel: ${TUNNEL_NAME} (${tunnel_id})"
  else
    log "Creating tunnel: ${TUNNEL_NAME}"
    cloudflared tunnel create "$TUNNEL_NAME"
    tunnel_id=$(get_tunnel_id "$TUNNEL_NAME")
    if [[ -z "$tunnel_id" ]]; then
      err "Failed to create tunnel"
      exit 1
    fi
    log "Created tunnel: ${tunnel_id}"
  fi

  # Verify credentials file exists locally
  local creds_file="$HOME/.cloudflared/${tunnel_id}.json"
  if [[ ! -f "$creds_file" ]]; then
    err "Credentials file not found: ${creds_file}"
    err "Tunnel may have been created on a different machine. Delete and recreate:"
    err "  cloudflared tunnel delete ${TUNNEL_NAME}"
    err "  $0 provision ${host}"
    exit 1
  fi

  # Step 2: Create DNS route
  log "Configuring DNS: ${TUNNEL_FQDN}"
  cloudflared tunnel route dns --overwrite-dns "$TUNNEL_NAME" "$TUNNEL_FQDN"

  # Step 3: Deploy to host via SSH
  local remote="${user}@${host}"
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

  # Upload credentials file
  ssh "$remote" "sudo mkdir -p /etc/cloudflared"
  scp "$creds_file" "${remote}:/tmp/cloudflared-creds.json"
  ssh "$remote" "sudo mv /tmp/cloudflared-creds.json /etc/cloudflared/${tunnel_id}.json && sudo chmod 600 /etc/cloudflared/${tunnel_id}.json"

  # Create config file (unquoted heredoc — variables expanded locally)
  ssh "$remote" "sudo tee /etc/cloudflared/config.yml > /dev/null" <<EOF
tunnel: ${tunnel_id}
credentials-file: /etc/cloudflared/${tunnel_id}.json
ingress:
  - hostname: ${TUNNEL_FQDN}
    service: ssh://localhost:22
  - service: http_status:404
EOF

  # Install and start service
  ssh "$remote" bash <<'SERVICE_SCRIPT'
  set -euo pipefail
  sudo cloudflared service uninstall 2>/dev/null || true
  echo "Installing cloudflared service..."
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
  local host="" domain="$DEFAULT_DOMAIN"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain) domain="$2"; shift 2 ;;
      -*)       err "Unknown option: $1"; exit 1 ;;
      *)        host="$1"; shift ;;
    esac
  done
  if [[ -z "$host" ]]; then
    err "Usage: $0 deprovision <host> [--domain vm3.ai]"
    exit 1
  fi

  ensure_auth
  parse_host "$host" "$domain"
  log "Deprovisioning tunnel ${TUNNEL_FQDN}"

  local tunnel_id
  tunnel_id=$(get_tunnel_id "$TUNNEL_NAME")

  if [[ -z "$tunnel_id" ]]; then
    log "No tunnel found for ${TUNNEL_NAME}, nothing to do"
    return
  fi

  # Step 1: Clean up active connections
  log "Cleaning up connections for ${TUNNEL_NAME}..."
  cloudflared tunnel cleanup "$TUNNEL_NAME" || true

  # Step 2: Delete tunnel
  log "Deleting tunnel ${TUNNEL_NAME} (${tunnel_id})..."
  cloudflared tunnel delete --force "$TUNNEL_NAME"

  # Step 3: Clean up local credentials file
  local creds_file="$HOME/.cloudflared/${tunnel_id}.json"
  if [[ -f "$creds_file" ]]; then
    rm "$creds_file"
    log "Removed local credentials: ${creds_file}"
  fi

  log "Done! Tunnel ${TUNNEL_NAME} removed"
  log "Note: DNS record for ${TUNNEL_FQDN} may need manual cleanup in Cloudflare dashboard"
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
