use std::path::{Path, PathBuf};

use clap::Args;
use sandbox::SnapshotProvider;
use sha2::{Digest, Sha256};

use crate::ca;
use crate::deps::{FIRECRACKER_VERSION, KERNEL_VERSION};
use crate::error::{RunnerError, RunnerResult};
use crate::lock;
use crate::paths::{HomePaths, RootfsPaths, touch_mtime};
use crate::profile;
use crate::r2_cache::R2ImageCache;

const BUILD_SCRIPT: &str = include_str!("../../scripts/build-rootfs.sh");
const VERIFY_SCRIPT: &str = include_str!("../../scripts/verify-rootfs.sh");
const INJECT_CA_SCRIPT: &str = include_str!("../../scripts/inject-ca.sh");

/// Bump to invalidate all cached rootfs images (R2 + local).
///
/// Bumping orphans previous R2 objects; swept by `runner gc` after TTL.
const ROOTFS_CACHE_VERSION: u32 = 1;

/// Bump to invalidate all cached snapshots (local only; R2 stores rootfs only).
const SNAPSHOT_CACHE_VERSION: u32 = 1;

#[cfg(bundled_guests)]
mod embedded {
    pub const GUEST_INIT: &[u8] = include_bytes!(env!("BUNDLED_GUEST_INIT"));
    pub const GUEST_DOWNLOAD: &[u8] = include_bytes!(env!("BUNDLED_GUEST_DOWNLOAD"));
    pub const GUEST_AGENT: &[u8] = include_bytes!(env!("BUNDLED_GUEST_AGENT"));
    pub const GUEST_MOCK_CLAUDE: &[u8] = include_bytes!(env!("BUNDLED_GUEST_MOCK_CLAUDE"));
    pub const GUEST_RESEED: &[u8] = include_bytes!(env!("BUNDLED_GUEST_RESEED"));
}

#[cfg(bundled_guests)]
fn bundled_guest(name: &str) -> Option<&'static [u8]> {
    match name {
        "guest-agent" => Some(embedded::GUEST_AGENT),
        "guest-download" => Some(embedded::GUEST_DOWNLOAD),
        "guest-init" => Some(embedded::GUEST_INIT),
        "guest-mock-claude" => Some(embedded::GUEST_MOCK_CLAUDE),
        "guest-reseed" => Some(embedded::GUEST_RESEED),
        _ => None,
    }
}

#[cfg(not(bundled_guests))]
fn bundled_guest(_name: &str) -> Option<&'static [u8]> {
    None
}

#[derive(Args)]
pub struct BuildArgs {
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to guest-agent binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-agent binary (required)")
    )]
    guest_agent: Option<PathBuf>,
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to guest-download binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-download binary (required)")
    )]
    guest_download: Option<PathBuf>,
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to guest-init binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-init binary (required)")
    )]
    guest_init: Option<PathBuf>,
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to guest-mock-claude binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-mock-claude binary (required)")
    )]
    guest_mock_claude: Option<PathBuf>,
    #[cfg_attr(
        bundled_guests,
        arg(long, help = "Path to guest-reseed binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-reseed binary (required)")
    )]
    guest_reseed: Option<PathBuf>,
    /// Profile to build (determines VM resources and disk size)
    #[arg(long)]
    pub profile: String,
    /// Compute and print the image hash without building
    #[arg(long)]
    pub dry_run: bool,
}

/// Resolve a guest binary path: CLI arg takes priority, then bundled binary
/// written to a temp file, otherwise error.
async fn resolve_guest(
    cli_path: Option<PathBuf>,
    name: &str,
    tmp_dir: &Path,
) -> RunnerResult<PathBuf> {
    if let Some(p) = cli_path {
        return Ok(p);
    }
    if let Some(bytes) = bundled_guest(name) {
        let dest = tmp_dir.join(name);
        tokio::fs::write(&dest, bytes)
            .await
            .map_err(|e| RunnerError::Internal(format!("write bundled {name}: {e}")))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
                .await
                .map_err(|e| RunnerError::Internal(format!("chmod {name}: {e}")))?;
        }
        return Ok(dest);
    }
    Err(RunnerError::Internal(format!(
        "missing --{} and no bundled binary available",
        name
    )))
}

/// Build an image (rootfs from R2 cache or local build, snapshot always local).
pub async fn run_build(args: BuildArgs, provider: &dyn SnapshotProvider) -> RunnerResult<()> {
    let def = profile::get(&args.profile)?;
    let dry_run = args.dry_run;

    // Create temp dir for any bundled guest binaries that need extracting.
    // IMPORTANT: tmp_dir must outlive build script execution — dropping it deletes extracted guests.
    let tmp_dir =
        tempfile::tempdir().map_err(|e| RunnerError::Internal(format!("create temp dir: {e}")))?;

    // Resolve all guest binary paths (CLI arg → bundled → error).
    let guest_agent = resolve_guest(args.guest_agent, "guest-agent", tmp_dir.path()).await?;
    let guest_download =
        resolve_guest(args.guest_download, "guest-download", tmp_dir.path()).await?;
    let guest_init = resolve_guest(args.guest_init, "guest-init", tmp_dir.path()).await?;
    let guest_mock_claude =
        resolve_guest(args.guest_mock_claude, "guest-mock-claude", tmp_dir.path()).await?;
    let guest_reseed = resolve_guest(args.guest_reseed, "guest-reseed", tmp_dir.path()).await?;

    // Fixed order for deterministic hashing — do NOT reorder.
    let bins: [(&Path, &str); 5] = [
        (guest_agent.as_path(), "/usr/local/bin/guest-agent"),
        (guest_download.as_path(), "/usr/local/bin/guest-download"),
        (guest_init.as_path(), "/sbin/guest-init"),
        (guest_reseed.as_path(), "/sbin/guest-reseed"),
        (
            guest_mock_claude.as_path(),
            "/usr/local/bin/guest-mock-claude",
        ),
    ];

    // Compute two separate hashes: rootfs (R2-cacheable) and snapshot (local only).
    let rootfs_hash = compute_rootfs_hash(&bins, def.disk_mb).await?;
    let snapshot_hash = compute_snapshot_hash(
        &rootfs_hash,
        def.vcpu,
        def.memory_mb,
        FIRECRACKER_VERSION,
        KERNEL_VERSION,
        &provider.config_hash(),
    );
    tracing::info!("rootfs_hash: {rootfs_hash}, snapshot_hash: {snapshot_hash}");
    // Machine-readable output — consumed by CI workflows and ansible playbook.
    println!("rootfs_hash={rootfs_hash}");
    println!("snapshot_hash={snapshot_hash}");

    if dry_run {
        return Ok(());
    }

    let paths = HomePaths::new()?;

    // Ensure CA exists — rootfs build embeds the CA cert into the image.
    ca::ensure(&paths).await?;

    let rootfs_paths = RootfsPaths::new(&paths, &rootfs_hash);
    let snapshot_paths = rootfs_paths.snapshot(&snapshot_hash);
    let rootfs_dir = rootfs_paths.dir();
    let snapshot_dir = snapshot_paths.dir();

    // Fast path: both rootfs and snapshot already present.
    if is_rootfs_present(&rootfs_paths).await?
        && provider.is_complete(snapshot_dir).await.unwrap_or(false)
    {
        tracing::info!("[OK] image already built: rootfs={rootfs_hash}, snapshot={snapshot_hash}");
        touch_mtime(rootfs_dir);
        touch_mtime(snapshot_dir);
        return Ok(());
    }

    // R2 cache init. Fatal on partial config (1-3 of 4 vars set) — better than
    // silently disabling cache for a typo'd secret rotation.
    let r2 = R2ImageCache::from_env()
        .await
        .map_err(|e| RunnerError::Internal(format!("R2 cache init: {e}")))?;
    if r2.is_none() {
        // Info, not warn — dev environments routinely run without R2 configured.
        tracing::info!("R2 cache disabled (R2_* env vars not set) — skipping download and upload");
    }

    // Acquire exclusive locks to prevent concurrent builds and block GC.
    let _rootfs_lock = lock::acquire(paths.rootfs_lock(&rootfs_hash)).await?;
    let _snapshot_lock = lock::acquire(paths.snapshot_lock(&snapshot_hash)).await?;

    // Re-check after acquiring lock — another process may have completed the build.
    if is_rootfs_present(&rootfs_paths).await?
        && provider.is_complete(snapshot_dir).await.unwrap_or(false)
    {
        tracing::info!("[OK] image already built: rootfs={rootfs_hash}, snapshot={snapshot_hash}");
        touch_mtime(rootfs_dir);
        touch_mtime(snapshot_dir);
        return Ok(());
    }

    // Write scripts to a temp directory (needed for both R2 and local paths).
    let work_dir =
        tempfile::tempdir().map_err(|e| RunnerError::Internal(format!("create temp dir: {e}")))?;
    tokio::fs::write(work_dir.path().join("build-rootfs.sh"), BUILD_SCRIPT)
        .await
        .map_err(|e| RunnerError::Internal(format!("write build script: {e}")))?;
    tokio::fs::write(work_dir.path().join("verify-rootfs.sh"), VERIFY_SCRIPT)
        .await
        .map_err(|e| RunnerError::Internal(format!("write verify script: {e}")))?;
    tokio::fs::write(work_dir.path().join("inject-ca.sh"), INJECT_CA_SCRIPT)
        .await
        .map_err(|e| RunnerError::Internal(format!("write inject-ca script: {e}")))?;

    let ca_dir = paths.ca_dir();

    // --- Phase 1: Obtain rootfs ---
    //
    // R2 caches only rootfs.ext4. Snapshots are always created locally
    // because they contain host-specific state (page cache, kernel metadata).
    // Multiple snapshot variants can share one rootfs.

    let mut force_reupload = false;
    let mut rootfs_from_r2 = false;

    let need_rootfs = !is_rootfs_present(&rootfs_paths).await?;

    if need_rootfs {
        // Try R2 download (rootfs only). try_download manages its own staging
        // directory and atomic rename, so rootfs_dir stays absent on failure.
        if let Some(cache) = &r2 {
            match cache.try_download(&rootfs_hash, rootfs_dir).await {
                Ok(true) => {
                    if tokio::fs::try_exists(rootfs_paths.rootfs())
                        .await
                        .unwrap_or(false)
                    {
                        // Remove any non-rootfs files from the download (e.g. stale
                        // snapshot artifacts from an old archive format).
                        remove_all_except_rootfs(&rootfs_paths).await;
                        tracing::info!("[OK] rootfs downloaded from R2: {}", rootfs_dir.display());
                        rootfs_from_r2 = true;
                    } else {
                        tracing::warn!(
                            "R2 download for {rootfs_hash} succeeded but rootfs missing — \
                             will rebuild locally and force-overwrite the bad object"
                        );
                        force_reupload = true;
                        if let Err(e) = tokio::fs::remove_dir_all(rootfs_dir).await {
                            tracing::warn!(
                                "failed to clean bad R2 download at {}: {e}",
                                rootfs_dir.display()
                            );
                        }
                    }
                }
                Ok(false) => {
                    tracing::info!("R2 cache miss for {rootfs_hash} — building locally")
                }
                Err(e) => {
                    tracing::warn!("R2 download failed: {e} — falling back to local build")
                }
            }
        }

        if !rootfs_from_r2 {
            // Create rootfs_dir for local build (R2 path creates it via rename).
            tokio::fs::create_dir_all(rootfs_dir).await.map_err(|e| {
                RunnerError::Internal(format!("create {}: {e}", rootfs_dir.display()))
            })?;

            // Local rootfs build — the slow path (debootstrap + apt install).
            let rootfs_dir_str = rootfs_dir.to_string_lossy();
            let guest_agent_str = guest_agent.to_string_lossy();
            let guest_download_str = guest_download.to_string_lossy();
            let guest_init_str = guest_init.to_string_lossy();
            let guest_mock_claude_str = guest_mock_claude.to_string_lossy();
            let guest_reseed_str = guest_reseed.to_string_lossy();
            let ca_dir_str = ca_dir.to_string_lossy();
            let debootstrap_dir = paths.debootstrap_dir();
            tokio::fs::create_dir_all(&debootstrap_dir)
                .await
                .map_err(|e| {
                    RunnerError::Internal(format!("create {}: {e}", debootstrap_dir.display()))
                })?;
            let debootstrap_dir_str = debootstrap_dir.to_string_lossy();
            let disk_mb_str = def.disk_mb.to_string();

            let status = tokio::process::Command::new("bash")
                .arg(work_dir.path().join("build-rootfs.sh"))
                .args([
                    "--output-dir",
                    &rootfs_dir_str,
                    "--ca-dir",
                    &ca_dir_str,
                    "--debootstrap-dir",
                    &debootstrap_dir_str,
                    "--hash",
                    &rootfs_hash,
                    "--disk-mb",
                    &disk_mb_str,
                    "--guest-agent",
                    &guest_agent_str,
                    "--guest-download",
                    &guest_download_str,
                    "--guest-init",
                    &guest_init_str,
                    "--guest-mock-claude",
                    &guest_mock_claude_str,
                    "--guest-reseed",
                    &guest_reseed_str,
                    "--dns-nameserver",
                    "8.8.8.8",
                ])
                .stdin(std::process::Stdio::null())
                .status()
                .await
                .map_err(|e| RunnerError::Internal(format!("spawn build script: {e}")))?;

            if !status.success() {
                return Err(RunnerError::Internal(format!(
                    "build-rootfs.sh failed with {status}"
                )));
            }

            let rootfs_str = rootfs_paths.rootfs().to_string_lossy().into_owned();
            let status = tokio::process::Command::new("bash")
                .arg(work_dir.path().join("verify-rootfs.sh"))
                .args(["--rootfs", &rootfs_str])
                .stdin(std::process::Stdio::null())
                .status()
                .await
                .map_err(|e| RunnerError::Internal(format!("spawn verify script: {e}")))?;

            if !status.success() {
                return Err(RunnerError::Internal(format!(
                    "verify-rootfs.sh failed with {status}"
                )));
            }

            let rootfs_sz = file_sizes(&rootfs_paths.rootfs()).await;
            tracing::info!(
                rootfs_logical = %rootfs_sz.0,
                rootfs_disk = %rootfs_sz.1,
                "rootfs creation complete"
            );

            // Upload rootfs to R2 BEFORE CA injection — the cached rootfs should
            // be generic (build host's CA) so other hosts can download and inject
            // their own CA.
            if let Some(cache) = &r2 {
                let files = vec![rootfs_paths.rootfs()];
                match cache.upload(&rootfs_hash, &files, force_reupload).await {
                    Ok(()) => tracing::info!("uploaded rootfs to R2: {rootfs_hash}"),
                    Err(e) => tracing::warn!("R2 upload failed: {e} — rootfs is on local disk"),
                }
            }
        }
    } else {
        tracing::info!("[OK] rootfs already present: {}", rootfs_dir.display());
    }

    // --- Phase 1.5: Replace CA cert (R2-downloaded rootfs only) ---
    if rootfs_from_r2 {
        let rootfs_str = rootfs_paths.rootfs().to_string_lossy().into_owned();
        let ca_dir_str = ca_dir.to_string_lossy().into_owned();
        let status = tokio::process::Command::new("bash")
            .arg(work_dir.path().join("inject-ca.sh"))
            .args(["--rootfs", &rootfs_str, "--ca-dir", &ca_dir_str])
            .stdin(std::process::Stdio::null())
            .status()
            .await
            .map_err(|e| RunnerError::Internal(format!("spawn inject-ca script: {e}")))?;

        if !status.success() {
            return Err(RunnerError::Internal(format!(
                "inject-ca.sh failed with {status}"
            )));
        }
        tracing::info!("CA cert replaced in R2-downloaded rootfs");
    }

    // --- Phase 2: Build snapshot ---
    //
    // Snapshot dir is nested under the rootfs dir:
    // <images>/<rootfs_hash>/snapshots/<snapshot_hash>/
    tokio::fs::create_dir_all(snapshot_dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create {}: {e}", snapshot_dir.display())))?;

    let rootfs_path = rootfs_paths.rootfs();
    let create_config = sandbox::SnapshotCreateConfig {
        id: snapshot_hash.clone(),
        binary_path: paths.firecracker_bin(FIRECRACKER_VERSION),
        kernel_path: paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION),
        rootfs_path,
        output_dir: snapshot_dir.to_path_buf(),
        vcpu_count: def.vcpu,
        memory_mb: def.memory_mb,
    };

    let output = provider.create_snapshot(create_config).await?;

    let (snapshot_sz, memory_sz, cow_sz) = tokio::join!(
        file_sizes(&output.snapshot_path),
        file_sizes(&output.memory_path),
        file_sizes(&output.cow_path),
    );
    tracing::info!(
        snapshot_logical = %snapshot_sz.0,
        snapshot_disk = %snapshot_sz.1,
        memory_logical = %memory_sz.0,
        memory_disk = %memory_sz.1,
        cow_logical = %cow_sz.0,
        cow_disk = %cow_sz.1,
        "snapshot creation complete"
    );

    tracing::info!("image creation complete: rootfs={rootfs_hash}, snapshot={snapshot_hash}");
    Ok(())
}

/// Remove all files in the rootfs directory except rootfs.ext4 and the snapshots/ subtree.
///
/// After an R2 download the archive may contain stale artifacts from an
/// older cache format. Cleaning them ensures `create_snapshot` writes
/// into a clean snapshot subdirectory.
async fn remove_all_except_rootfs(rootfs: &RootfsPaths) {
    let rootfs_name = std::ffi::OsStr::new("rootfs.ext4");
    let snapshots_name = std::ffi::OsStr::new("snapshots");
    let mut entries = match tokio::fs::read_dir(rootfs.dir()).await {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("failed to read dir {}: {e}", rootfs.dir().display());
            return;
        }
    };
    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(e) => {
                tracing::warn!("read entry in {}: {e}", rootfs.dir().display());
                break;
            }
        };
        let name = entry.file_name();
        if name != rootfs_name && name != snapshots_name {
            let path = entry.path();
            let result = if path.is_dir() {
                tokio::fs::remove_dir_all(&path).await
            } else {
                tokio::fs::remove_file(&path).await
            };
            if let Err(e) = result {
                tracing::warn!("failed to remove stale entry {}: {e}", path.display());
            }
        }
    }
}

/// Check whether rootfs.ext4 exists.
async fn is_rootfs_present(rootfs: &RootfsPaths) -> RunnerResult<bool> {
    tokio::fs::try_exists(rootfs.rootfs())
        .await
        .map_err(|e| RunnerError::Internal(format!("check {}: {e}", rootfs.rootfs().display())))
}

/// Compute a rootfs-only hash for R2 image caching.
///
/// Inputs:
///   - `ROOTFS_CACHE_VERSION` — bump to force invalidation
///   - `BUILD_SCRIPT` — rootfs build script content
///   - `disk_mb` — disk size from profile
///   - guest binaries — sorted by destination path
///
/// Snapshot-specific fields (vcpu, memory, firecracker/kernel version,
/// provider config) are excluded — they go into `compute_snapshot_hash`.
///
/// **Changing this function invalidates all cached rootfs images.**
async fn compute_rootfs_hash(guest_bins: &[(&Path, &str)], disk_mb: u32) -> RunnerResult<String> {
    let mut hasher = Sha256::new();

    hasher.update(b"rootfs_version:");
    hasher.update(ROOTFS_CACHE_VERSION.to_le_bytes());

    hasher.update(b"script:");
    hasher.update(BUILD_SCRIPT.as_bytes());
    hasher.update(b"disk_mb:");
    hasher.update(disk_mb.to_le_bytes());

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

/// Compute a snapshot hash from all inputs that affect snapshot content.
///
/// This hash is local-only (R2 stores only rootfs). It covers:
///   - `SNAPSHOT_CACHE_VERSION` — manual bump counter
///   - `rootfs_hash` — the rootfs this snapshot is built from
///   - `vcpu`, `memory_mb` — VM resource config
///   - `fc_version`, `kernel_version` — Firecracker and guest kernel versions
///   - `provider_config_hash` — sandbox-fc internal config (boot args, prewarm, etc.)
fn compute_snapshot_hash(
    rootfs_hash: &str,
    vcpu: u32,
    memory_mb: u32,
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
    hasher.update(b"fc_version:");
    hasher.update(fc_version.as_bytes());
    hasher.update(b"kernel_version:");
    hasher.update(kernel_version.as_bytes());
    hasher.update(b"provider_config:");
    hasher.update(provider_config_hash.as_bytes());

    hex::encode(hasher.finalize())
}

/// Return `(logical, disk)` as human-readable strings (e.g. "65.2 MiB").
///
/// `logical` is the apparent file size; `disk` is the actual disk usage
/// (from `st_blocks`), which can be much smaller for sparse files like rootfs.
async fn file_sizes(path: &Path) -> (String, String) {
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

    #[tokio::test]
    async fn compute_rootfs_hash_deterministic() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("agent");
        tokio::fs::write(&bin, b"binary-content").await.unwrap();
        let bins: &[(&Path, &str)] = &[(&bin, "/usr/local/bin/guest-agent")];

        let h1 = compute_rootfs_hash(bins, 16384).await.unwrap();
        let h2 = compute_rootfs_hash(bins, 16384).await.unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // SHA-256 hex
    }

    #[tokio::test]
    async fn compute_rootfs_hash_sensitive_to_all_inputs() {
        let dir = tempfile::tempdir().unwrap();
        let bin_a = dir.path().join("agent-a");
        let bin_b = dir.path().join("agent-b");
        tokio::fs::write(&bin_a, b"content-a").await.unwrap();
        tokio::fs::write(&bin_b, b"content-b").await.unwrap();

        let base = compute_rootfs_hash(&[(&bin_a, "/usr/local/bin/guest-agent")], 16384)
            .await
            .unwrap();

        let different_content =
            compute_rootfs_hash(&[(&bin_b, "/usr/local/bin/guest-agent")], 16384)
                .await
                .unwrap();
        assert_ne!(
            base, different_content,
            "hash must change with binary content"
        );

        let different_disk = compute_rootfs_hash(&[(&bin_a, "/usr/local/bin/guest-agent")], 32768)
            .await
            .unwrap();
        assert_ne!(base, different_disk, "hash must change with disk_mb");

        let different_dest =
            compute_rootfs_hash(&[(&bin_a, "/usr/local/bin/guest-download")], 16384)
                .await
                .unwrap();
        assert_ne!(base, different_dest, "hash must change with dest path");
    }

    #[test]
    fn compute_snapshot_hash_deterministic() {
        let h1 = compute_snapshot_hash("rootfs_aaa", 2, 4096, "v1.14.1", "6.1.155", "config_xxx");
        let h2 = compute_snapshot_hash("rootfs_aaa", 2, 4096, "v1.14.1", "6.1.155", "config_xxx");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn compute_snapshot_hash_sensitive_to_each_field() {
        let base = compute_snapshot_hash("rootfs_aaa", 2, 4096, "v1.14.1", "6.1.155", "cfg");

        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_bbb", 2, 4096, "v1.14.1", "6.1.155", "cfg"),
            "must change with rootfs_hash"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 4, 4096, "v1.14.1", "6.1.155", "cfg"),
            "must change with vcpu"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 2, 8192, "v1.14.1", "6.1.155", "cfg"),
            "must change with memory_mb"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 2, 4096, "v1.15.0", "6.1.155", "cfg"),
            "must change with fc_version"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 2, 4096, "v1.14.1", "6.2.0", "cfg"),
            "must change with kernel_version"
        );
        assert_ne!(
            base,
            compute_snapshot_hash("rootfs_aaa", 2, 4096, "v1.14.1", "6.1.155", "cfg2"),
            "must change with provider_config_hash"
        );
    }

    #[tokio::test]
    async fn is_rootfs_present_checks_rootfs_file() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "test-hash");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        assert!(!is_rootfs_present(&rootfs).await.unwrap());

        tokio::fs::write(rootfs.rootfs(), b"").await.unwrap();
        assert!(is_rootfs_present(&rootfs).await.unwrap());
    }

    /// Guard the `[sync:ca-constants]` contract between build-rootfs.sh,
    /// inject-ca.sh, and verify-rootfs.sh. Drift would cause silent CA
    /// injection/verification failures on R2-downloaded rootfs.
    #[test]
    fn ca_constants_in_sync_across_scripts() {
        let ca_cert_line = r#"CA_CERT_FILE="mitmproxy-ca-cert.pem""#;
        let ca_dest_line = r#"CA_ROOTFS_DEST="usr/local/share/ca-certificates/vm0-proxy-ca.crt""#;

        // Scripts that use both constants.
        for (script, name) in [
            (BUILD_SCRIPT, "build-rootfs.sh"),
            (INJECT_CA_SCRIPT, "inject-ca.sh"),
        ] {
            assert!(
                script.contains(ca_cert_line),
                "{name} missing CA_CERT_FILE constant — sync with other scripts"
            );
            assert!(
                script.contains(ca_dest_line),
                "{name} missing CA_ROOTFS_DEST constant — sync with other scripts"
            );
        }

        // verify-rootfs.sh only uses CA_ROOTFS_DEST (it reads the cert from
        // inside the rootfs, not from the host CA_DIR).
        assert!(
            VERIFY_SCRIPT.contains(ca_dest_line),
            "verify-rootfs.sh missing CA_ROOTFS_DEST constant — sync with other scripts"
        );
    }

    /// Guard: inject-ca.sh must verify the CA actually made it into the
    /// system bundle after `update-ca-certificates`. `update-ca-certificates`
    /// can exit 0 while silently omitting our cert (e.g. malformed PEM),
    /// which would later surface as an opaque snapshot/VM-boot TLS error.
    /// See #9482.
    #[test]
    fn inject_ca_verifies_bundle_after_update() {
        assert!(
            INJECT_CA_SCRIPT.contains("update-ca-certificates"),
            "inject-ca.sh must call update-ca-certificates"
        );
        assert!(
            INJECT_CA_SCRIPT.contains("proxy CA not found in system bundle"),
            "inject-ca.sh must verify proxy CA landed in system bundle after \
             update-ca-certificates (silent failure guard; see #9482)"
        );
    }

    #[tokio::test]
    async fn is_rootfs_present_nonexistent_dir() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "does-not-exist");

        assert!(!is_rootfs_present(&rootfs).await.unwrap());
    }

    #[tokio::test]
    async fn remove_all_except_rootfs_preserves_rootfs_and_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "test-hash");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
        tokio::fs::write(rootfs.rootfs(), b"rootfs").await.unwrap();

        // Create a snapshots/ subdir with content
        let snap_dir = rootfs.dir().join("snapshots").join("snap1");
        tokio::fs::create_dir_all(&snap_dir).await.unwrap();
        tokio::fs::write(snap_dir.join("snapshot.bin"), b"snap")
            .await
            .unwrap();

        // Create a stale file that should be removed
        tokio::fs::write(rootfs.dir().join("stale.txt"), b"old")
            .await
            .unwrap();

        remove_all_except_rootfs(&rootfs).await;

        assert!(rootfs.rootfs().exists(), "rootfs.ext4 must survive");
        assert!(
            snap_dir.join("snapshot.bin").exists(),
            "snapshots/ must survive"
        );
        assert!(
            !rootfs.dir().join("stale.txt").exists(),
            "stale file must be removed"
        );
    }

    #[tokio::test]
    async fn file_sizes_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.bin");
        tokio::fs::write(&path, vec![0u8; 1024]).await.unwrap();

        let (logical, disk) = file_sizes(&path).await;
        assert_eq!(logical, "1.0 KiB");
        assert_ne!(disk, "?");
    }

    #[tokio::test]
    async fn file_sizes_nonexistent_file() {
        let (logical, disk) = file_sizes(Path::new("/nonexistent/file.bin")).await;
        assert_eq!(logical, "?");
        assert_eq!(disk, "?");
    }
}
