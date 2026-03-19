#!/usr/bin/env bash
# verify-rootfs.sh — Verify contents of a built squashfs rootfs.
#
# This script is called by the Rust runner binary AFTER build-rootfs.sh.
# It is NOT included in the build-input hash, so changes here do not
# invalidate the rootfs cache.
#
# Usage:
#   bash verify-rootfs.sh --rootfs /path/to/rootfs.squashfs --ca-cert /path/to/ca-cert.pem

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

ROOTFS=""
CA_CERT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rootfs) ROOTFS="$2"; shift 2 ;;
    --ca-cert) CA_CERT="$2"; shift 2 ;;
    *) echo "error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

for var in ROOTFS CA_CERT; do
  if [[ -z "${!var}" ]]; then
    echo "error: --$(echo "$var" | tr '_' '-' | tr '[:upper:]' '[:lower:]') is required" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

MOUNT_DIR=""

cleanup() {
  if [[ -n "$MOUNT_DIR" ]]; then
    sudo umount "$MOUNT_DIR" 2>/dev/null || true
    rmdir "$MOUNT_DIR" 2>/dev/null || true
  fi
}

trap cleanup EXIT

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

missing=()
for cmd in sudo mount umount stat mktemp sed grep; do
  if ! command -v "$cmd" &> /dev/null; then
    missing+=("$cmd")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "error: missing required dependencies: ${missing[*]}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

echo "verifying rootfs..."

# Check file size
size=$(stat -c%s "$ROOTFS")
if [[ "$size" -lt 50000000 ]]; then
  echo "warning: rootfs seems small: ${size} bytes" >&2
fi

# Mount squashfs
MOUNT_DIR="$(mktemp -d)"
sudo mount -t squashfs -o loop,ro "$ROOTFS" "$MOUNT_DIR"

errors=()

# Check python3
if [[ -f "${MOUNT_DIR}/usr/bin/python3" ]]; then
  echo "  python3: found"
else
  errors+=("python3 not found at /usr/bin/python3")
fi

# Check guest binaries
dests=(
  "/usr/local/bin/guest-agent"
  "/usr/local/bin/guest-download"
  "/sbin/guest-init"
  "/usr/local/bin/guest-mock-claude"
)
for dest in "${dests[@]}"; do
  check_path="${MOUNT_DIR}${dest}"
  if [[ -f "$check_path" ]]; then
    echo "  ${dest}: found"
  else
    errors+=("${dest} not found")
  fi
done

# Check CLIs
if [[ -f "${MOUNT_DIR}/usr/bin/gh" ]]; then
  echo "  gh CLI: found"
else
  errors+=("gh CLI not found at /usr/bin/gh")
fi

# Check proxy CA in system bundle (compare against host CA cert)
bundle_path="${MOUNT_DIR}/etc/ssl/certs/ca-certificates.crt"
if [[ ! -f "$bundle_path" ]]; then
  errors+=("system CA bundle not found at /etc/ssl/certs/ca-certificates.crt")
else
  ca_line=$(sed -n '2p' "$CA_CERT")
  if [[ -z "$ca_line" ]]; then
    errors+=("proxy CA cert appears empty or malformed")
  elif grep -qF "$ca_line" "$bundle_path"; then
    echo "  proxy CA bundle: present"
  else
    errors+=("proxy CA not found in system CA bundle (update-ca-certificates may have failed)")
  fi
fi

# Unmount
sudo umount "$MOUNT_DIR"
rmdir "$MOUNT_DIR"
MOUNT_DIR=""

if [[ ${#errors[@]} -gt 0 ]]; then
  echo "error: rootfs verification failed:" >&2
  for err in "${errors[@]}"; do
    echo "  ${err}" >&2
  done
  exit 1
fi

echo "[OK] rootfs verification passed"
