#!/usr/bin/env bash
set -euo pipefail

if command -v stripe >/dev/null 2>&1; then
  stripe --version
  exit 0
fi

version="${STRIPE_CLI_VERSION:-1.41.2}"

case "$(uname -s)" in
  Linux)
    os="linux"
    ;;
  *)
    echo "Unsupported Stripe CLI platform: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64 | amd64)
    arch="x86_64"
    ;;
  aarch64 | arm64)
    arch="arm64"
    ;;
  *)
    echo "Unsupported Stripe CLI architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

curl --fail --show-error --silent --location \
  --retry 5 \
  --retry-delay 2 \
  --retry-max-time 60 \
  --retry-all-errors \
  "https://github.com/stripe/stripe-cli/releases/download/v${version}/stripe_${version}_${os}_${arch}.tar.gz" \
  -o "$tmp_dir/stripe.tar.gz"
tar -xzf "$tmp_dir/stripe.tar.gz" -C "$tmp_dir"

install_dir="${STRIPE_CLI_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$install_dir"
cp "$tmp_dir/stripe" "$install_dir/stripe"
chmod 0755 "$install_dir/stripe"

if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$install_dir" >> "$GITHUB_PATH"
fi

export PATH="$install_dir:$PATH"
stripe --version
