#!/usr/bin/env bash
# build-rootfs.sh — Build an ext4 rootfs image for Firecracker VMs.
#
# This script is called by the Rust runner binary. Its content is hashed as
# part of the build-input hash, so any change here automatically invalidates
# the rootfs cache.
#
# Usage:
#   bash build-rootfs.sh \
#     --output-dir /path/to/output \
#     --work-dir /path/to/workdir \
#     --ca-dir /path/to/ca \
#     --disk-mb 16384 \
#     --guest-agent /path/to/guest-agent \
#     --guest-download /path/to/guest-download \
#     --guest-init /path/to/guest-init \
#     --guest-mock-claude /path/to/guest-mock-claude

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

OUTPUT_DIR=""
WORK_DIR=""
CA_DIR=""
INPUT_HASH=""
DISK_MB=""
GUEST_AGENT=""
GUEST_DOWNLOAD=""
GUEST_INIT=""
GUEST_MOCK_CLAUDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)       OUTPUT_DIR="$2";       shift 2 ;;
    --work-dir)   WORK_DIR="$2";   shift 2 ;;
    --ca-dir)     CA_DIR="$2";     shift 2 ;;
    --hash)       INPUT_HASH="$2"; shift 2 ;;
    --disk-mb)    DISK_MB="$2";    shift 2 ;;
    --guest-agent)      GUEST_AGENT="$2";      shift 2 ;;
    --guest-download)   GUEST_DOWNLOAD="$2";   shift 2 ;;
    --guest-init)       GUEST_INIT="$2";       shift 2 ;;
    --guest-mock-claude) GUEST_MOCK_CLAUDE="$2"; shift 2 ;;
    *) echo "error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

for var in OUTPUT_DIR WORK_DIR CA_DIR INPUT_HASH DISK_MB GUEST_AGENT GUEST_DOWNLOAD GUEST_INIT GUEST_MOCK_CLAUDE; do
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
ROOTFS_FILE="rootfs.ext4"
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
EXT4_MOUNT_DIR=""

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

check_dependencies() {
  local missing=()

  for cmd in docker sudo tar chroot mktemp stat mkfs.ext4; do
    if ! command -v "$cmd" &> /dev/null; then
      missing+=("$cmd")
    fi
  done

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
  # Unmount ext4 loop mount if still active
  if [[ -n "$EXT4_MOUNT_DIR" ]]; then
    sudo umount "$EXT4_MOUNT_DIR" 2>/dev/null || true
    rmdir "$EXT4_MOUNT_DIR" 2>/dev/null || true
  fi
  # Remove root-owned temp files
  sudo rm -f "$TAR_PATH" 2>/dev/null || true
  sudo rm -f "$TMP_ROOTFS_PATH" 2>/dev/null || true
  if [[ -n "$EXTRACT_DIR" ]]; then
    sudo rm -rf "$EXTRACT_DIR" 2>/dev/null || true
  fi
  # Remove temp container
  $DOCKER rm -f "$CONTAINER_NAME" 2>/dev/null || true
}

trap cleanup EXIT

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

  # Install proxy CA certificate (generated by `runner build` in CA_DIR)
  local ca_cert="${CA_DIR}/${CA_CERT_FILE}"
  if [[ ! -f "$ca_cert" ]]; then
    echo "error: proxy CA cert not found at ${ca_cert} — run 'runner build' (not 'runner rootfs' directly)" >&2
    exit 1
  fi

  local ca_target="${EXTRACT_DIR}/${CA_ROOTFS_DEST}"
  sudo mkdir -p "$(dirname "$ca_target")"
  sudo cp "$ca_cert" "$ca_target"
  sudo chmod 644 "$ca_target"

  # Update system CA bundle
  sudo chroot "$EXTRACT_DIR" update-ca-certificates

  # Import proxy CA into Java's separate trust store (cacerts keystore).
  # Java does not read the system CA bundle — it has its own PKCS12 keystore.
  # In chroot, keytool can't find libjli.so via the default search path,
  # so we locate it and add its directory to LD_LIBRARY_PATH.
  local jli_dir
  jli_dir=$(sudo chroot "$EXTRACT_DIR" find /usr/lib/jvm -name libjli.so -printf '%h' -quit)
  sudo chroot "$EXTRACT_DIR" env LD_LIBRARY_PATH="$jli_dir" \
    keytool -importcert -trustcacerts \
    -keystore /etc/ssl/certs/java/cacerts \
    -storepass changeit -noprompt \
    -alias vm0-proxy-ca \
    -file "/${CA_ROOTFS_DEST}"

  # Write /etc/environment (read by PAM for all login sessions).
  # [sync:etc-environment] Keep in sync with: .github/workflows/crates.yml (runner-exec Test 5)
  # - LANG: locale (Docker ENV is lost after export)
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
    | sudo tee "${EXTRACT_DIR}/etc/environment" > /dev/null

  echo "[OK] proxy CA installed and system bundle updated"
}

# ---------------------------------------------------------------------------
# ext4 image creation
# ---------------------------------------------------------------------------

create_ext4() {
  echo "creating ext4 image..."

  # Image size from profile disk_mb.
  # With dm-snapshot COW, the guest filesystem is limited to this image
  # size — there is no separate writable layer.
  local content_bytes
  content_bytes=$(sudo du -sb "$EXTRACT_DIR" | cut -f1)
  local image_bytes=$(( DISK_MB * 1024 * 1024 ))

  if (( image_bytes < content_bytes )); then
    local content_mb=$(( content_bytes / 1024 / 1024 ))
    echo "error: disk_mb (${DISK_MB} MiB) is smaller than rootfs content (${content_mb} MiB)" >&2
    exit 1
  fi

  # Derive a deterministic UUID from the input hash.  ext4 uses the UUID
  # as the htree seed for directory hashing — a fixed UUID ensures
  # identical block layout for identical content, making the rootfs
  # reproducible.  This matters because dm-snapshot COW files record
  # sector-level offsets: if the rootfs is rebuilt with a different block
  # layout, existing snapshots become corrupt.
  local fs_uuid="${INPUT_HASH:0:8}-${INPUT_HASH:8:4}-${INPUT_HASH:12:4}-${INPUT_HASH:16:4}-${INPUT_HASH:20:12}"

  truncate -s "$image_bytes" "$TMP_ROOTFS_PATH"
  mkfs.ext4 -F -q -U "$fs_uuid" "$TMP_ROOTFS_PATH"

  EXT4_MOUNT_DIR=$(mktemp -d)
  sudo mount -o loop "$TMP_ROOTFS_PATH" "$EXT4_MOUNT_DIR"
  sudo cp -a "$EXTRACT_DIR"/. "$EXT4_MOUNT_DIR"/
  # mktemp -d creates 0700 directories; cp -a preserves that on the ext4
  # root inode, locking out non-root users. Restore standard 0755.
  sudo chmod 755 "$EXT4_MOUNT_DIR"
  sudo umount "$EXT4_MOUNT_DIR"
  rmdir "$EXT4_MOUNT_DIR"
  EXT4_MOUNT_DIR=""

  echo "[OK] ext4 image created"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

check_dependencies
docker_build
docker_export

extract_and_inject
# Free disk space early
sudo rm -f "$TAR_PATH"

create_ext4

# Move into final place
mv "$TMP_ROOTFS_PATH" "$ROOTFS_PATH"

# Report size
SIZE=$(stat -c%s "$ROOTFS_PATH")
SIZE_MB=$((SIZE / 1024 / 1024))
echo "[OK] rootfs built: ${ROOTFS_PATH} (${SIZE_MB} MiB)"
