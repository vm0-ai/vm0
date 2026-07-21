#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
DEPS="$ROOT/crates/runner/src/deps.rs"
PROBE="$ROOT/crates/runner/mitm-addon/scripts/firewall_hostname_policy_contract_probe.py"
WORK_DIR=$(mktemp --directory "${RUNNER_TEMP:-/tmp}/vm0-firewall-hostname-policy.XXXXXX")
trap 'rm -rf -- "$WORK_DIR"' EXIT

case "$(uname -m)" in
  x86_64)
    RUST_ARCH=X86_64
    DOWNLOAD_ARCH=x86_64
    ;;
  aarch64)
    RUST_ARCH=AARCH64
    DOWNLOAD_ARCH=aarch64
    ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
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
MITMDUMP_ENTRY=$(rust_constant MITMDUMP_TAR_ENTRY)
MITMDUMP_SIZE=$(rust_constant "MITMDUMP_SIZE_${RUST_ARCH}")
MITMDUMP_SHA256=$(rust_constant "MITMDUMP_SHA256_${RUST_ARCH}")
ARCHIVE="$WORK_DIR/mitmproxy.tar.gz"
MITMDUMP="$WORK_DIR/$MITMDUMP_ENTRY"

curl \
  --fail \
  --location \
  --retry 3 \
  --retry-all-errors \
  --retry-max-time 300 \
  --connect-timeout 15 \
  --max-time 240 \
  --output "$ARCHIVE" \
  "https://downloads.mitmproxy.org/${VERSION}/mitmproxy-${VERSION}-linux-${DOWNLOAD_ARCH}.tar.gz"

if [[ $(stat --format='%s' "$ARCHIVE") != "$ARCHIVE_SIZE" ]]; then
  echo "Pinned mitmproxy archive size mismatch" >&2
  exit 1
fi
if ! echo "${ARCHIVE_SHA256}  ${ARCHIVE}" | sha256sum --check --status; then
  echo "Pinned mitmproxy archive SHA-256 mismatch" >&2
  exit 1
fi

tar --extract --gzip --file "$ARCHIVE" --directory "$WORK_DIR" -- "$MITMDUMP_ENTRY"
if [[ $(stat --format='%s' "$MITMDUMP") != "$MITMDUMP_SIZE" ]]; then
  echo "Pinned mitmdump size mismatch" >&2
  exit 1
fi
if ! echo "${MITMDUMP_SHA256}  ${MITMDUMP}" | sha256sum --check --status; then
  echo "Pinned mitmdump SHA-256 mismatch" >&2
  exit 1
fi
chmod +x "$MITMDUMP"

timeout --signal=TERM --kill-after=5s 60s "$MITMDUMP" -s "$PROBE"
echo "Pinned mitmdump hostname policy contract passed (${DOWNLOAD_ARCH})"
