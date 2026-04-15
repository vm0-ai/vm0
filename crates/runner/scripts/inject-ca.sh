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
LOOP_DEV=""

cleanup() {
    # Retry umount a few times — chroot subprocesses (update-ca-certificates,
    # keytool) may briefly hold references after returning.  Final attempt
    # lets stderr through so CI logs show the root cause if it still fails.
    if [[ -n "$MOUNT_DIR" ]]; then
        for attempt in 1 2 3; do
            if [[ $attempt -eq 3 ]]; then
                sudo umount "$MOUNT_DIR" || true
                break
            fi
            if sudo umount "$MOUNT_DIR" 2>/dev/null; then
                break
            fi
            sleep 0.5
        done
        rmdir "$MOUNT_DIR" 2>/dev/null || true
    fi
    # Explicit loop device detach as a backstop. With LO_FLAGS_AUTOCLEAR
    # (set by `losetup --find --show` via mount defaults), a successful
    # umount already releases the device; this covers the umount-failed
    # and SIGKILL-before-umount edge cases. Swallows errors because
    # losetup -d on an already-detached device returns ENXIO.
    if [[ -n "$LOOP_DEV" ]]; then
        sudo losetup -d "$LOOP_DEV" 2>/dev/null || true
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

# Mount rootfs read-write via loopback.  Explicit losetup gives us the
# device name for the cleanup fallback (mount -o loop doesn't expose it).
MOUNT_DIR="$(mktemp -d)"
LOOP_DEV="$(sudo losetup --find --show "$ROOTFS")"
sudo mount "$LOOP_DEV" "$MOUNT_DIR"

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
# `|| true` handles the (unexpected) case where the alias is absent; stderr
# is NOT suppressed so real keystore errors surface in CI logs.
jli_dir=$(sudo chroot "$MOUNT_DIR" find /usr/lib/jvm -name libjli.so -printf '%h' -quit)
sudo chroot "$MOUNT_DIR" env LD_LIBRARY_PATH="$jli_dir" \
    keytool -delete \
    -keystore /etc/ssl/certs/java/cacerts \
    -storepass changeit \
    -alias vm0-proxy-ca || true
sudo chroot "$MOUNT_DIR" env LD_LIBRARY_PATH="$jli_dir" \
    keytool -importcert -trustcacerts \
    -keystore /etc/ssl/certs/java/cacerts \
    -storepass changeit -noprompt \
    -alias vm0-proxy-ca \
    -file "/${CA_ROOTFS_DEST}"

echo "[OK] CA cert replaced in rootfs"
