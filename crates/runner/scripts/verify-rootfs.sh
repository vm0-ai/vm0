#!/usr/bin/env bash
# verify-rootfs.sh — Verify contents of a template or rootfs ext4 image.
#
# This script is called by the Rust runner binary for template validation
# and again after customize-rootfs.sh for rootfs validation.
# It is NOT included in the build-input hash, so changes here do not
# invalidate template or rootfs cache entries.
#
# Runs inside a private mount namespace so read-only loop mounts are reclaimed
# by the kernel if the script is hard-killed before the EXIT trap runs.
#
# Usage:
#   bash verify-rootfs.sh --rootfs /path/to/image.ext4 [--mode template|rootfs]

set -euo pipefail

readonly UNSHARE_SENTINEL="--__vm0_unshared__"
if [[ "${1:-}" != "$UNSHARE_SENTINEL" ]]; then
  for cmd in sudo unshare; do
    if ! command -v "$cmd" &> /dev/null; then
      echo "error: $cmd not found (sudo is required to enter a mount namespace; unshare from util-linux)" >&2
      exit 1
    fi
  done
  exec sudo unshare --mount --propagation private \
    -- bash "$0" "$UNSHARE_SENTINEL" "$@"
fi
shift

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

ROOTFS=""
MODE="rootfs"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rootfs) ROOTFS="$2"; shift 2 ;;
    --mode)   MODE="$2";   shift 2 ;;
    *) echo "error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$ROOTFS" ]]; then
  echo "error: --rootfs is required" >&2
  exit 1
fi
if [[ "$MODE" != "template" && "$MODE" != "rootfs" ]]; then
  echo "error: --mode must be template or rootfs" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# [sync:ca-constants] Keep in sync with: crates/runner/scripts/customize-rootfs.sh.
# Enforced by the `ca_constants_in_sync_across_scripts`
# test in cmd/build.rs at compile time.
CA_ROOTFS_DEST="usr/local/share/ca-certificates/vm0-proxy-ca.crt"

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

MOUNT_DIR=""

unmount_with_retries() {
  local target="$1"
  local attempt
  for attempt in 1 2 3; do
    if sudo umount "$target" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  sudo umount "$target"
}

cleanup() {
  local status=$?
  local cleanup_failed=0

  if [[ -n "$MOUNT_DIR" ]]; then
    if mountpoint -q "$MOUNT_DIR" 2>/dev/null; then
      if ! unmount_with_retries "$MOUNT_DIR"; then
        cleanup_failed=1
      fi
    fi
    if ! rmdir "$MOUNT_DIR" 2>/dev/null; then
      cleanup_failed=1
    fi
  fi

  if [[ "$cleanup_failed" -ne 0 && "$status" -eq 0 ]]; then
    echo "error: ${MODE} verification cleanup failed" >&2
    status=1
  fi
  exit "$status"
}

trap cleanup EXIT

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

missing=()
for cmd in sudo unshare mount umount mountpoint stat mktemp sed grep; do
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

echo "verifying ${MODE} image..."

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

guest_dests=(
  "/usr/local/bin/guest-agent"
  "/usr/local/bin/guest-download"
  "/sbin/guest-init"
  "/usr/local/bin/guest-mock-claude"
  "/usr/local/bin/guest-mock-codex"
  "/sbin/guest-reseed"
  "/sbin/guest-write-file"
)
if [[ "$MODE" == "rootfs" ]]; then
  # Check guest binaries
  for dest in "${guest_dests[@]}"; do
    check_path="${MOUNT_DIR}${dest}"
    if [[ -f "$check_path" ]]; then
      echo "  ${dest}: found"
    else
      errors+=("${dest} not found")
    fi
  done
else
  guest_contamination=0
  for dest in "${guest_dests[@]}"; do
    if [[ -e "${MOUNT_DIR}${dest}" || -L "${MOUNT_DIR}${dest}" ]]; then
      errors+=("template contains rootfs-only guest binary: ${dest}")
      guest_contamination=1
    fi
  done
  if [[ "$guest_contamination" -eq 0 ]]; then
    echo "  rootfs-only guest binaries: absent"
  fi
fi

# Check CLIs
if [[ -f "${MOUNT_DIR}/usr/bin/gh" ]]; then
  echo "  gh CLI: found"
else
  errors+=("gh CLI not found at /usr/bin/gh")
fi

# npm-global bins land in /usr/bin (NodeSource Node 24 sets npm prefix to /usr).
if [[ -f "${MOUNT_DIR}/usr/bin/codex" ]]; then
  echo "  codex CLI: found"
else
  errors+=("codex CLI not found at /usr/bin/codex")
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

ca_path="${MOUNT_DIR}/${CA_ROOTFS_DEST}"
env_path="${MOUNT_DIR}/etc/environment"
resolv_path="${MOUNT_DIR}/etc/resolv.conf"

if [[ "$MODE" == "rootfs" ]]; then
  # Check proxy CA certificate file
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
    # Read second line of CA cert as a unique identifier. Reject an
    # empty line 2 or a PEM header/footer on line 2 (latter happens
    # when the source cert has a leading blank line) — matching either
    # against the bundle with `grep -F` would false-positive because
    # every cert in the bundle has BEGIN/END framing lines. `-- "$pat"`
    # also stops option parsing so a pattern starting with `-` can
    # never be mistaken for a grep flag.
    ca_line=$(sed -n '2p' "$ca_path")
    if [[ -z "$ca_line" ]] \
        || [[ "$ca_line" == -----BEGIN* ]] \
        || [[ "$ca_line" == -----END* ]]; then
      errors+=("proxy CA cert appears empty or malformed (line 2 missing or PEM framing)")
    elif grep -qF -- "$ca_line" "$bundle_path"; then
      echo "  proxy CA bundle: updated"
    else
      errors+=("proxy CA not found in system CA bundle (update-ca-certificates may have failed)")
    fi
  fi
else
  template_contamination=0
  if [[ -e "$ca_path" || -L "$ca_path" ]]; then
    errors+=("template contains rootfs-only proxy CA certificate")
    template_contamination=1
  fi
  if [[ -f "$env_path" ]] \
      && grep -Eq '^(NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|REQUESTS_CA_BUNDLE|CARGO_HTTP_CAINFO)=' "$env_path"; then
    errors+=("template contains rootfs-only environment CA settings")
    template_contamination=1
  fi
  if [[ -s "$resolv_path" ]]; then
    errors+=("template contains rootfs-only resolv.conf content")
    template_contamination=1
  fi
  if [[ "$template_contamination" -eq 0 ]]; then
    echo "  rootfs-only CA/env/resolver: absent"
  fi
fi

# Unmount
unmount_with_retries "$MOUNT_DIR"
rmdir "$MOUNT_DIR"
MOUNT_DIR=""

if [[ ${#errors[@]} -gt 0 ]]; then
  echo "error: ${MODE} verification failed:" >&2
  for err in "${errors[@]}"; do
    echo "  ${err}" >&2
  done
  exit 1
fi

echo "[OK] ${MODE} verification passed"
