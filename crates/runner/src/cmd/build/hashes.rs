use std::path::Path;

use sha2::{Digest, Sha256};

use crate::ca;
use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;

use super::{CUSTOMIZE_SCRIPT, ROOTFS_DNS_NAMESERVER, TEMPLATE_BUILD_SCRIPT};

/// Bump to invalidate all shared template images in R2.
///
/// Bumping orphans previous R2 objects; swept by `runner gc` after TTL.
const TEMPLATE_CACHE_VERSION: u32 = 1;

/// Bump to invalidate all local rootfs images.
///
/// Rootfs images are not shared through R2 because they include guest binaries
/// and host-local CA material.
const ROOTFS_CACHE_VERSION: u32 = 1;

/// Bump to invalidate all cached snapshots (local only; R2 stores only the template).
const SNAPSHOT_CACHE_VERSION: u32 = 3;

/// Compute a template hash for shared R2 image caching.
///
/// Inputs:
///   - `TEMPLATE_CACHE_VERSION` — bump to force invalidation
///   - `TEMPLATE_BUILD_SCRIPT` — template build script content
///   - `rootfs_disk_mb` — rootfs disk size from profile
///
/// Guest binaries and host-local CA are deliberately excluded; those belong
/// to the local rootfs hash.
///
/// **Changing this function invalidates all shared template images.**
pub(super) fn compute_template_hash(rootfs_disk_mb: u32) -> String {
    let mut hasher = Sha256::new();

    hasher.update(b"template_version:");
    hasher.update(TEMPLATE_CACHE_VERSION.to_le_bytes());
    hasher.update(b"template_script:");
    hasher.update(TEMPLATE_BUILD_SCRIPT.as_bytes());
    hasher.update(b"arch:");
    hasher.update(std::env::consts::ARCH.as_bytes());
    hasher.update(b"rootfs_disk_mb:");
    hasher.update(rootfs_disk_mb.to_le_bytes());

    hex::encode(hasher.finalize())
}

/// Compute the local rootfs hash.
///
/// This hash is what runner configs use. It includes the shared template hash plus
/// every rootfs-only input that changes the bootable rootfs content.
pub(super) async fn compute_rootfs_hash(
    template_hash: &str,
    guest_bins: &[(&Path, &str)],
    ca_fingerprint: &str,
    rootfs_disk_mb: u32,
) -> RunnerResult<String> {
    let mut hasher = Sha256::new();

    hasher.update(b"rootfs_version:");
    hasher.update(ROOTFS_CACHE_VERSION.to_le_bytes());
    hasher.update(b"template:");
    hasher.update(template_hash.as_bytes());
    hasher.update(b"customize_script:");
    hasher.update(CUSTOMIZE_SCRIPT.as_bytes());
    hasher.update(b"rootfs_disk_mb:");
    hasher.update(rootfs_disk_mb.to_le_bytes());
    hasher.update(b"ca_fingerprint:");
    hasher.update(ca_fingerprint.as_bytes());
    hasher.update(b"dns_nameserver:");
    hasher.update(ROOTFS_DNS_NAMESERVER.as_bytes());

    for (src, dest) in guest_bins {
        let content = tokio::fs::read(src)
            .await
            .map_err(|e| RunnerError::Internal(format!("read {}: {e}", src.display())))?;
        let tag = format!("bin:{dest}:");
        hasher.update(tag.as_bytes());
        hasher.update(&content);
    }

    Ok(hex::encode(hasher.finalize()))
}

pub(super) async fn compute_ca_cert_fingerprint(paths: &HomePaths) -> RunnerResult<String> {
    let cert = paths.ca_dir().join(ca::CA_CERT);
    let content = tokio::fs::read(&cert)
        .await
        .map_err(|e| RunnerError::Internal(format!("read CA cert {}: {e}", cert.display())))?;
    Ok(hex::encode(Sha256::digest(content)))
}

/// Compute a snapshot hash from all inputs that affect snapshot content.
///
/// This hash is local-only (R2 stores only the shared template). It covers:
///   - `SNAPSHOT_CACHE_VERSION` — manual bump counter
///   - `rootfs_hash` — the rootfs this snapshot is built from
///   - `vcpu`, `memory_mb`, `workspace_disk_mb` — VM resource config
///   - `fc_version`, `kernel_version` — Firecracker and guest kernel versions
///   - `provider_config_hash` — sandbox-fc internal config (boot args, prewarm, etc.)
pub(super) fn compute_snapshot_hash(
    rootfs_hash: &str,
    vcpu: u32,
    memory_mb: u32,
    workspace_disk_mb: u32,
    fc_version: &str,
    kernel_version: &str,
    provider_config_hash: &str,
) -> String {
    let mut hasher = Sha256::new();

    hasher.update(b"snapshot_version:");
    hasher.update(SNAPSHOT_CACHE_VERSION.to_le_bytes());
    hasher.update(b"rootfs:");
    hasher.update(rootfs_hash.as_bytes());
    hasher.update(b"vcpu:");
    hasher.update(vcpu.to_le_bytes());
    hasher.update(b"memory_mb:");
    hasher.update(memory_mb.to_le_bytes());
    hasher.update(b"workspace_disk_mb:");
    hasher.update(workspace_disk_mb.to_le_bytes());
    hasher.update(b"fc_version:");
    hasher.update(fc_version.as_bytes());
    hasher.update(b"kernel_version:");
    hasher.update(kernel_version.as_bytes());
    hasher.update(b"provider_config:");
    hasher.update(provider_config_hash.as_bytes());

    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_template_hash_deterministic() {
        let h1 = compute_template_hash(16384);
        let h2 = compute_template_hash(16384);
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // SHA-256 hex
    }

    #[test]
    fn compute_template_hash_sensitive_to_disk_size() {
        assert_ne!(
            compute_template_hash(16384),
            compute_template_hash(32768),
            "template hash must change when the ext4 disk size changes"
        );
    }

    #[tokio::test]
    async fn compute_rootfs_hash_deterministic() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("agent");
        tokio::fs::write(&bin, b"binary-content").await.unwrap();
        let bins: &[(&Path, &str)] = &[(&bin, "/usr/local/bin/guest-agent")];

        let h1 = compute_rootfs_hash("template-hash", bins, "ca-fingerprint", 16384)
            .await
            .unwrap();
        let h2 = compute_rootfs_hash("template-hash", bins, "ca-fingerprint", 16384)
            .await
            .unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // SHA-256 hex
    }

    #[tokio::test]
    async fn template_hash_ignores_guest_binaries() {
        let dir = tempfile::tempdir().unwrap();
        let bin_a = dir.path().join("agent-a");
        let bin_b = dir.path().join("agent-b");
        tokio::fs::write(&bin_a, b"content-a").await.unwrap();
        tokio::fs::write(&bin_b, b"content-b").await.unwrap();

        let template_a = compute_template_hash(16384);
        let template_b = compute_template_hash(16384);
        assert_eq!(
            template_a, template_b,
            "template hash must not depend on guest binary content"
        );
    }

    #[tokio::test]
    async fn compute_rootfs_hash_sensitive_to_rootfs_inputs() {
        let dir = tempfile::tempdir().unwrap();
        let bin_a = dir.path().join("agent-a");
        let bin_b = dir.path().join("agent-b");
        tokio::fs::write(&bin_a, b"content-a").await.unwrap();
        tokio::fs::write(&bin_b, b"content-b").await.unwrap();

        let base = compute_rootfs_hash(
            "template-a",
            &[(&bin_a, "/usr/local/bin/guest-agent")],
            "ca-a",
            16384,
        )
        .await
        .unwrap();

        let different_content = compute_rootfs_hash(
            "template-a",
            &[(&bin_b, "/usr/local/bin/guest-agent")],
            "ca-a",
            16384,
        )
        .await
        .unwrap();
        assert_ne!(
            base, different_content,
            "hash must change with binary content"
        );

        let different_disk = compute_rootfs_hash(
            "template-a",
            &[(&bin_a, "/usr/local/bin/guest-agent")],
            "ca-a",
            32768,
        )
        .await
        .unwrap();
        assert_ne!(base, different_disk, "hash must change with rootfs_disk_mb");

        let different_dest = compute_rootfs_hash(
            "template-a",
            &[(&bin_a, "/usr/local/bin/guest-download")],
            "ca-a",
            16384,
        )
        .await
        .unwrap();
        assert_ne!(base, different_dest, "hash must change with dest path");

        let different_ca = compute_rootfs_hash(
            "template-a",
            &[(&bin_a, "/usr/local/bin/guest-agent")],
            "ca-b",
            16384,
        )
        .await
        .unwrap();
        assert_ne!(base, different_ca, "hash must change with CA fingerprint");

        let different_template = compute_rootfs_hash(
            "template-b",
            &[(&bin_a, "/usr/local/bin/guest-agent")],
            "ca-a",
            16384,
        )
        .await
        .unwrap();
        assert_ne!(base, different_template, "hash must change with template");
    }

    #[test]
    fn compute_snapshot_hash_deterministic() {
        let h1 = compute_snapshot_hash(
            "rootfs_aaa",
            2,
            4096,
            16_384,
            "v1.14.1",
            "6.1.155",
            "config_xxx",
        );
        let h2 = compute_snapshot_hash(
            "rootfs_aaa",
            2,
            4096,
            16_384,
            "v1.14.1",
            "6.1.155",
            "config_xxx",
        );
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn compute_snapshot_hash_sensitive_to_each_field() {
        let base =
            compute_snapshot_hash("rootfs_aaa", 2, 4096, 16_384, "v1.14.1", "6.1.155", "cfg");

        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_bbb", 2, 4096, 16_384, "v1.14.1", "6.1.155", "cfg"),
            "must change with rootfs_hash"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 4, 4096, 16_384, "v1.14.1", "6.1.155", "cfg"),
            "must change with vcpu"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 2, 8192, 16_384, "v1.14.1", "6.1.155", "cfg"),
            "must change with memory_mb"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 2, 4096, 32_768, "v1.14.1", "6.1.155", "cfg"),
            "must change with workspace_disk_mb"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 2, 4096, 16_384, "v1.15.0", "6.1.155", "cfg"),
            "must change with fc_version"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 2, 4096, 16_384, "v1.14.1", "6.2.0", "cfg"),
            "must change with kernel_version"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 2, 4096, 16_384, "v1.14.1", "6.1.155", "cfg2"),
            "must change with provider_config_hash"
        );
    }
}
