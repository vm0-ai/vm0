use clap::Args;
use sha2::{Digest, Sha256};

use sandbox_fc::SnapshotOutputPaths;

use crate::deps::{FIRECRACKER_VERSION, KERNEL_VERSION};
use crate::error::{RunnerError, RunnerResult};
use crate::paths::{HomePaths, RootfsPaths};

#[derive(Args)]
pub struct SnapshotArgs {
    /// SHA-256 hash of the rootfs inputs (output of `build-rootfs`).
    #[arg(long)]
    rootfs_hash: String,
    /// Number of vCPUs for the snapshot VM.
    #[arg(long, default_value_t = 2)]
    vcpu: u32,
    /// Memory size in MiB for the snapshot VM.
    #[arg(long, default_value_t = 2048)]
    memory_mb: u32,
}

pub async fn run_snapshot(args: SnapshotArgs) -> RunnerResult<()> {
    let paths = HomePaths::new()?;

    let snapshot_hash = compute_snapshot_hash(&args);
    tracing::info!("snapshot hash: {snapshot_hash}");

    let output_dir = paths.snapshots_dir().join(&snapshot_hash);

    let output = SnapshotOutputPaths::new(output_dir.clone());

    if is_snapshot_complete(&output).await? {
        tracing::info!("[OK] snapshot already exists: {}", output_dir.display());
        return Ok(());
    }

    // Clean up any partial output from a previous failed attempt.
    if output_dir.exists() {
        tokio::fs::remove_dir_all(&output_dir).await?;
    }
    tokio::fs::create_dir_all(&output_dir).await?;

    let rootfs_path = RootfsPaths::new(&paths, &args.rootfs_hash).rootfs();

    let config = sandbox_fc::SnapshotCreateConfig {
        binary_path: paths.firecracker_bin(FIRECRACKER_VERSION),
        kernel_path: paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION),
        rootfs_path,
        output_dir: output_dir.clone(),
        vcpu_count: args.vcpu,
        memory_mb: args.memory_mb,
    };

    let snapshot_config = sandbox_fc::create_snapshot(config).await?;
    tracing::info!(
        snapshot = %snapshot_config.snapshot_path.display(),
        memory = %snapshot_config.memory_path.display(),
        overlay = %snapshot_config.overlay_path.display(),
        "snapshot creation complete"
    );

    Ok(())
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
///   - `rootfs_hash` — rootfs content (from `build-rootfs`)
///   - `FIRECRACKER_VERSION` / `KERNEL_VERSION` — binary versions
///   - `vcpu` / `memory_mb` — VM resource settings
fn compute_snapshot_hash(args: &SnapshotArgs) -> String {
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
