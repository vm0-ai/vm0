use std::path::Path;

use clap::Args;
use sha2::{Digest, Sha256};

use sandbox_fc::SnapshotOutputPaths;

use crate::config::SnapshotConfig;
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

/// Create a snapshot and return the complete snapshot path information.
pub async fn run_snapshot(args: SnapshotArgs) -> RunnerResult<(String, Option<SnapshotConfig>)> {
    let paths = HomePaths::new()?;
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

    // Hash the actual rootfs content so the snapshot is invalidated when the
    // rootfs is rebuilt with different content (even if the input hash is the
    // same).  This prevents stale snapshots whose dm-snapshot COW data is
    // tied to the sector layout of a previous rootfs build.
    let rootfs_content_hash = hash_file(&rootfs_path).await?;
    tracing::info!(rootfs_content_hash, "rootfs content hash computed");

    let snapshot_hash = compute_snapshot_hash(&args, &rootfs_content_hash);
    tracing::info!("snapshot hash: {snapshot_hash}");
    // Machine-readable output — do not change format without updating consumers
    println!("snapshot_hash={snapshot_hash}");

    if args.dry_run {
        return Ok((snapshot_hash, None));
    }

    let output_dir = paths.snapshots_dir().join(&snapshot_hash);
    let output = SnapshotOutputPaths::new(output_dir.clone());

    if is_snapshot_complete(&output).await? {
        tracing::info!("[OK] snapshot already exists: {}", output_dir.display());
        touch_mtime(&output_dir);
        let config = output.snapshot_config(&snapshot_hash).into();
        return Ok((snapshot_hash, Some(config)));
    }

    // Acquire exclusive lock to prevent concurrent builds with the same hash.
    let _lock = lock::acquire(paths.snapshot_lock(&snapshot_hash)).await?;

    // Re-check after acquiring lock — another process may have completed the build.
    if is_snapshot_complete(&output).await? {
        tracing::info!("[OK] snapshot already exists: {}", output_dir.display());
        touch_mtime(&output_dir);
        let config = output.snapshot_config(&snapshot_hash).into();
        return Ok((snapshot_hash, Some(config)));
    }

    // Clean up any partial output from a previous failed attempt.
    match tokio::fs::remove_dir_all(&output_dir).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    tokio::fs::create_dir_all(&output_dir).await?;

    let create_config = sandbox_fc::SnapshotCreateConfig {
        id: snapshot_hash.clone(),
        binary_path: paths.firecracker_bin(FIRECRACKER_VERSION),
        kernel_path: paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION),
        rootfs_path,
        output_dir: output_dir.clone(),
        vcpu_count: args.vcpu,
        memory_mb: args.memory_mb,
    };

    let sc = sandbox_fc::create_snapshot(create_config).await?;

    let (snapshot_sz, memory_sz, overlay_sz) = tokio::join!(
        file_sizes(&sc.snapshot_path),
        file_sizes(&sc.memory_path),
        file_sizes(&sc.overlay_path),
    );
    tracing::info!(
        snapshot = %sc.snapshot_path.display(),
        snapshot_logical = %snapshot_sz.0,
        snapshot_disk = %snapshot_sz.1,
        memory = %sc.memory_path.display(),
        memory_logical = %memory_sz.0,
        memory_disk = %memory_sz.1,
        overlay = %sc.overlay_path.display(),
        overlay_logical = %overlay_sz.0,
        overlay_disk = %overlay_sz.1,
        "snapshot creation complete"
    );

    Ok((snapshot_hash, Some(sc.into())))
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
///   - `rootfs_hash` — rootfs input hash (from `rootfs`)
///   - `rootfs_content_hash` — SHA-256 of the actual rootfs.ext4 file
///   - `FIRECRACKER_VERSION` / `KERNEL_VERSION` — binary versions
///   - `vcpu` / `memory_mb` — VM resource settings
///
/// The `rootfs_content_hash` ensures the snapshot is invalidated when the
/// rootfs is rebuilt with different content, even if the input hash hasn't
/// changed (e.g. due to non-deterministic package installs).
///
/// **Changing this function invalidates all cached snapshots.**
pub(crate) fn compute_snapshot_hash(args: &SnapshotArgs, rootfs_content_hash: &str) -> String {
    let fc_config = sandbox_fc::config_hash();
    let mut hasher = Sha256::new();
    // Cache version seed — bump SNAPSHOT_CACHE_VERSION to force invalidation.
    hasher.update(b"version:");
    hasher.update(SNAPSHOT_CACHE_VERSION.to_le_bytes());
    hasher.update(b"fc_config:");
    hasher.update(fc_config.as_bytes());
    hasher.update(b"rootfs:");
    hasher.update(args.rootfs_hash.as_bytes());
    hasher.update(b"rootfs_content:");
    hasher.update(rootfs_content_hash.as_bytes());
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

/// Compute the SHA-256 hash of a file.
///
/// Uses a single `spawn_blocking` with synchronous IO rather than
/// `tokio::fs::File` — the latter dispatches each read as a separate
/// `spawn_blocking` task, adding significant scheduling overhead for
/// large files (~3 GiB rootfs).
async fn hash_file(path: &Path) -> RunnerResult<String> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut file = std::fs::File::open(&path)
            .map_err(|e| RunnerError::Internal(format!("open {}: {e}", path.display())))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            let n = file
                .read(&mut buf)
                .map_err(|e| RunnerError::Internal(format!("read {}: {e}", path.display())))?;
            if n == 0 {
                break;
            }
            hasher.update(buf.get(..n).unwrap_or(&buf));
        }
        Ok(format!("{:x}", hasher.finalize()))
    })
    .await
    .map_err(|e| RunnerError::Internal(format!("hash_file join: {e}")))?
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

    const FAKE_CONTENT_HASH: &str = "deadbeef";

    #[test]
    fn snapshot_hash_is_stable() {
        let args = SnapshotArgs {
            rootfs_hash: "abc123".into(),
            vcpu: 2,
            memory_mb: 2048,
            dry_run: false,
        };
        let hash = compute_snapshot_hash(&args, FAKE_CONTENT_HASH);

        // Changing this assertion means ALL existing cached snapshots are
        // invalidated.  Only update deliberately.
        assert_eq!(
            hash, "c9efa3993d726643706218f627a8d66bc50e027237c471dc3c5cc99c3bad9160",
            "snapshot hash changed — this invalidates all cached snapshots"
        );
    }

    #[test]
    fn different_inputs_produce_different_hashes() {
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

        let base_hash = compute_snapshot_hash(&base, FAKE_CONTENT_HASH);
        assert_ne!(
            base_hash,
            compute_snapshot_hash(&different_rootfs, FAKE_CONTENT_HASH)
        );
        assert_ne!(
            base_hash,
            compute_snapshot_hash(&different_vcpu, FAKE_CONTENT_HASH)
        );
        assert_ne!(
            base_hash,
            compute_snapshot_hash(&different_memory, FAKE_CONTENT_HASH)
        );
        // dry_run is not a build input — it must not change the hash.
        assert_eq!(
            base_hash,
            compute_snapshot_hash(&different_dry_run, FAKE_CONTENT_HASH)
        );
    }

    #[test]
    fn different_rootfs_content_produces_different_hash() {
        let args = SnapshotArgs {
            rootfs_hash: "abc123".into(),
            vcpu: 2,
            memory_mb: 2048,
            dry_run: false,
        };
        let hash_a = compute_snapshot_hash(&args, "content_hash_a");
        let hash_b = compute_snapshot_hash(&args, "content_hash_b");
        assert_ne!(
            hash_a, hash_b,
            "different rootfs content should produce different snapshot hash"
        );
    }
}
