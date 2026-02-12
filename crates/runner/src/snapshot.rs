use clap::Args;
use sha2::{Digest, Sha256};

use sandbox_fc::SnapshotOutputPaths;

use crate::config::{DEFAULT_MEMORY_MB, DEFAULT_VCPU, SnapshotConfig};
use crate::deps::{FIRECRACKER_VERSION, KERNEL_VERSION};
use crate::error::{RunnerError, RunnerResult};
use crate::paths::{HomePaths, RootfsPaths};

#[derive(Args, Clone)]
pub struct SnapshotArgs {
    /// SHA-256 hash of the rootfs inputs (output of `rootfs`).
    #[arg(long)]
    pub rootfs_hash: String,
    /// Number of vCPUs for the snapshot VM.
    #[arg(long, default_value_t = DEFAULT_VCPU)]
    pub vcpu: u32,
    /// Memory size in MiB for the snapshot VM.
    #[arg(long, default_value_t = DEFAULT_MEMORY_MB)]
    pub memory_mb: u32,
}

/// Create a snapshot and return the complete snapshot path information.
pub async fn run_snapshot(args: SnapshotArgs) -> RunnerResult<SnapshotConfig> {
    let paths = HomePaths::new()?;

    let snapshot_hash = compute_snapshot_hash(&args);
    tracing::info!("snapshot hash: {snapshot_hash}");

    let output_dir = paths.snapshots_dir().join(&snapshot_hash);
    let output = SnapshotOutputPaths::new(output_dir.clone());

    if is_snapshot_complete(&output).await? {
        tracing::info!("[OK] snapshot already exists: {}", output_dir.display());
        return Ok(output.snapshot_config().into());
    }

    // Clean up any partial output from a previous failed attempt.
    match tokio::fs::remove_dir_all(&output_dir).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    tokio::fs::create_dir_all(&output_dir).await?;

    let rootfs_path = RootfsPaths::new(&paths, &args.rootfs_hash).rootfs();
    let rootfs_exists = tokio::fs::try_exists(&rootfs_path)
        .await
        .map_err(|e| RunnerError::Internal(format!("check rootfs: {e}")))?;
    if !rootfs_exists {
        return Err(RunnerError::Config(format!(
            "rootfs not found at {}; run `build` or `rootfs` first",
            rootfs_path.display()
        )));
    }

    let create_config = sandbox_fc::SnapshotCreateConfig {
        binary_path: paths.firecracker_bin(FIRECRACKER_VERSION),
        kernel_path: paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION),
        rootfs_path,
        output_dir: output_dir.clone(),
        vcpu_count: args.vcpu,
        memory_mb: args.memory_mb,
    };

    let sc = sandbox_fc::create_snapshot(create_config).await?;
    tracing::info!(
        snapshot = %sc.snapshot_path.display(),
        memory = %sc.memory_path.display(),
        overlay = %sc.overlay_path.display(),
        "snapshot creation complete"
    );

    Ok(sc.into())
}

/// Check whether all expected snapshot outputs exist in the directory.
async fn is_snapshot_complete(output: &SnapshotOutputPaths) -> RunnerResult<bool> {
    for path in [output.snapshot(), output.memory(), output.overlay()] {
        let exists = tokio::fs::try_exists(&path)
            .await
            .map_err(|e| RunnerError::Internal(format!("check {}: {e}", path.display())))?;
        if !exists {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Compute a composite cache key from all inputs that affect the snapshot.
///
/// Inputs:
///   - `sandbox_fc::config_hash()` — boot args, guest network config
///   - `rootfs_hash` — rootfs content (from `rootfs`)
///   - `FIRECRACKER_VERSION` / `KERNEL_VERSION` — binary versions
///   - `vcpu` / `memory_mb` — VM resource settings
///
/// **Changing this function invalidates all cached snapshots.**
pub(crate) fn compute_snapshot_hash(args: &SnapshotArgs) -> String {
    let fc_config = sandbox_fc::config_hash();
    let mut hasher = Sha256::new();
    hasher.update(b"fc_config:");
    hasher.update(fc_config.as_bytes());
    hasher.update(b"rootfs:");
    hasher.update(args.rootfs_hash.as_bytes());
    hasher.update(b"firecracker:");
    hasher.update(FIRECRACKER_VERSION.as_bytes());
    hasher.update(b"kernel:");
    hasher.update(KERNEL_VERSION.as_bytes());
    hasher.update(b"vcpu:");
    hasher.update(args.vcpu.to_le_bytes());
    hasher.update(b"memory_mb:");
    hasher.update(args.memory_mb.to_le_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_hash_is_stable() {
        let args = SnapshotArgs {
            rootfs_hash: "abc123".into(),
            vcpu: 2,
            memory_mb: 2048,
        };
        let hash = compute_snapshot_hash(&args);

        // Changing this assertion means ALL existing cached snapshots are
        // invalidated.  Only update deliberately.
        assert_eq!(
            hash, "3c68896dabe2536440cc57e8bf7d377c3f0935afd90ca68b189c6e37636fef19",
            "snapshot hash changed — this invalidates all cached snapshots"
        );
    }

    #[test]
    fn different_inputs_produce_different_hashes() {
        let base = SnapshotArgs {
            rootfs_hash: "abc123".into(),
            vcpu: 2,
            memory_mb: 2048,
        };
        let different_rootfs = SnapshotArgs {
            rootfs_hash: "def456".into(),
            ..base.clone()
        };
        let different_vcpu = SnapshotArgs {
            vcpu: 4,
            ..base.clone()
        };
        let different_memory = SnapshotArgs {
            memory_mb: 4096,
            ..base.clone()
        };

        let base_hash = compute_snapshot_hash(&base);
        assert_ne!(base_hash, compute_snapshot_hash(&different_rootfs));
        assert_ne!(base_hash, compute_snapshot_hash(&different_vcpu));
        assert_ne!(base_hash, compute_snapshot_hash(&different_memory));
    }
}
