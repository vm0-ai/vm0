export const CLI_AUTH_TOOLCHAIN_RUNTIME = "node24";
export const CLI_AUTH_TOOLCHAIN_SNAPSHOT_ID_ENV = "VERCEL_CLI_AUTH_SNAPSHOT_ID";
const CLI_AUTH_TOOLCHAIN_ROOT = "/vercel/sandbox/cli-auth/toolchain";
const CLI_AUTH_TOOLCHAIN_BIN_DIR = `${CLI_AUTH_TOOLCHAIN_ROOT}/bin`;
export const CLI_AUTH_TOOLCHAIN_MANIFEST_PATH = `${CLI_AUTH_TOOLCHAIN_ROOT}/manifest.json`;

export const CLI_AUTH_TOOLCHAIN_STRIPE_VERSION = "1.40.9";
const CLI_AUTH_TOOLCHAIN_STRIPE_ARCHIVE = `stripe_${CLI_AUTH_TOOLCHAIN_STRIPE_VERSION}_linux_x86_64.tar.gz`;
const CLI_AUTH_TOOLCHAIN_STRIPE_RELEASE_URL = `https://github.com/stripe/stripe-cli/releases/download/v${CLI_AUTH_TOOLCHAIN_STRIPE_VERSION}`;
export const CLI_AUTH_TOOLCHAIN_STRIPE_BIN = `${CLI_AUTH_TOOLCHAIN_BIN_DIR}/stripe`;

export function cliAuthStripeInstallScript(): string {
  return String.raw`set -euo pipefail
TOOLCHAIN_ROOT="${CLI_AUTH_TOOLCHAIN_ROOT}"
BIN_DIR="${CLI_AUTH_TOOLCHAIN_BIN_DIR}"
STRIPE_BIN="${CLI_AUTH_TOOLCHAIN_STRIPE_BIN}"
mkdir -p "$BIN_DIR"
if ! ([ -x "$STRIPE_BIN" ] && "$STRIPE_BIN" --version | grep -Eq "^stripe version ${CLI_AUTH_TOOLCHAIN_STRIPE_VERSION}\b"); then
  rm -f "$STRIPE_BIN"
  curl -fsSL "${CLI_AUTH_TOOLCHAIN_STRIPE_RELEASE_URL}/${CLI_AUTH_TOOLCHAIN_STRIPE_ARCHIVE}" -o "/tmp/${CLI_AUTH_TOOLCHAIN_STRIPE_ARCHIVE}"
  curl -fsSL "${CLI_AUTH_TOOLCHAIN_STRIPE_RELEASE_URL}/stripe-linux-checksums.txt" -o /tmp/stripe-linux-checksums.txt
  grep " ${CLI_AUTH_TOOLCHAIN_STRIPE_ARCHIVE}$" /tmp/stripe-linux-checksums.txt > /tmp/stripe-cli.sha256
  (cd /tmp && sha256sum -c stripe-cli.sha256) >&2
  tar -xzf "/tmp/${CLI_AUTH_TOOLCHAIN_STRIPE_ARCHIVE}" -C "$BIN_DIR" stripe
  chmod +x "$STRIPE_BIN"
fi
"$STRIPE_BIN" --version | grep -Eq "^stripe version ${CLI_AUTH_TOOLCHAIN_STRIPE_VERSION}\b"`;
}

export function cliAuthStripeVersionScript(): string {
  return String.raw`set -euo pipefail
"${CLI_AUTH_TOOLCHAIN_STRIPE_BIN}" --version`;
}

export function cliAuthStripeManifestScript(manifestJson: string): string {
  return String.raw`set -euo pipefail
mkdir -p "${CLI_AUTH_TOOLCHAIN_ROOT}"
cat > "${CLI_AUTH_TOOLCHAIN_MANIFEST_PATH}" <<'JSON'
${manifestJson}
JSON`;
}
