use clap::Args;
use sandbox::SnapshotProvider;
use sha2::{Digest, Sha256};

use crate::deps::{FIRECRACKER_VERSION, KERNEL_VERSION};
use crate::error::{RunnerError, RunnerResult};
use crate::lock;
use crate::paths::{HomePaths, RootfsPaths, touch_mtime};

/// Bump this to invalidate all cached snapshots without changing any input files.
const SNAPSHOT_CACHE_VERSION: u32 = 1;

#[derive(Args, Clone)]
pub struct SnapshotArgs {
    /// SHA-256 hash of the rootfs inputs (output of `rootfs`).
    #[arg(long)]
    pub rootfs_hash: String,
    /// Number of vCPUs for the snapshot VM.
    #[arg(long)]
    pub vcpu: u32,
    /// Memory size in MiB for the snapshot VM.
    #[arg(long)]
    pub memory_mb: u32,
    /// Compute and print the snapshot hash without building
    #[arg(long)]
    pub dry_run: bool,
}

/// Create a snapshot and return the snapshot hash.
pub async fn run_snapshot(
    args: SnapshotArgs,
    provider: &dyn SnapshotProvider,
) -> RunnerResult<String> {
    let snapshot_hash = compute_snapshot_hash(&args, provider);
    tracing::info!("snapshot hash: {snapshot_hash}");
    // Machine-readable output — do not change format without updating consumers
    println!("snapshot_hash={snapshot_hash}");

    if args.dry_run {
        return Ok(snapshot_hash);
    }

    let paths = HomePaths::new()?;
    let output_dir = paths.snapshots_dir().join(&snapshot_hash);

    if provider.is_complete(&output_dir).await? {
        tracing::info!("[OK] snapshot already exists: {}", output_dir.display());
        touch_mtime(&output_dir);
        return Ok(snapshot_hash);
    }

    // Acquire exclusive lock to prevent concurrent builds with the same hash.
    let _lock = lock::acquire(paths.snapshot_lock(&snapshot_hash)).await?;

    // Re-check after acquiring lock — another process may have completed the build.
    if provider.is_complete(&output_dir).await? {
        tracing::info!("[OK] snapshot already exists: {}", output_dir.display());
        touch_mtime(&output_dir);
        return Ok(snapshot_hash);
    }

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

    let create_config = sandbox::SnapshotCreateConfig {
        id: snapshot_hash.clone(),
        binary_path: paths.firecracker_bin(FIRECRACKER_VERSION),
        kernel_path: paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION),
        rootfs_path,
        output_dir: output_dir.clone(),
        vcpu_count: args.vcpu,
        memory_mb: args.memory_mb,
    };

    let output = provider.create_snapshot(create_config).await?;

    let (snapshot_sz, memory_sz, cow_sz) = tokio::join!(
        file_sizes(&output.snapshot_path),
        file_sizes(&output.memory_path),
        file_sizes(&output.cow_path),
    );
    tracing::info!(
        snapshot = %output.snapshot_path.display(),
        snapshot_logical = %snapshot_sz.0,
        snapshot_disk = %snapshot_sz.1,
        memory = %output.memory_path.display(),
        memory_logical = %memory_sz.0,
        memory_disk = %memory_sz.1,
        cow = %output.cow_path.display(),
        cow_logical = %cow_sz.0,
        cow_disk = %cow_sz.1,
        "snapshot creation complete"
    );

    Ok(snapshot_hash)
}

/// Compute a composite cache key from all inputs that affect the snapshot.
///
/// Inputs:
///   - `provider.config_hash()` — boot args, guest network config
///   - `rootfs_hash` — rootfs content (from `rootfs`)
///   - `FIRECRACKER_VERSION` / `KERNEL_VERSION` — binary versions
///   - `vcpu` / `memory_mb` — VM resource settings
///
/// **Changing this function invalidates all cached snapshots.**
pub(crate) fn compute_snapshot_hash(
    args: &SnapshotArgs,
    provider: &dyn SnapshotProvider,
) -> String {
    let fc_config = provider.config_hash();
    let mut hasher = Sha256::new();
    // Cache version seed — bump SNAPSHOT_CACHE_VERSION to force invalidation.
    hasher.update(b"version:");
    hasher.update(SNAPSHOT_CACHE_VERSION.to_le_bytes());
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
    hex::encode(hasher.finalize())
}

/// Return `(logical, disk)` as human-readable strings (e.g. "65.2 MiB").
///
/// `logical` is the apparent file size; `disk` is the actual disk usage
/// (from `st_blocks`), which can be much smaller for sparse files.
async fn file_sizes(path: &std::path::Path) -> (String, String) {
    use std::os::unix::fs::MetadataExt;
    match tokio::fs::metadata(path).await {
        Ok(m) => {
            const BYTES_PER_BLOCK: u64 = 512;
            let logical = human_bytes(m.len());
            let disk = human_bytes(m.blocks() * BYTES_PER_BLOCK);
            (logical, disk)
        }
        Err(_) => ("?".into(), "?".into()),
    }
}

/// Format a byte count as a human-readable string with auto-scaled units.
fn human_bytes(bytes: u64) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    let b = bytes as f64;
    if b >= GIB {
        format!("{:.1} GiB", b / GIB)
    } else if b >= MIB {
        format!("{:.1} MiB", b / MIB)
    } else if b >= KIB {
        format!("{:.1} KiB", b / KIB)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_hash_is_stable() {
        let provider = sandbox_fc::FirecrackerSnapshotProvider;
        let args = SnapshotArgs {
            rootfs_hash: "abc123".into(),
            vcpu: 2,
            memory_mb: 2048,
            dry_run: false,
        };
        let hash = compute_snapshot_hash(&args, &provider);

        // Changing this assertion means ALL existing cached snapshots are
        // invalidated.  Only update deliberately.
        assert_eq!(
            hash, "a59351f79b9178c07e7a90a89df290d66f48f6ad415b2a717fb53eec3b37b8f6",
            "snapshot hash changed — this invalidates all cached snapshots"
        );
    }

    #[test]
    fn human_bytes_formatting() {
        let cases: &[(u64, &str)] = &[
            (0, "0 B"),
            (1, "1 B"),
            (1023, "1023 B"),
            (1024, "1.0 KiB"),
            (1536, "1.5 KiB"),
            (1048576, "1.0 MiB"),
            (10 * 1048576, "10.0 MiB"),
            (1073741824, "1.0 GiB"),
            (2 * 1073741824 + 536870912, "2.5 GiB"),
        ];
        for &(input, expected) in cases {
            assert_eq!(human_bytes(input), expected, "human_bytes({input})");
        }
    }

    #[test]
    fn different_inputs_produce_different_hashes() {
        let provider = sandbox_fc::FirecrackerSnapshotProvider;
        let base = SnapshotArgs {
            rootfs_hash: "abc123".into(),
            vcpu: 2,
            memory_mb: 2048,
            dry_run: false,
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
        let different_dry_run = SnapshotArgs {
            dry_run: true,
            ..base.clone()
        };

        let base_hash = compute_snapshot_hash(&base, &provider);
        assert_ne!(
            base_hash,
            compute_snapshot_hash(&different_rootfs, &provider)
        );
        assert_ne!(base_hash, compute_snapshot_hash(&different_vcpu, &provider));
        assert_ne!(
            base_hash,
            compute_snapshot_hash(&different_memory, &provider)
        );
        // dry_run is not a build input — it must not change the hash.
        assert_eq!(
            base_hash,
            compute_snapshot_hash(&different_dry_run, &provider)
        );
    }

    #[test]
    fn mock_provider_produces_different_hash_than_real() {
        let args = SnapshotArgs {
            rootfs_hash: "abc123".into(),
            vcpu: 2,
            memory_mb: 2048,
            dry_run: false,
        };
        let real_hash = compute_snapshot_hash(&args, &sandbox_fc::FirecrackerSnapshotProvider);
        let mock_hash = compute_snapshot_hash(&args, &sandbox_mock::MockSnapshotProvider);
        // Different providers have different config_hash() → different snapshot hashes.
        assert_ne!(real_hash, mock_hash);
    }

    #[test]
    fn snapshot_hash_deterministic_with_mock() {
        let args = SnapshotArgs {
            rootfs_hash: "test-rootfs".into(),
            vcpu: 4,
            memory_mb: 4096,
            dry_run: false,
        };
        let provider = sandbox_mock::MockSnapshotProvider;
        let h1 = compute_snapshot_hash(&args, &provider);
        let h2 = compute_snapshot_hash(&args, &provider);
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // SHA-256 hex
    }

    #[tokio::test]
    async fn run_snapshot_dry_run_returns_hash() {
        let provider = sandbox_mock::MockSnapshotProvider;
        let args = SnapshotArgs {
            rootfs_hash: "abc123".into(),
            vcpu: 2,
            memory_mb: 2048,
            dry_run: true,
        };
        let expected_hash = compute_snapshot_hash(&args, &provider);
        let result = run_snapshot(args, &provider).await.unwrap();
        assert_eq!(result, expected_hash);
    }

    #[tokio::test]
    async fn file_sizes_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.bin");
        tokio::fs::write(&path, vec![0u8; 1024]).await.unwrap();

        let (logical, disk) = file_sizes(&path).await;
        assert_eq!(logical, "1.0 KiB");
        // disk usage may differ from logical size
        assert_ne!(disk, "?");
    }

    #[tokio::test]
    async fn file_sizes_nonexistent_file() {
        let (logical, disk) = file_sizes(std::path::Path::new("/nonexistent/file.bin")).await;
        assert_eq!(logical, "?");
        assert_eq!(disk, "?");
    }
}
