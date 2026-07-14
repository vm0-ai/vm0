#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
DEPS="$ROOT/crates/runner/src/deps.rs"
WORK_DIR=${RUNNER_TEMP:-/tmp}/vm0-firewall-hostname-contract
CACHE_DIR=${VM0_FIREWALL_HOSTNAME_ARTIFACT_CACHE:-$HOME/.cache/vm0/mitmproxy}
CORPUS_PATH="$WORK_DIR/canonical-hostnames.txt"
ARCH=$(uname -m)

case "$ARCH" in
  x86_64)
    RUST_ARCH=X86_64
    DOWNLOAD_ARCH=x86_64
    ;;
  aarch64)
    RUST_ARCH=AARCH64
    DOWNLOAD_ARCH=aarch64
    ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

rust_constant() {
  local name=$1
  local block
  local value
  block=$(sed -n "/^pub const ${name}:/,/;/p" "$DEPS" | tr '\n' ' ')
  if [[ -z "$block" ]]; then
    echo "Missing runner dependency constant: $name" >&2
    exit 1
  fi
  value=${block#*=}
  value=${value%%;*}
  value=${value//[\"_[:space:]]/}
  printf '%s' "$value"
}

VERSION=$(rust_constant MITMPROXY_VERSION)
ARCHIVE_SIZE=$(rust_constant "MITMPROXY_ARCHIVE_SIZE_${RUST_ARCH}")
ARCHIVE_SHA256=$(rust_constant "MITMPROXY_ARCHIVE_SHA256_${RUST_ARCH}")
MITMDUMP_SIZE=$(rust_constant "MITMDUMP_SIZE_${RUST_ARCH}")
MITMDUMP_SHA256=$(rust_constant "MITMDUMP_SHA256_${RUST_ARCH}")
ARCHIVE="$CACHE_DIR/mitmproxy-${VERSION}-linux-${DOWNLOAD_ARCH}-${ARCHIVE_SHA256}.tar.gz"
MITMDUMP="$WORK_DIR/mitmdump"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR" "$CACHE_DIR"

(
  cd "$ROOT/turbo"
  pnpm -F @vm0/connectors firewall-hostname-contract "$CORPUS_PATH"
)

if [[ ! -f "$ARCHIVE" ]]; then
  curl --fail --location --retry 3 \
    "https://downloads.mitmproxy.org/${VERSION}/mitmproxy-${VERSION}-linux-${DOWNLOAD_ARCH}.tar.gz" \
    --output "$ARCHIVE"
fi

if [[ $(stat --format='%s' "$ARCHIVE") != "$ARCHIVE_SIZE" ]]; then
  echo "Pinned mitmproxy archive size mismatch" >&2
  exit 1
fi
echo "${ARCHIVE_SHA256}  ${ARCHIVE}" | sha256sum --check --status

tar --extract --gzip --file "$ARCHIVE" --directory "$WORK_DIR" mitmdump
if [[ $(stat --format='%s' "$MITMDUMP") != "$MITMDUMP_SIZE" ]]; then
  echo "Pinned mitmdump size mismatch" >&2
  exit 1
fi
echo "${MITMDUMP_SHA256}  ${MITMDUMP}" | sha256sum --check --status
chmod +x "$MITMDUMP"

VM0_MITM_ADDON_SRC_PATH="$ROOT/crates/runner/mitm-addon/src" \
VM0_FIREWALL_HOSTNAME_CORPUS_PATH="$CORPUS_PATH" \
  "$MITMDUMP" \
  -s "$ROOT/crates/runner/mitm-addon/scripts/firewall_hostname_contract_probe.py"
