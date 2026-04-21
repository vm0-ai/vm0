#!/usr/bin/env bash
# build-rootfs.sh — Build an ext4 rootfs image for Firecracker VMs.
#
# This script is called by the Rust runner binary. Its content is hashed as
# part of the build-input hash, so any change here automatically invalidates
# the rootfs cache.
#
# Uses debootstrap + chroot instead of Docker to avoid the Docker daemon
# dependency and eliminate multiple I/O round-trips (tar export, tar extract,
# cp to ext4 mount). mkfs.ext4 -d populates the ext4 image directly from
# the rootfs directory.
#
# The build runs inside a private mount namespace (via `unshare --mount
# --propagation private`). Bind mounts of host /proc, /sys, /dev created
# for chroot operations are confined to this namespace — the host never
# sees them, and the kernel auto-unmounts everything when the script exits
# (including on SIGKILL, where the EXIT trap would not fire).
#
# `rm -rf --one-file-system` in the cleanup trap is a hard safety net: even
# if umount fails inside our namespace, rm refuses to cross the bind-mount
# boundary, eliminating any risk of unlinking host /dev entries through the
# shared devtmpfs superblock.
#
# The output rootfs file is chowned back to $SUDO_USER at the end so the
# runner can operate on it without sudo (matches pre-unshare ownership).
#
# Usage:
#   bash build-rootfs.sh \
#     --output-dir /path/to/output \
#     --ca-dir /path/to/ca \
#     --debootstrap-dir /path/to/cache \
#     --hash <input-hash> \
#     --disk-mb 16384 \
#     --dns-nameserver 8.8.8.8 \
#     --guest-agent /path/to/guest-agent \
#     --guest-download /path/to/guest-download \
#     --guest-init /path/to/guest-init \
#     --guest-mock-claude /path/to/guest-mock-claude \
#     [--mirror http://archive.ubuntu.com/ubuntu]

set -euo pipefail

# ---------------------------------------------------------------------------
# Re-exec inside a private mount namespace
# ---------------------------------------------------------------------------
#
# Uses a positional sentinel (not an env var) so we don't depend on sudoers
# allowing env preservation. The sentinel is prefixed with `__vm0_` to make
# an accidental arg collision vanishingly unlikely.
readonly UNSHARE_SENTINEL="--__vm0_unshared__"
if [[ "${1:-}" != "$UNSHARE_SENTINEL" ]]; then
  for cmd in sudo unshare; do
    if ! command -v "$cmd" &>/dev/null; then
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

OUTPUT_DIR=""
CA_DIR=""
DEBOOTSTRAP_DIR=""
INPUT_HASH=""
DISK_MB=""
GUEST_AGENT=""
GUEST_DOWNLOAD=""
GUEST_INIT=""
GUEST_MOCK_CLAUDE=""
GUEST_RESEED=""
DNS_NAMESERVER=""
# Default mirror: archive.ubuntu.com only hosts amd64/i386;
# arm64 and other ports use ports.ubuntu.com.
if [[ "$(dpkg --print-architecture 2>/dev/null)" == "arm64" ]]; then
  MIRROR="http://ports.ubuntu.com/ubuntu-ports"
else
  MIRROR="http://archive.ubuntu.com/ubuntu"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)        OUTPUT_DIR="$2";        shift 2 ;;
    --ca-dir)            CA_DIR="$2";            shift 2 ;;
    --debootstrap-dir)   DEBOOTSTRAP_DIR="$2";   shift 2 ;;
    --hash)              INPUT_HASH="$2";        shift 2 ;;
    --disk-mb)           DISK_MB="$2";           shift 2 ;;
    --guest-agent)       GUEST_AGENT="$2";       shift 2 ;;
    --guest-download)    GUEST_DOWNLOAD="$2";    shift 2 ;;
    --guest-init)        GUEST_INIT="$2";        shift 2 ;;
    --guest-mock-claude) GUEST_MOCK_CLAUDE="$2"; shift 2 ;;
    --guest-reseed)      GUEST_RESEED="$2";      shift 2 ;;
    --dns-nameserver)    DNS_NAMESERVER="$2";    shift 2 ;;
    --mirror)            MIRROR="$2";            shift 2 ;;
    *) echo "error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

for var in OUTPUT_DIR CA_DIR DEBOOTSTRAP_DIR INPUT_HASH DISK_MB GUEST_AGENT GUEST_DOWNLOAD GUEST_INIT GUEST_MOCK_CLAUDE GUEST_RESEED DNS_NAMESERVER; do
  if [[ -z "${!var}" ]]; then
    echo "error: --$(echo "$var" | tr '_' '-' | tr '[:upper:]' '[:lower:]') is required" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ROOTFS_FILE="rootfs.ext4"
# [sync:ca-constants] Keep in sync with: crates/runner/scripts/inject-ca.sh
# and verify-rootfs.sh. Enforced by the `ca_constants_in_sync_across_scripts`
# test in cmd/build.rs at compile time.
CA_CERT_FILE="mitmproxy-ca-cert.pem"
CA_ROOTFS_DEST="usr/local/share/ca-certificates/vm0-proxy-ca.crt"

# `$$` here is the *inner* (post-re-exec) bash PID — sudo forks, so the
# inner PID differs from any outer bash that may have invoked the script
# without the UNSHARE_SENTINEL. Do not read `$$` above the re-exec gate
# and expect the same value here.
TMP_ROOTFS="${ROOTFS_FILE}.tmp.$$"

# Paths derived from arguments
ROOTFS_PATH="${OUTPUT_DIR}/${ROOTFS_FILE}"
TMP_ROOTFS_PATH="${OUTPUT_DIR}/${TMP_ROOTFS}"
ROOTFS_DIR=""

# Pinned versions (changes here invalidate the rootfs cache via script hash)
GO_VERSION="1.26.2"
CLAUDE_CODE_VERSION="2.1.116"
GWS_CLI_VERSION="0.22.5"
XURL_VERSION="1.0.3"
AGENT_BROWSER_VERSION="0.26.0"

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

check_dependencies() {
  local missing=()

  for cmd in debootstrap sudo chroot mktemp stat mkfs.ext4 umount mountpoint unshare; do
    if ! command -v "$cmd" &> /dev/null; then
      missing+=("$cmd")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "error: missing required dependencies: ${missing[*]}" >&2
    exit 1
  fi

  echo "[OK] all dependencies found"
}

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

readonly UMOUNT_ATTEMPTS=3
readonly UMOUNT_BACKOFF_SECONDS=0.5

cleanup_chroot() {
  if [[ -z "$ROOTFS_DIR" ]]; then
    return
  fi
  # -R unmounts recursively — bind-mounting /dev brings in sub-mounts
  # like /dev/shm, /dev/mqueue, /dev/hugepages that must be removed first.
  # Retry handles transient EBUSY from chroot subprocesses that haven't
  # fully exited yet. We buffer every attempt's stderr and dump all of
  # them on final failure so diagnostic output covers the full sequence
  # (attempt 1 EPERM vs attempt 3 EBUSY etc.) rather than just the last.
  local target attempt err_log attempt_err
  local any_failure=0
  for target in "$ROOTFS_DIR/dev" "$ROOTFS_DIR/sys" "$ROOTFS_DIR/proc"; do
    # Skip if never mounted (e.g. early failure before debootstrap_build
    # installed the binds). Avoids retrying umount on plain dirs and
    # polluting CI logs with "not mounted" errors.
    if ! mountpoint -q "$target" 2>/dev/null; then
      continue
    fi
    err_log=""
    for (( attempt=1; attempt <= UMOUNT_ATTEMPTS; attempt++ )); do
      if attempt_err=$(sudo umount -R "$target" 2>&1); then
        break
      fi
      err_log+="attempt ${attempt}: ${attempt_err}"$'\n'
      (( attempt < UMOUNT_ATTEMPTS )) && sleep "$UMOUNT_BACKOFF_SECONDS"
    done
    # All attempts exhausted for this target — surface the buffered error
    # sequence and remember the failure, but keep going so the remaining
    # targets also get a chance to unmount.
    if (( attempt > UMOUNT_ATTEMPTS )); then
      printf '%s' "$err_log" >&2
      any_failure=1
    fi
  done
  # Non-zero return aborts via set -e in the pre-mkfs call (polluted ext4
  # is worse than a failed build); the EXIT trap wraps in `|| true` so
  # this does not interrupt the remainder of cleanup.
  return "$any_failure"
}

cleanup() {
  echo "cleaning up..."
  # Best-effort umount on the failure path. Errors surface to stderr but
  # `|| true` keeps the rest of cleanup running under set -e.
  cleanup_chroot || true
  if [[ -n "$ROOTFS_DIR" ]]; then
    # `--one-file-system`: if cleanup_chroot failed, $ROOTFS_DIR/{dev,sys,proc}
    # still bind-mount host devtmpfs/procfs/sysfs. Because bind mounts share
    # the source superblock (private propagation only confines mount events,
    # not inode data), a plain `rm -rf` could unlink host /dev/null etc.
    # This flag makes rm refuse to cross the bind-mount boundary, trading a
    # leaked tmp dir for guaranteed host safety. The leak itself is bounded:
    # the private mount namespace dies with this script and the kernel
    # reclaims both the mounts and (via systemd-tmpfiles) the /tmp entry.
    sudo rm -rf --one-file-system "$ROOTFS_DIR" || true
  fi
  rm -f "$TMP_ROOTFS_PATH" || true
}

trap cleanup EXIT
# Surface the failing command + line number on set -e-driven aborts. Fires
# only for commands that would propagate to set -e (i.e. not in `|| true`,
# `if`, etc.), so it doesn't spam on deliberately-handled failures.
trap 'echo "error: command failed at line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

# ---------------------------------------------------------------------------
# Bootstrap Ubuntu 24.04 rootfs
# ---------------------------------------------------------------------------

debootstrap_build() {
  echo "bootstrapping Ubuntu 24.04 rootfs..."
  ROOTFS_DIR="$(mktemp -d)"

  # Cache the base package tarball so repeated builds (e.g. after changing
  # a pinned version) skip the ~200 MB download from the Ubuntu mirror.
  local cache_tar="${DEBOOTSTRAP_DIR}/noble-$(dpkg --print-architecture).tar"
  if [[ -f "$cache_tar" ]]; then
    echo "using cached debootstrap tarball: $cache_tar"
    sudo debootstrap --unpack-tarball="$(realpath "$cache_tar")" noble "$ROOTFS_DIR" "$MIRROR"
    sudo touch "$cache_tar"
  else
    # --make-tarball downloads packages into a tarball without extracting.
    # It always exits non-zero ("cannot exec ...") because it skips the
    # second stage, so we check the tarball was created instead.
    sudo debootstrap --make-tarball="$cache_tar" noble "$ROOTFS_DIR" "$MIRROR" || true
    if [[ ! -s "$cache_tar" ]]; then
      echo "error: debootstrap --make-tarball failed to create $cache_tar" >&2
      exit 1
    fi
    sudo debootstrap --unpack-tarball="$(realpath "$cache_tar")" noble "$ROOTFS_DIR" "$MIRROR"
  fi

  # Mount virtual filesystems for chroot operations.
  # --bind /dev recursively brings in sub-mounts (pts, shm, etc.);
  # cleanup_chroot uses umount -R to tear them all down.
  sudo mount --bind /proc "$ROOTFS_DIR/proc"
  sudo mount --bind /sys "$ROOTFS_DIR/sys"
  sudo mount --bind /dev "$ROOTFS_DIR/dev"

  # Copy host DNS for build-time package downloads (overwritten by inject_files)
  sudo rm -f "$ROOTFS_DIR/etc/resolv.conf"
  sudo cp /etc/resolv.conf "$ROOTFS_DIR/etc/resolv.conf"

  echo "[OK] base system bootstrapped"
}

# ---------------------------------------------------------------------------
# Install APT packages
# ---------------------------------------------------------------------------

install_packages() {
  echo "installing packages..."

  # Step 1: Enable universe repo (debootstrap only enables main) and install
  # bootstrap tools needed to add external APT repositories.
  sudo chroot "$ROOTFS_DIR" bash -c 'set -e
  export DEBIAN_FRONTEND=noninteractive
  # debootstrap generates DEB822-format sources with "Components: main".
  # Add universe for packages like ripgrep.
  if [[ -f /etc/apt/sources.list.d/ubuntu.sources ]]; then
    sed -i "s/^Components: main$/Components: main universe/" /etc/apt/sources.list.d/ubuntu.sources
  else
    sed -i "s/ main$/ main universe/" /etc/apt/sources.list
  fi
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  '

  # Step 2: Add external APT repositories (needs curl and gpg from step 1).
  sudo chroot "$ROOTFS_DIR" bash -c 'set -e
  # NodeSource repository (Node.js 24)
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  printf "Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n" \
    > /etc/apt/preferences.d/nodesource

  # GitHub CLI repository
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    > /usr/share/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  '

  # Step 3: Install all Ubuntu packages in single pass.
  sudo chroot "$ROOTFS_DIR" bash -c 'set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y \
    procps wget git ripgrep jq file iproute2 sudo ffmpeg \
    libnss3 p11-kit-modules unzip \
    nodejs \
    python3 python3-pip \
    ruby-full bundler \
    php php-cli php-common php-curl php-mbstring php-xml php-zip \
    default-jdk maven gradle \
    gcc g++ clang make cmake \
    postgresql-16 postgresql-contrib \
    redis-server \
    gh

  # Clean up third-party APT sources (no longer needed at runtime)
  rm -f /etc/apt/sources.list.d/nodesource.list \
       /etc/apt/preferences.d/nodesource \
       /usr/share/keyrings/nodesource.gpg \
       /etc/apt/sources.list.d/github-cli.list \
       /usr/share/keyrings/githubcli-archive-keyring.gpg
  rm -rf /var/lib/apt/lists/* /var/cache/apt/*
  '

  # Chromium from Debian Bookworm (Ubuntu 24.04 snap stub does not work).
  # Installed separately to avoid cross-distro dependency conflicts.
  sudo chroot "$ROOTFS_DIR" bash -c 'set -e
    export DEBIAN_FRONTEND=noninteractive
    curl -fsSL https://ftp-master.debian.org/keys/archive-key-12.asc \
      | gpg --dearmor -o /usr/share/keyrings/debian-bookworm.gpg
    echo "deb [signed-by=/usr/share/keyrings/debian-bookworm.gpg] http://deb.debian.org/debian bookworm main" \
      > /etc/apt/sources.list.d/debian-bookworm.list
    apt-get update
    apt-get install -y -t bookworm chromium
    rm -f /etc/apt/sources.list.d/debian-bookworm.list \
         /usr/share/keyrings/debian-bookworm.gpg
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*
  '

  # Make NSS-based applications (Chromium, Firefox) trust the system CA store.
  # Replace Mozilla built-in trust module with p11-kit so proxy CA certs
  # injected via update-ca-certificates are trusted by all applications.
  sudo chroot "$ROOTFS_DIR" bash -c 'set -e
    find /usr/lib -name libnssckbi.so -exec sh -c \
      '\''p11=$(find /usr/lib -name p11-kit-trust.so | head -1) && ln -sf "$p11" "$1"'\'' _ {} \;
  '

  echo "[OK] packages installed"
}

# ---------------------------------------------------------------------------
# Install non-APT runtimes and tools
# ---------------------------------------------------------------------------

install_runtimes() {
  echo "installing language runtimes and CLIs..."

  # User account (Ubuntu 24.04 ships 'ubuntu' at UID 1000; remove it first)
  sudo chroot "$ROOTFS_DIR" bash -c '
    userdel -r ubuntu 2>/dev/null || true
    useradd -m -u 1000 -s /bin/bash user
    usermod -aG sudo,postgres user
    echo "user ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
    passwd -d user
  '

  # Go (official tarball)
  sudo chroot "$ROOTFS_DIR" bash -c "
    ARCH=\$(dpkg --print-architecture)
    curl -fsSL \"https://go.dev/dl/go${GO_VERSION}.linux-\${ARCH}.tar.gz\" -o /tmp/go.tar.gz
    tar -C /usr/local -xzf /tmp/go.tar.gz
    rm /tmp/go.tar.gz
    ln -s /usr/local/go/bin/go /usr/local/bin/go
    ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt
    echo 'export PATH=\$PATH:\$HOME/go/bin' > /etc/profile.d/golang.sh
  "

  # Rust (stable toolchain via rustup)
  sudo chroot "$ROOTFS_DIR" bash -c '
    export RUSTUP_HOME=/usr/local/rustup
    export CARGO_HOME=/usr/local/cargo
    curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain stable --no-modify-path
    for bin in /usr/local/cargo/bin/*; do ln -s "$bin" /usr/local/bin/; done
    printf "export RUSTUP_HOME=/usr/local/rustup\nexport CARGO_HOME=\$HOME/.cargo\nexport PATH=\$PATH:\$HOME/.cargo/bin\n" \
      > /etc/profile.d/rust.sh
  '

  # PHP Composer
  sudo chroot "$ROOTFS_DIR" bash -c '
    curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
  '

  # Claude Code CLI (standalone Bun-compiled binary)
  sudo chroot "$ROOTFS_DIR" bash -c "
    ARCH=\$(dpkg --print-architecture)
    case \"\$ARCH\" in
      amd64) PLATFORM=\"linux-x64\" ;;
      arm64) PLATFORM=\"linux-arm64\" ;;
      *) echo \"Unsupported architecture: \$ARCH\" >&2; exit 1 ;;
    esac
    GCS_BUCKET=\"https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases\"
    curl -fsSL \"\${GCS_BUCKET}/${CLAUDE_CODE_VERSION}/\${PLATFORM}/claude\" -o /usr/local/bin/claude
    CHECKSUM=\$(curl -fsSL \"\${GCS_BUCKET}/${CLAUDE_CODE_VERSION}/manifest.json\" \
      | jq -r \".platforms[\\\"\$PLATFORM\\\"].checksum\")
    echo \"\${CHECKSUM}  /usr/local/bin/claude\" | sha256sum -c -
    chmod +x /usr/local/bin/claude
  "

  # npm global packages (combined into one install)
  sudo chroot "$ROOTFS_DIR" bash -c "
    npm install -g \
      @googleworkspace/cli@${GWS_CLI_VERSION} \
      @xdevplatform/xurl@${XURL_VERSION} \
      agent-browser@${AGENT_BROWSER_VERSION}
    npm cache clean --force
  "

  echo "[OK] runtimes and CLIs installed"
}

# ---------------------------------------------------------------------------
# Inject guest binaries, CA certificates, and configuration files
# ---------------------------------------------------------------------------

inject_files() {
  echo "injecting guest binaries and CA..."

  # Final resolv.conf for the VM (single nameserver — UDP 53 redirected to dnsmasq)
  sudo rm -f "$ROOTFS_DIR/etc/resolv.conf"
  echo "nameserver ${DNS_NAMESERVER}" | sudo tee "$ROOTFS_DIR/etc/resolv.conf" > /dev/null

  # Write /etc/hosts — the VM has no mDNS and resolv.conf only lists
  # external nameservers, so "localhost" would fail to resolve without this.
  printf '%s\n' \
    "127.0.0.1 localhost" \
    "::1 localhost" \
    | sudo tee "$ROOTFS_DIR/etc/hosts" > /dev/null

  # Install guest binaries
  local -a bins=(
    "${GUEST_AGENT}:/usr/local/bin/guest-agent"
    "${GUEST_DOWNLOAD}:/usr/local/bin/guest-download"
    "${GUEST_INIT}:/sbin/guest-init"
    "${GUEST_MOCK_CLAUDE}:/usr/local/bin/guest-mock-claude"
    "${GUEST_RESEED}:/sbin/guest-reseed"
  )
  for entry in "${bins[@]}"; do
    local src="${entry%%:*}"
    local dest="${entry#*:}"
    local target="${ROOTFS_DIR}${dest}"
    sudo cp "$src" "$target"
    sudo chmod 755 "$target"
    echo "[OK] installed ${dest}"
  done

  # Install proxy CA certificate (generated by `runner build` in CA_DIR)
  local ca_cert="${CA_DIR}/${CA_CERT_FILE}"
  if [[ ! -f "$ca_cert" ]]; then
    echo "error: proxy CA cert not found at ${ca_cert} — run 'runner build' (not this script directly)" >&2
    exit 1
  fi

  local ca_target="${ROOTFS_DIR}/${CA_ROOTFS_DEST}"
  sudo mkdir -p "$(dirname "$ca_target")"
  sudo cp "$ca_cert" "$ca_target"
  sudo chmod 644 "$ca_target"

  # Update system CA bundle (OpenSSL/NSS).
  # proc/sys/dev are still mounted from debootstrap_build.
  sudo chroot "$ROOTFS_DIR" update-ca-certificates

  # Import proxy CA into Java's separate trust store (cacerts keystore).
  # Java does not read the system CA bundle — it has its own PKCS12 keystore.
  # keytool finds libjli.so via its baked-in RPATH [$ORIGIN:$ORIGIN/../lib];
  # $ORIGIN resolves because debootstrap_build bind-mounts /proc into the
  # chroot (glibc reads /proc/self/exe for $ORIGIN).
  sudo chroot "$ROOTFS_DIR" keytool -importcert -trustcacerts \
    -keystore /etc/ssl/certs/java/cacerts \
    -storepass changeit -noprompt \
    -alias vm0-proxy-ca \
    -file "/${CA_ROOTFS_DEST}"

  # Write /etc/environment (read by PAM for all login sessions).
  # [sync:etc-environment] Keep in sync with: .github/workflows/crates.yml (runner-exec Test 5)
  # - LANG: locale
  # - NPM_CONFIG_UPDATE_NOTIFIER: suppress npm update nags
  # - NODE_EXTRA_CA_CERTS: Node.js uses its own root CAs, not the system bundle
  # - SSL_CERT_FILE: Python (certifi/pip/requests), Go, Rust (native-tls)
  # - REQUESTS_CA_BUNDLE: Python requests library
  # - CARGO_HTTP_CAINFO: Rust cargo (rustls backend ignores system CAs)
  printf '%s\n' \
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "LANG=C.UTF-8" \
    "NPM_CONFIG_UPDATE_NOTIFIER=false" \
    "NODE_EXTRA_CA_CERTS=/${CA_ROOTFS_DEST}" \
    "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt" \
    "REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt" \
    "CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt" \
    | sudo tee "${ROOTFS_DIR}/etc/environment" > /dev/null

  echo "[OK] proxy CA installed and system bundle updated"
}

# ---------------------------------------------------------------------------
# ext4 image creation
# ---------------------------------------------------------------------------

create_ext4() {
  echo "creating ext4 image..."

  local content_bytes
  content_bytes=$(sudo du -sb "$ROOTFS_DIR" | cut -f1)
  local image_bytes=$(( DISK_MB * 1024 * 1024 ))

  if (( image_bytes < content_bytes )); then
    local content_mb=$(( content_bytes / 1024 / 1024 ))
    echo "error: disk_mb (${DISK_MB} MiB) is smaller than rootfs content (${content_mb} MiB)" >&2
    exit 1
  fi

  # Derive a deterministic UUID from the input hash. ext4 uses the UUID as
  # the htree seed for directory hashing — a fixed UUID ensures identical
  # block layout for identical content, making the rootfs reproducible.
  local fs_uuid="${INPUT_HASH:0:8}-${INPUT_HASH:8:4}-${INPUT_HASH:12:4}-${INPUT_HASH:16:4}-${INPUT_HASH:20:12}"

  # mktemp -d creates 0700; ext4 root inode must be 0755 for non-root access.
  sudo chmod 755 "$ROOTFS_DIR"

  # Create ext4 image populated directly from directory (no loopback mount needed)
  truncate -s "$image_bytes" "$TMP_ROOTFS_PATH"
  mkfs.ext4 -F -q -U "$fs_uuid" -d "$ROOTFS_DIR" "$TMP_ROOTFS_PATH"

  echo "[OK] ext4 image created"
}

# ---------------------------------------------------------------------------
# Main (runs inside the private mount namespace set up by the re-exec above)
# ---------------------------------------------------------------------------

check_dependencies
debootstrap_build
install_packages
install_runtimes
inject_files

# Unmount virtual filesystems before creating ext4 image
cleanup_chroot

create_ext4

# Move into final place
mv "$TMP_ROOTFS_PATH" "$ROOTFS_PATH"

# The unshare re-exec escalates to root, so the rootfs file was created
# as root. Restore ownership to the invoking user so downstream callers
# (runner reading/replacing the file) don't need sudo. SUDO_USER is set
# by the outer sudo at re-exec time; if it is missing or "root" the
# chown is a no-op.
#
# Don't fail the build on chown error: the artifact is valid on disk and
# mode 644 makes it world-readable, so a mis-ownership is cosmetic — the
# runner can still consume it. Warn instead so operators can investigate.
if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
  chown "$SUDO_USER" "$ROOTFS_PATH" \
    || echo "warning: chown $SUDO_USER $ROOTFS_PATH failed; file remains root-owned" >&2
fi

# Report size
SIZE=$(stat -c%s "$ROOTFS_PATH")
SIZE_MB=$((SIZE / 1024 / 1024))
echo "[OK] rootfs built: ${ROOTFS_PATH} (${SIZE_MB} MiB)"
