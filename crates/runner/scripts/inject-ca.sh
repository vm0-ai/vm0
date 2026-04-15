#!/usr/bin/env bash
# inject-ca.sh — Replace CA certificate in an existing rootfs.ext4 image.
#
# Mounts the rootfs via loopback, replaces the proxy CA certificate,
# rebuilds the system CA bundle, and updates the Java keystore.
# Used after downloading a rootfs from R2 cache — the cached rootfs
# contains the build host's CA which must be replaced with the local
# host's CA before creating a snapshot.
#
# Usage: inject-ca.sh --rootfs <path> --ca-dir <path>

set -euo pipefail

ROOTFS=""
CA_DIR=""
MOUNT_DIR=""

cleanup() {
    if [[ -n "$MOUNT_DIR" ]]; then
        sudo umount "$MOUNT_DIR" 2>/dev/null || true
        rmdir "$MOUNT_DIR" 2>/dev/null || true
    fi
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
    case "$1" in
        --rootfs)  ROOTFS="$2"; shift 2 ;;
        --ca-dir)  CA_DIR="$2"; shift 2 ;;
        *)         echo "error: unknown argument: $1" >&2; exit 1 ;;
    esac
done

[[ -f "$ROOTFS" ]] || { echo "error: rootfs not found: $ROOTFS" >&2; exit 1; }
[[ -d "$CA_DIR" ]] || { echo "error: ca-dir not found: $CA_DIR" >&2; exit 1; }

# Constants — keep in sync with build-rootfs.sh
# [sync:ca-constants] Keep in sync with: crates/runner/scripts/build-rootfs.sh
CA_CERT_FILE="mitmproxy-ca-cert.pem"
CA_ROOTFS_DEST="usr/local/share/ca-certificates/vm0-proxy-ca.crt"

ca_cert="${CA_DIR}/${CA_CERT_FILE}"
[[ -f "$ca_cert" ]] || { echo "error: CA cert not found: $ca_cert" >&2; exit 1; }

# Mount rootfs read-write via loopback
MOUNT_DIR="$(mktemp -d)"
sudo mount -o loop "$ROOTFS" "$MOUNT_DIR"

# Replace CA certificate
sudo cp "$ca_cert" "${MOUNT_DIR}/${CA_ROOTFS_DEST}"
sudo chmod 644 "${MOUNT_DIR}/${CA_ROOTFS_DEST}"

# Rebuild system CA bundle (updates /etc/ssl/certs/ca-certificates.crt)
sudo chroot "$MOUNT_DIR" update-ca-certificates

# Update Java keystore. Unlike build-rootfs.sh (which imports into a fresh
# keystore where the alias doesn't exist), here the alias vm0-proxy-ca
# already exists from the original build. keytool -importcert rejects
# duplicate aliases, so we must delete first then re-import.
# keytool requires libjli.so on the library path; locate it dynamically.
jli_dir=$(sudo chroot "$MOUNT_DIR" find /usr/lib/jvm -name libjli.so -printf '%h' -quit)
sudo chroot "$MOUNT_DIR" env LD_LIBRARY_PATH="$jli_dir" \
    keytool -delete \
    -keystore /etc/ssl/certs/java/cacerts \
    -storepass changeit \
    -alias vm0-proxy-ca 2>/dev/null || true
sudo chroot "$MOUNT_DIR" env LD_LIBRARY_PATH="$jli_dir" \
    keytool -importcert -trustcacerts \
    -keystore /etc/ssl/certs/java/cacerts \
    -storepass changeit -noprompt \
    -alias vm0-proxy-ca \
    -file "/${CA_ROOTFS_DEST}"

echo "[OK] CA cert replaced in rootfs"
