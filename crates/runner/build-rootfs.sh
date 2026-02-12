#!/usr/bin/env bash
# build-rootfs.sh — Build a squashfs rootfs for Firecracker VMs.
#
# This script is called by the Rust runner binary. Its content is hashed as
# part of the build-input hash, so any change here automatically invalidates
# the rootfs cache.
#
# Usage:
#   bash build-rootfs.sh \
#     --output-dir /path/to/output \
#     --work-dir /path/to/workdir \
#     --guest-init /path/to/guest-init \
#     --guest-download /path/to/guest-download \
#     --guest-agent /path/to/guest-agent \
#     --guest-mock-claude /path/to/guest-mock-claude

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

OUTPUT_DIR=""
WORK_DIR=""
GUEST_INIT=""
GUEST_DOWNLOAD=""
GUEST_AGENT=""
GUEST_MOCK_CLAUDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)       OUTPUT_DIR="$2";       shift 2 ;;
    --work-dir)   WORK_DIR="$2";   shift 2 ;;
    --guest-init)       GUEST_INIT="$2";       shift 2 ;;
    --guest-download)   GUEST_DOWNLOAD="$2";   shift 2 ;;
    --guest-agent)      GUEST_AGENT="$2";      shift 2 ;;
    --guest-mock-claude) GUEST_MOCK_CLAUDE="$2"; shift 2 ;;
    *) echo "error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

for var in OUTPUT_DIR WORK_DIR GUEST_INIT GUEST_DOWNLOAD GUEST_AGENT GUEST_MOCK_CLAUDE; do
  if [[ -z "${!var}" ]]; then
    echo "error: --$(echo "$var" | tr '_' '-' | tr '[:upper:]' '[:lower:]') is required" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DOCKER="docker"
IMAGE_NAME="vm0-rootfs"
ROOTFS_FILE="rootfs.squashfs"
CA_CERT_FILE="mitmproxy-ca-cert.pem"
CA_KEY_FILE="mitmproxy-ca-key.pem"
CA_COMBINED_FILE="mitmproxy-ca.pem"
CA_ROOTFS_DEST="usr/local/share/ca-certificates/vm0-proxy-ca.crt"

RESOLV_CONF="nameserver 8.8.8.8
nameserver 8.8.4.4
nameserver 1.1.1.1
"

CONTAINER_NAME="vm0-rootfs-tmp-$$"
TAR_FILE="rootfs-export-$$.tar"
TMP_ROOTFS="${ROOTFS_FILE}.tmp.$$"

# Paths derived from arguments
ROOTFS_PATH="${OUTPUT_DIR}/${ROOTFS_FILE}"
TAR_PATH="${OUTPUT_DIR}/${TAR_FILE}"
TMP_ROOTFS_PATH="${OUTPUT_DIR}/${TMP_ROOTFS}"
EXTRACT_DIR=""

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

check_dependencies() {
  local missing=()

  if ! command -v docker &> /dev/null; then
    missing+=("docker")
  fi

  if ! command -v openssl &> /dev/null; then
    missing+=("openssl")
  fi

  if ! command -v mksquashfs &> /dev/null; then
    echo "[INSTALL] Installing squashfs-tools..."
    sudo apt-get update && sudo apt-get install -y squashfs-tools
    if ! command -v mksquashfs &> /dev/null; then
      missing+=("mksquashfs")
    fi
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "error: missing required dependencies: ${missing[*]}" >&2
    exit 1
  fi

  # Check if docker works without sudo
  if ! docker info &> /dev/null; then
    echo "[INFO] docker requires sudo (user not in docker group)"
    DOCKER="sudo docker"
  fi

  echo "[OK] all dependencies found"
}

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

cleanup() {
  echo "cleaning up..."
  # Remove root-owned temp files
  sudo rm -f "$TAR_PATH" 2>/dev/null || true
  sudo rm -f "$TMP_ROOTFS_PATH" 2>/dev/null || true
  if [[ -n "$EXTRACT_DIR" ]]; then
    sudo rm -rf "$EXTRACT_DIR" 2>/dev/null || true
  fi
  # Remove temp container
  $DOCKER rm -f "$CONTAINER_NAME" 2>/dev/null || true
  # Unmount if still mounted
  if [[ -n "${MOUNT_DIR:-}" ]]; then
    sudo umount "$MOUNT_DIR" 2>/dev/null || true
    rmdir "$MOUNT_DIR" 2>/dev/null || true
  fi
}

trap cleanup EXIT

# ---------------------------------------------------------------------------
# Generate proxy CA
# ---------------------------------------------------------------------------

generate_proxy_ca() {
  local cert_path="${OUTPUT_DIR}/${CA_CERT_FILE}"
  local key_path="${OUTPUT_DIR}/${CA_KEY_FILE}"
  local combined_path="${OUTPUT_DIR}/${CA_COMBINED_FILE}"

  if [[ -f "$cert_path" && -f "$key_path" && -f "$combined_path" ]]; then
    echo "[OK] proxy CA already exists, skipping generation"
    return 0
  fi

  echo "generating proxy CA certificate..."

  # Generate RSA 4096 private key
  openssl genrsa -out "$key_path" 4096

  # Generate self-signed certificate (10 years)
  openssl req -new -x509 -days 3650 \
    -key "$key_path" \
    -out "$cert_path" \
    -subj "/CN=mitmproxy/O=mitmproxy" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"

  # Create combined PEM (cert + key) for mitmproxy
  cat "$cert_path" "$key_path" > "$combined_path"

  # Set permissions: key and combined = 600, cert = 644
  chmod 600 "$key_path" "$combined_path"
  chmod 644 "$cert_path"

  echo "[OK] proxy CA generated"
}

# ---------------------------------------------------------------------------
# Docker build & export
# ---------------------------------------------------------------------------

docker_build() {
  echo "building docker image..."
  $DOCKER build -t "$IMAGE_NAME" "$WORK_DIR"
  echo "[OK] docker image built"
}

docker_export() {
  echo "exporting docker filesystem..."

  # Remove any existing temp container
  $DOCKER rm -f "$CONTAINER_NAME" 2>/dev/null || true

  # Create container (don't start it)
  $DOCKER create --name "$CONTAINER_NAME" "$IMAGE_NAME"

  # Export to temp file in output_dir (avoids tmpfs memory pressure)
  $DOCKER export "$CONTAINER_NAME" -o "$TAR_PATH"

  # Cleanup container
  $DOCKER rm -f "$CONTAINER_NAME"

  echo "[OK] filesystem exported"
}

# ---------------------------------------------------------------------------
# Extract & inject
# ---------------------------------------------------------------------------

extract_and_inject() {
  echo "extracting and injecting files..."

  EXTRACT_DIR="$(mktemp -d)"

  # Extract tar
  sudo tar -xf "$TAR_PATH" -C "$EXTRACT_DIR"

  # Write resolv.conf
  local resolv_path="${EXTRACT_DIR}/etc/resolv.conf"
  sudo rm -f "$resolv_path"
  echo -n "$RESOLV_CONF" | sudo tee "$resolv_path" > /dev/null

  # Install guest binaries
  local -a bins=(
    "${GUEST_AGENT}:/usr/local/bin/guest-agent"
    "${GUEST_DOWNLOAD}:/usr/local/bin/guest-download"
    "${GUEST_INIT}:/sbin/guest-init"
    "${GUEST_MOCK_CLAUDE}:/usr/local/bin/guest-mock-claude"
  )

  for entry in "${bins[@]}"; do
    local src="${entry%%:*}"
    local dest="${entry#*:}"
    local target="${EXTRACT_DIR}${dest}"
    sudo cp "$src" "$target"
    sudo chmod 755 "$target"
    echo "[OK] installed ${src}"
  done

  # Install proxy CA certificate
  local ca_cert="${OUTPUT_DIR}/${CA_CERT_FILE}"
  if [[ ! -f "$ca_cert" ]]; then
    echo "error: proxy CA cert not found — generate_proxy_ca should have been called first" >&2
    exit 1
  fi

  local ca_target="${EXTRACT_DIR}/${CA_ROOTFS_DEST}"
  sudo mkdir -p "$(dirname "$ca_target")"
  sudo cp "$ca_cert" "$ca_target"
  sudo chmod 644 "$ca_target"

  # Update system CA bundle
  sudo chroot "$EXTRACT_DIR" update-ca-certificates

  echo "[OK] proxy CA installed and system bundle updated"
}

# ---------------------------------------------------------------------------
# Squashfs creation
# ---------------------------------------------------------------------------

create_squashfs() {
  echo "creating squashfs image..."
  sudo mksquashfs "$EXTRACT_DIR" "$TMP_ROOTFS_PATH" -comp xz -noappend -quiet
  echo "[OK] squashfs created"
}

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

verify_rootfs() {
  echo "verifying rootfs..."

  # Check file size
  local size
  size=$(stat -c%s "$TMP_ROOTFS_PATH")
  if [[ "$size" -lt 50000000 ]]; then
    echo "warning: rootfs seems small: ${size} bytes" >&2
  fi

  # Mount squashfs
  MOUNT_DIR="$(mktemp -d)"
  sudo mount -t squashfs -o loop,ro "$TMP_ROOTFS_PATH" "$MOUNT_DIR"

  local errors=()

  # Check python3
  if [[ -f "${MOUNT_DIR}/usr/bin/python3" ]]; then
    echo "  python3: found"
  else
    errors+=("python3 not found at /usr/bin/python3")
  fi

  # Check guest binaries
  local -a dests=(
    "/usr/local/bin/guest-agent"
    "/usr/local/bin/guest-download"
    "/sbin/guest-init"
    "/usr/local/bin/guest-mock-claude"
  )
  for dest in "${dests[@]}"; do
    local check_path="${MOUNT_DIR}${dest}"
    if [[ -f "$check_path" ]]; then
      echo "  ${dest}: found"
    else
      errors+=("${dest} not found")
    fi
  done

  # Check CLIs
  if [[ -f "${MOUNT_DIR}/usr/local/bin/codex" ]]; then
    echo "  codex CLI: found"
  else
    errors+=("codex CLI not found at /usr/local/bin/codex")
  fi

  if [[ -f "${MOUNT_DIR}/usr/bin/gh" ]]; then
    echo "  gh CLI: found"
  else
    errors+=("gh CLI not found at /usr/bin/gh")
  fi

  # Check proxy CA certificate file
  local ca_path="${MOUNT_DIR}/${CA_ROOTFS_DEST}"
  if [[ -f "$ca_path" ]]; then
    echo "  proxy CA file: found"
  else
    errors+=("proxy CA certificate not found")
  fi

  # Check proxy CA in system bundle
  local bundle_path="${MOUNT_DIR}/etc/ssl/certs/ca-certificates.crt"
  if [[ ! -f "$bundle_path" ]]; then
    errors+=("system CA bundle not found at /etc/ssl/certs/ca-certificates.crt")
  elif [[ -f "$ca_path" ]]; then
    # Read second line of CA cert as a unique identifier
    local ca_line
    ca_line=$(sed -n '2p' "$ca_path")
    if [[ -z "$ca_line" ]]; then
      errors+=("proxy CA cert appears empty or malformed")
    elif grep -qF "$ca_line" "$bundle_path"; then
      echo "  proxy CA bundle: updated"
    else
      errors+=("proxy CA not found in system CA bundle (update-ca-certificates may have failed)")
    fi
  fi

  # Unmount
  sudo umount "$MOUNT_DIR"
  rmdir "$MOUNT_DIR"
  unset MOUNT_DIR

  if [[ ${#errors[@]} -gt 0 ]]; then
    echo "error: rootfs verification failed:" >&2
    for err in "${errors[@]}"; do
      echo "  ${err}" >&2
    done
    exit 1
  fi

  echo "[OK] rootfs verification passed"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

check_dependencies
generate_proxy_ca
docker_build
docker_export

extract_and_inject
# Free disk space early
sudo rm -f "$TAR_PATH"

create_squashfs
verify_rootfs

# Move into final place
mv "$TMP_ROOTFS_PATH" "$ROOTFS_PATH"

# Report size
SIZE=$(stat -c%s "$ROOTFS_PATH")
SIZE_MB=$((SIZE / 1024 / 1024))
echo "[OK] rootfs built: ${ROOTFS_PATH} (${SIZE_MB} MiB)"
