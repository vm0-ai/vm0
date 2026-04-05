#!/usr/bin/env bash
# verify-rootfs.sh — Verify contents of a built ext4 rootfs.
#
# This script is called by the Rust runner binary AFTER build-rootfs.sh.
# It is NOT included in the build-input hash, so changes here do not
# invalidate the rootfs cache.
#
# Usage:
#   bash verify-rootfs.sh --rootfs /path/to/rootfs.ext4

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

ROOTFS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rootfs) ROOTFS="$2"; shift 2 ;;
    *) echo "error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$ROOTFS" ]]; then
  echo "error: --rootfs is required" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CA_ROOTFS_DEST="usr/local/share/ca-certificates/vm0-proxy-ca.crt"

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

# Mount ext4 rootfs
MOUNT_DIR="$(mktemp -d)"
sudo mount -o loop,ro "$ROOTFS" "$MOUNT_DIR"

errors=()

# Check root directory permissions (must be 0755 for non-root users to access files)
root_perms=$(stat -c%a "$MOUNT_DIR")
if [[ "$root_perms" == "755" ]]; then
  echo "  root dir: 0755"
else
  errors+=("root directory has permissions 0${root_perms}, expected 0755")
fi

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
  "/sbin/guest-reseed"
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

# Check language runtimes
# Some binaries use update-alternatives symlinks or versioned names (e.g.
# php8.3 instead of php, javac under /usr/lib/jvm/). Use glob patterns
# and ls to handle both exact paths and wildcards.
check_bin() {
  local pattern="$1" name="$2"
  # shellcheck disable=SC2086
  if ls ${MOUNT_DIR}${pattern} &>/dev/null; then
    echo "  ${name}: found"
  else
    errors+=("${name} not found (pattern: ${pattern})")
  fi
}

check_bin "/usr/bin/ruby"                      "ruby"
check_bin "/usr/bin/php*"                      "php"
check_bin "/usr/lib/jvm/java-*/bin/javac"      "javac"
check_bin "/usr/local/go/bin/go"               "go"
check_bin "/usr/local/cargo/bin/rustc"         "rustc"
check_bin "/usr/bin/gcc"                       "gcc"
check_bin "/usr/bin/clang"                     "clang"

# Check databases
if [[ -f "${MOUNT_DIR}/usr/bin/psql" ]]; then
  echo "  psql: found"
else
  errors+=("psql not found at /usr/bin/psql")
fi

if [[ -f "${MOUNT_DIR}/usr/bin/redis-server" ]]; then
  echo "  redis-server: found"
else
  errors+=("redis-server not found at /usr/bin/redis-server")
fi

# Check proxy CA certificate file
ca_path="${MOUNT_DIR}/${CA_ROOTFS_DEST}"
if [[ -f "$ca_path" ]]; then
  echo "  proxy CA file: found"
else
  errors+=("proxy CA certificate not found")
fi

# Check proxy CA in system bundle
bundle_path="${MOUNT_DIR}/etc/ssl/certs/ca-certificates.crt"
if [[ ! -f "$bundle_path" ]]; then
  errors+=("system CA bundle not found at /etc/ssl/certs/ca-certificates.crt")
elif [[ -f "$ca_path" ]]; then
  # Read second line of CA cert as a unique identifier
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
MOUNT_DIR=""

if [[ ${#errors[@]} -gt 0 ]]; then
  echo "error: rootfs verification failed:" >&2
  for err in "${errors[@]}"; do
    echo "  ${err}" >&2
  done
  exit 1
fi

echo "[OK] rootfs verification passed"
