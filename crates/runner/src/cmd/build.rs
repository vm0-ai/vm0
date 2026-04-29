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
///
/// Bumped 1 → 2 alongside the staging-rename contract for rootfs assembly
/// (see #11007). The old contract let a partially-applied R2 + CA-injection
/// pipeline leave `rootfs.ext4` on disk in a corrupt state (new CA file,
/// stale system bundle). The new code prevents that going forward, but
/// cannot heal existing corrupt rootfs already on hosts — bumping the
/// version forces every host to regenerate under the new contract on the
/// next build.
const ROOTFS_CACHE_VERSION: u32 = 2;

/// Bump to invalidate all cached snapshots (local only; R2 stores rootfs only).
const SNAPSHOT_CACHE_VERSION: u32 = 1;

#[cfg(bundled_guests)]
mod embedded {
    pub const GUEST_INIT: &[u8] = include_bytes!(env!("BUNDLED_GUEST_INIT"));
    pub const GUEST_DOWNLOAD: &[u8] = include_bytes!(env!("BUNDLED_GUEST_DOWNLOAD"));
    pub const GUEST_AGENT: &[u8] = include_bytes!(env!("BUNDLED_GUEST_AGENT"));
    pub const GUEST_MOCK_CLAUDE: &[u8] = include_bytes!(env!("BUNDLED_GUEST_MOCK_CLAUDE"));
    pub const GUEST_MOCK_CODEX: &[u8] = include_bytes!(env!("BUNDLED_GUEST_MOCK_CODEX"));
    pub const GUEST_RESEED: &[u8] = include_bytes!(env!("BUNDLED_GUEST_RESEED"));
}

#[cfg(bundled_guests)]
fn bundled_guest(name: &str) -> Option<&'static [u8]> {
    match name {
        "guest-agent" => Some(embedded::GUEST_AGENT),
        "guest-download" => Some(embedded::GUEST_DOWNLOAD),
        "guest-init" => Some(embedded::GUEST_INIT),
        "guest-mock-claude" => Some(embedded::GUEST_MOCK_CLAUDE),
        "guest-mock-codex" => Some(embedded::GUEST_MOCK_CODEX),
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
        arg(long, help = "Path to guest-mock-codex binary [default: bundled]")
    )]
    #[cfg_attr(
        not(bundled_guests),
        arg(long, help = "Path to guest-mock-codex binary (required)")
    )]
    guest_mock_codex: Option<PathBuf>,
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
    /// Build or upload only the shared R2 rootfs cache, without creating a snapshot
    #[arg(long)]
    pub warm_rootfs_cache: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RootfsCachePolicy {
    BestEffort,
    StrictWarm,
}

impl RootfsCachePolicy {
    fn is_strict(self) -> bool {
        matches!(self, Self::StrictWarm)
    }
}

struct RootfsBuildInput<'a> {
    paths: &'a HomePaths,
    rootfs_hash: &'a str,
    rootfs_paths: &'a RootfsPaths,
    r2: Option<&'a R2ImageCache>,
    policy: RootfsCachePolicy,
    disk_mb: u32,
    guest_agent: &'a Path,
    guest_download: &'a Path,
    guest_init: &'a Path,
    guest_mock_claude: &'a Path,
    guest_mock_codex: &'a Path,
    guest_reseed: &'a Path,
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
    let warm_rootfs_cache = args.warm_rootfs_cache;

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
    let guest_mock_codex =
        resolve_guest(args.guest_mock_codex, "guest-mock-codex", tmp_dir.path()).await?;
    let guest_reseed = resolve_guest(args.guest_reseed, "guest-reseed", tmp_dir.path()).await?;

    // Fixed order for deterministic hashing — do NOT reorder.
    let bins: [(&Path, &str); 6] = [
        (guest_agent.as_path(), "/usr/local/bin/guest-agent"),
        (guest_download.as_path(), "/usr/local/bin/guest-download"),
        (guest_init.as_path(), "/sbin/guest-init"),
        (guest_reseed.as_path(), "/sbin/guest-reseed"),
        (
            guest_mock_claude.as_path(),
            "/usr/local/bin/guest-mock-claude",
        ),
        (
            guest_mock_codex.as_path(),
            "/usr/local/bin/guest-mock-codex",
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
    if !warm_rootfs_cache
        && is_rootfs_present(&rootfs_paths).await?
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
        if warm_rootfs_cache {
            return Err(RunnerError::Internal(
                "--warm-rootfs-cache requires all R2_* image cache environment variables".into(),
            ));
        }
        // Info, not warn — dev environments routinely run without R2 configured.
        tracing::info!("R2 cache disabled (R2_* env vars not set) — skipping download and upload");
    }

    let policy = if warm_rootfs_cache {
        RootfsCachePolicy::StrictWarm
    } else {
        RootfsCachePolicy::BestEffort
    };
    let input = RootfsBuildInput {
        paths: &paths,
        rootfs_hash: &rootfs_hash,
        rootfs_paths: &rootfs_paths,
        r2: r2.as_ref(),
        policy,
        disk_mb: def.disk_mb,
        guest_agent: &guest_agent,
        guest_download: &guest_download,
        guest_init: &guest_init,
        guest_mock_claude: &guest_mock_claude,
        guest_mock_codex: &guest_mock_codex,
        guest_reseed: &guest_reseed,
    };

    if warm_rootfs_cache {
        if upload_existing_rootfs_for_warm_if_present(&input, paths.rootfs_lock(&rootfs_hash))
            .await?
        {
            tracing::info!("rootfs cache warm complete: rootfs={rootfs_hash}");
            return Ok(());
        }

        let rootfs_lock_path = paths.rootfs_lock(&rootfs_hash);
        tracing::info!(
            "acquiring exclusive rootfs lock for warm build: {}",
            rootfs_lock_path.display()
        );
        let _rootfs_lock = lock::acquire(rootfs_lock_path).await?;
        ensure_rootfs_under_lock(input).await?;
        tracing::info!("rootfs cache warm complete: rootfs={rootfs_hash}");
        return Ok(());
    }

    // Acquire the rootfs lock before any rootfs mutation. Full builds keep it
    // through snapshot creation so GC cannot reap the rootfs while the snapshot
    // provider is reading it.
    let rootfs_lock_path = paths.rootfs_lock(&rootfs_hash);
    tracing::info!(
        "acquiring exclusive rootfs lock for image build: {}",
        rootfs_lock_path.display()
    );
    let _rootfs_lock = lock::acquire(rootfs_lock_path).await?;
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

    ensure_rootfs_under_lock(input).await?;

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

async fn ensure_rootfs_under_lock(input: RootfsBuildInput<'_>) -> RunnerResult<()> {
    let rootfs_dir = input.rootfs_paths.dir();

    // Clear any `rootfs.ext4.staging` residue from a previous crashed or
    // failed build. Holding the rootfs flock means the previous writer has
    // already exited (kernel releases flocks on process death), so any
    // staging file on disk is guaranteed to be stale — never a concurrent
    // writer's work-in-progress. This is the recovery arm of the
    // staging-rename contract; see `RootfsPaths::rootfs_staging`.
    clear_rootfs_staging(input.rootfs_paths).await;

    // --- Phase 1: Obtain rootfs ---
    //
    // R2 caches only rootfs.ext4. Snapshots are always created locally
    // because they contain host-specific state (page cache, kernel metadata).
    // Multiple snapshot variants can share one rootfs.
    let mut force_reupload = false;
    let mut rootfs_from_r2 = false;

    let need_rootfs = !is_rootfs_present(input.rootfs_paths).await?;
    let mut work_dir = None;

    if need_rootfs {
        // Try R2 download (rootfs only). try_download manages its own staging
        // directory and atomic rename, so rootfs_dir stays absent on failure.
        if let Some(cache) = input.r2 {
            match cache.try_download(input.rootfs_hash, rootfs_dir).await {
                Ok(true) => {
                    if tokio::fs::try_exists(input.rootfs_paths.rootfs())
                        .await
                        .unwrap_or(false)
                    {
                        // Remove any non-rootfs files from the download (e.g. stale
                        // snapshot artifacts from an old archive format).
                        remove_all_except_rootfs(input.rootfs_paths).await;
                        tracing::info!("[OK] rootfs downloaded from R2: {}", rootfs_dir.display());
                        // Demote the downloaded image to staging before CA
                        // injection runs. The R2-cached rootfs carries the
                        // build host's CA; Phase 1.5 replaces it. Keeping
                        // the file at the committed `rootfs.ext4` path
                        // during injection would let a mid-script crash
                        // leave a rootfs whose CA file no longer matches
                        // its system bundle, permanently poisoning the
                        // Fast-path reuse check.
                        demote_to_staging(input.rootfs_paths).await?;
                        rootfs_from_r2 = true;
                    } else {
                        tracing::warn!(
                            "R2 download for {} succeeded but rootfs missing — \
                             will rebuild locally and force-overwrite the bad object",
                            input.rootfs_hash
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
                    tracing::info!("R2 cache miss for {} — building locally", input.rootfs_hash)
                }
                Err(e) => {
                    if e.is_invalid_object() {
                        tracing::warn!(
                            "R2 object for {} is invalid ({e}) — \
                             rebuilding locally and force-overwriting the bad object",
                            input.rootfs_hash
                        );
                        force_reupload = true;
                    } else if input.policy.is_strict() {
                        return Err(RunnerError::Internal(format!(
                            "R2 download failed while warming rootfs cache: {e}"
                        )));
                    } else {
                        tracing::warn!("R2 download failed: {e} — falling back to local build");
                    }
                }
            }
        }

        if !rootfs_from_r2 {
            let work_dir_path = work_dir_for_rootfs(&mut work_dir).await?;
            build_rootfs_locally(&input, &work_dir_path).await?;
            upload_rootfs_to_r2(&input, force_reupload).await?;
        }
    } else {
        tracing::info!("[OK] rootfs already present: {}", rootfs_dir.display());
        if input.policy.is_strict() {
            upload_rootfs_to_r2(&input, false).await?;
        }
    }

    // --- Phase 1.5: Replace CA cert (R2-downloaded rootfs only) ---
    //
    // Operates on `rootfs.ext4.staging` (not `rootfs.ext4`). On non-zero
    // exit we leave the staging file in place — the next build's
    // `clear_rootfs_staging` step above deletes it. We deliberately do
    // NOT remove `rootfs_dir`: snapshots for other snapshot_hashes (same
    // rootfs_hash, different vcpu/memory profile) live under
    // `<rootfs_dir>/snapshots/` and would be collateral damage.
    if rootfs_from_r2 {
        let work_dir_path = work_dir_for_rootfs(&mut work_dir).await?;
        inject_ca_into_staging(&input, &work_dir_path).await?;
        // Commit the rootfs. Same-filesystem rename is POSIX-atomic, so
        // `rootfs.ext4` only becomes visible once CA injection has fully
        // succeeded — future `is_rootfs_present` / Fast-path checks can
        // now trust its presence as "assembly pipeline completed".
        commit_staging(input.rootfs_paths).await?;
        tracing::info!("CA cert replaced in R2-downloaded rootfs");
    }

    Ok(())
}

async fn upload_existing_rootfs_for_warm_if_present(
    input: &RootfsBuildInput<'_>,
    rootfs_lock_path: PathBuf,
) -> RunnerResult<bool> {
    if !is_rootfs_present(input.rootfs_paths).await? {
        return Ok(false);
    }

    tracing::info!(
        "rootfs already present; acquiring shared rootfs lock for warm upload: {}",
        rootfs_lock_path.display()
    );
    let _rootfs_lock = lock::acquire_shared(rootfs_lock_path).await?;
    if !is_rootfs_present(input.rootfs_paths).await? {
        tracing::info!("rootfs disappeared while waiting for shared lock; rebuilding for warm");
        return Ok(false);
    }

    upload_rootfs_to_r2(input, false).await?;
    Ok(true)
}

async fn work_dir_for_rootfs(work_dir: &mut Option<tempfile::TempDir>) -> RunnerResult<PathBuf> {
    if work_dir.is_none() {
        let dir = tempfile::tempdir()
            .map_err(|e| RunnerError::Internal(format!("create temp dir: {e}")))?;
        tokio::fs::write(dir.path().join("build-rootfs.sh"), BUILD_SCRIPT)
            .await
            .map_err(|e| RunnerError::Internal(format!("write build script: {e}")))?;
        tokio::fs::write(dir.path().join("verify-rootfs.sh"), VERIFY_SCRIPT)
            .await
            .map_err(|e| RunnerError::Internal(format!("write verify script: {e}")))?;
        tokio::fs::write(dir.path().join("inject-ca.sh"), INJECT_CA_SCRIPT)
            .await
            .map_err(|e| RunnerError::Internal(format!("write inject-ca script: {e}")))?;
        *work_dir = Some(dir);
    }
    match work_dir.as_ref() {
        Some(dir) => Ok(dir.path().to_path_buf()),
        None => Err(RunnerError::Internal(
            "rootfs work dir was not initialized".into(),
        )),
    }
}

async fn build_rootfs_locally(input: &RootfsBuildInput<'_>, work_dir: &Path) -> RunnerResult<()> {
    let rootfs_dir = input.rootfs_paths.dir();
    // Create rootfs_dir for local build (R2 path creates it via rename).
    tokio::fs::create_dir_all(rootfs_dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create {}: {e}", rootfs_dir.display())))?;

    // Local rootfs build — the slow path (debootstrap + apt install).
    let rootfs_dir_str = rootfs_dir.to_string_lossy();
    let guest_agent_str = input.guest_agent.to_string_lossy();
    let guest_download_str = input.guest_download.to_string_lossy();
    let guest_init_str = input.guest_init.to_string_lossy();
    let guest_mock_claude_str = input.guest_mock_claude.to_string_lossy();
    let guest_mock_codex_str = input.guest_mock_codex.to_string_lossy();
    let guest_reseed_str = input.guest_reseed.to_string_lossy();
    let ca_dir = input.paths.ca_dir();
    let ca_dir_str = ca_dir.to_string_lossy();
    let debootstrap_dir = input.paths.debootstrap_dir();
    tokio::fs::create_dir_all(&debootstrap_dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create {}: {e}", debootstrap_dir.display())))?;
    let debootstrap_dir_str = debootstrap_dir.to_string_lossy();
    let disk_mb_str = input.disk_mb.to_string();

    let status = tokio::process::Command::new("bash")
        .arg(work_dir.join("build-rootfs.sh"))
        .args([
            "--output-dir",
            &rootfs_dir_str,
            "--ca-dir",
            &ca_dir_str,
            "--debootstrap-dir",
            &debootstrap_dir_str,
            "--hash",
            input.rootfs_hash,
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
            "--guest-mock-codex",
            &guest_mock_codex_str,
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

    let rootfs_str = input.rootfs_paths.rootfs().to_string_lossy().into_owned();
    let status = tokio::process::Command::new("bash")
        .arg(work_dir.join("verify-rootfs.sh"))
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

    let rootfs_sz = file_sizes(&input.rootfs_paths.rootfs()).await;
    tracing::info!(
        rootfs_logical = %rootfs_sz.0,
        rootfs_disk = %rootfs_sz.1,
        "rootfs creation complete"
    );

    Ok(())
}

async fn upload_rootfs_to_r2(input: &RootfsBuildInput<'_>, force: bool) -> RunnerResult<()> {
    let Some(cache) = input.r2 else {
        if input.policy.is_strict() {
            return Err(RunnerError::Internal(
                "--warm-rootfs-cache requires R2 cache configuration".into(),
            ));
        }
        return Ok(());
    };

    let files = vec![input.rootfs_paths.rootfs()];
    match cache.upload(input.rootfs_hash, &files, force).await {
        Ok(()) => {
            tracing::info!("uploaded rootfs to R2: {}", input.rootfs_hash);
            Ok(())
        }
        Err(e) if input.policy.is_strict() => Err(RunnerError::Internal(format!(
            "R2 upload failed while warming rootfs cache: {e}"
        ))),
        Err(e) => {
            tracing::warn!("R2 upload failed: {e} — rootfs is on local disk");
            Ok(())
        }
    }
}

async fn inject_ca_into_staging(input: &RootfsBuildInput<'_>, work_dir: &Path) -> RunnerResult<()> {
    let staging = input.rootfs_paths.rootfs_staging();
    let staging_str = staging.to_string_lossy().into_owned();
    let ca_dir = input.paths.ca_dir();
    let ca_dir_str = ca_dir.to_string_lossy().into_owned();
    let status = tokio::process::Command::new("bash")
        .arg(work_dir.join("inject-ca.sh"))
        .args(["--rootfs", &staging_str, "--ca-dir", &ca_dir_str])
        .stdin(std::process::Stdio::null())
        .status()
        .await
        .map_err(|e| RunnerError::Internal(format!("spawn inject-ca script: {e}")))?;

    if !status.success() {
        return Err(RunnerError::Internal(format!(
            "inject-ca.sh failed with {status}"
        )));
    }

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
///
/// Under the staging-rename contract, `rootfs.ext4` only exists if the
/// full assembly pipeline (download/build + CA injection) has committed,
/// so `true` here implies "fully built and ready to use". A concurrent
/// in-progress build writes to `rootfs.ext4.staging`, which this function
/// intentionally ignores.
async fn is_rootfs_present(rootfs: &RootfsPaths) -> RunnerResult<bool> {
    tokio::fs::try_exists(rootfs.rootfs())
        .await
        .map_err(|e| RunnerError::Internal(format!("check {}: {e}", rootfs.rootfs().display())))
}

/// Delete any `rootfs.ext4.staging` left behind by a previous build.
///
/// Called under the rootfs flock before rootfs work continues. Because
/// holding the flock implies the previous writer has exited (the kernel
/// releases flocks on process death), any staging file we see here is
/// guaranteed to be crash residue — not a live writer's in-progress file.
/// A committed `rootfs.ext4`, if present, is left untouched.
///
/// Non-existence is the common case and not logged. Removal is best
/// effort: an error here just means the next step (writing new staging)
/// will overwrite the file anyway.
async fn clear_rootfs_staging(rootfs: &RootfsPaths) {
    let staging = rootfs.rootfs_staging();
    match tokio::fs::try_exists(&staging).await {
        Ok(true) => {
            tracing::warn!(
                "removing stale rootfs staging file from a previous failed build: {}",
                staging.display()
            );
            if let Err(e) = tokio::fs::remove_file(&staging).await {
                tracing::warn!(
                    "failed to remove stale staging file {}: {e}",
                    staging.display()
                );
            }
        }
        Ok(false) => {}
        Err(e) => {
            tracing::warn!(
                "check staging {}: {e} (continuing; any residue will be overwritten)",
                staging.display()
            );
        }
    }
}

/// Rename `rootfs.ext4 → rootfs.ext4.staging` to move an R2-downloaded
/// image into pre-commit state before CA injection runs.
///
/// Fails loudly: if the rename cannot happen, proceeding would let
/// inject-ca mutate the committed path directly, recreating the TOCTOU
/// bug this contract exists to close. On rename failure we also
/// best-effort delete the source — otherwise the committed `rootfs.ext4`
/// would survive with the build host's CA still baked into its system
/// bundle, and the next build's Fast path would reuse it without running
/// inject-ca. Both outcomes of the cleanup (succeeded / also failed)
/// emit a warning so an operator reading the `Err` return can tell
/// whether the source file is still on disk.
async fn demote_to_staging(rootfs: &RootfsPaths) -> RunnerResult<()> {
    let from = rootfs.rootfs();
    let to = rootfs.rootfs_staging();
    match tokio::fs::rename(&from, &to).await {
        Ok(()) => Ok(()),
        Err(e) => {
            match tokio::fs::remove_file(&from).await {
                Ok(()) => tracing::warn!(
                    "rename {} → {} failed: {e}; source removed to prevent \
                     Fast-path reuse of an un-CA-injected rootfs",
                    from.display(),
                    to.display()
                ),
                Err(rm_err) => tracing::warn!(
                    "rename {} → {} failed: {e}; cleanup remove also failed: \
                     {rm_err}. Manual intervention may be required to remove \
                     {}.",
                    from.display(),
                    to.display(),
                    from.display()
                ),
            }
            Err(RunnerError::Internal(format!(
                "demote to staging {} → {}: {e}",
                from.display(),
                to.display()
            )))
        }
    }
}

/// Atomic commit: rename `rootfs.ext4.staging → rootfs.ext4`.
///
/// Same-filesystem rename is POSIX-atomic, so this is the single step
/// that makes the rootfs visible to future `is_rootfs_present` checks.
async fn commit_staging(rootfs: &RootfsPaths) -> RunnerResult<()> {
    let from = rootfs.rootfs_staging();
    let to = rootfs.rootfs();
    tokio::fs::rename(&from, &to).await.map_err(|e| {
        RunnerError::Internal(format!(
            "commit rootfs {} → {}: {e}",
            from.display(),
            to.display()
        ))
    })
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

    #[derive(clap::Parser)]
    struct TestBuildCli {
        #[command(flatten)]
        args: BuildArgs,
    }

    fn build_args() -> [&'static str; 15] {
        [
            "runner-build",
            "--guest-agent",
            "/tmp/guest-agent",
            "--guest-download",
            "/tmp/guest-download",
            "--guest-init",
            "/tmp/guest-init",
            "--guest-mock-claude",
            "/tmp/guest-mock-claude",
            "--guest-mock-codex",
            "/tmp/guest-mock-codex",
            "--guest-reseed",
            "/tmp/guest-reseed",
            "--profile",
            "vm0/default",
        ]
    }

    fn rootfs_input<'a>(
        home: &'a HomePaths,
        rootfs: &'a RootfsPaths,
        guest: &'a Path,
        policy: RootfsCachePolicy,
        r2: Option<&'a R2ImageCache>,
    ) -> RootfsBuildInput<'a> {
        RootfsBuildInput {
            paths: home,
            rootfs_hash: "test-hash",
            rootfs_paths: rootfs,
            r2,
            policy,
            disk_mb: 16384,
            guest_agent: guest,
            guest_download: guest,
            guest_init: guest,
            guest_mock_claude: guest,
            guest_mock_codex: guest,
            guest_reseed: guest,
        }
    }

    #[test]
    fn build_args_parse_warm_rootfs_cache_flag() {
        let mut args = build_args().to_vec();
        args.push("--warm-rootfs-cache");

        let cli = <TestBuildCli as clap::Parser>::try_parse_from(args).unwrap();

        assert!(cli.args.warm_rootfs_cache);
        assert!(!cli.args.dry_run);
    }

    #[test]
    fn rootfs_cache_policy_marks_only_warm_as_strict() {
        assert!(!RootfsCachePolicy::BestEffort.is_strict());
        assert!(RootfsCachePolicy::StrictWarm.is_strict());
    }

    #[tokio::test]
    async fn work_dir_for_rootfs_writes_embedded_scripts_once() {
        let mut work_dir = None;

        let first = work_dir_for_rootfs(&mut work_dir).await.unwrap();
        let second = work_dir_for_rootfs(&mut work_dir).await.unwrap();

        assert_eq!(first, second);
        assert!(first.join("build-rootfs.sh").exists());
        assert!(first.join("verify-rootfs.sh").exists());
        assert!(first.join("inject-ca.sh").exists());
    }

    #[tokio::test]
    async fn strict_upload_requires_r2_cache() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "strict-hash");
        let guest = dir.path().join("guest");
        let input = rootfs_input(&home, &rootfs, &guest, RootfsCachePolicy::StrictWarm, None);

        let err = upload_rootfs_to_r2(&input, false).await.unwrap_err();

        assert!(err.to_string().contains("--warm-rootfs-cache requires R2"));
    }

    #[tokio::test]
    async fn best_effort_upload_allows_missing_r2_cache() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "best-effort-hash");
        let guest = dir.path().join("guest");
        let input = rootfs_input(&home, &rootfs, &guest, RootfsCachePolicy::BestEffort, None);

        upload_rootfs_to_r2(&input, false).await.unwrap();
    }

    #[tokio::test]
    async fn strict_warm_existing_rootfs_still_requires_r2_cache() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "strict-local-hash");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
        tokio::fs::write(rootfs.rootfs(), b"local-rootfs")
            .await
            .unwrap();
        let guest = dir.path().join("guest");
        let input = rootfs_input(&home, &rootfs, &guest, RootfsCachePolicy::StrictWarm, None);

        let err = ensure_rootfs_under_lock(input).await.unwrap_err();

        assert!(err.to_string().contains("--warm-rootfs-cache requires R2"));
        assert!(
            rootfs.rootfs().exists(),
            "strict warm must not remove a valid local rootfs when R2 is missing"
        );
    }

    #[tokio::test]
    async fn warm_existing_rootfs_upload_does_not_block_on_shared_rootfs_lock() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "warm-shared-lock-hash");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
        tokio::fs::write(rootfs.rootfs(), b"local-rootfs")
            .await
            .unwrap();
        let guest = dir.path().join("guest");
        let input = rootfs_input(&home, &rootfs, &guest, RootfsCachePolicy::StrictWarm, None);
        let rootfs_lock_path = home.rootfs_lock("warm-shared-lock-hash");
        let _existing_reader = lock::acquire_shared(rootfs_lock_path.clone())
            .await
            .unwrap();

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            upload_existing_rootfs_for_warm_if_present(&input, rootfs_lock_path),
        )
        .await
        .expect("warm upload should share the rootfs lock with active runners");

        let err = result.unwrap_err();
        assert!(err.to_string().contains("--warm-rootfs-cache requires R2"));
    }

    #[tokio::test]
    async fn best_effort_existing_rootfs_allows_missing_r2_cache() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "best-effort-local-hash");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
        tokio::fs::write(rootfs.rootfs(), b"local-rootfs")
            .await
            .unwrap();
        let guest = dir.path().join("guest");
        let input = rootfs_input(&home, &rootfs, &guest, RootfsCachePolicy::BestEffort, None);

        ensure_rootfs_under_lock(input).await.unwrap();

        assert!(rootfs.rootfs().exists());
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

    /// Staging contract: the in-progress `rootfs.ext4.staging` must not
    /// cause `is_rootfs_present` to report the rootfs as built. If it did,
    /// a crashed build partway through CA injection would still Fast-path
    /// on the next run — reintroducing #11007.
    #[tokio::test]
    async fn is_rootfs_present_ignores_staging_file() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "staging-hash");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        // Staging alone → not present.
        tokio::fs::write(rootfs.rootfs_staging(), b"partial")
            .await
            .unwrap();
        assert!(!is_rootfs_present(&rootfs).await.unwrap());

        // Committed file → present, even with lingering staging.
        tokio::fs::write(rootfs.rootfs(), b"committed")
            .await
            .unwrap();
        assert!(is_rootfs_present(&rootfs).await.unwrap());
    }

    #[tokio::test]
    async fn clear_rootfs_staging_removes_residue() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "cleanup-hash");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        tokio::fs::write(rootfs.rootfs_staging(), b"crash-residue")
            .await
            .unwrap();
        assert!(rootfs.rootfs_staging().exists());

        clear_rootfs_staging(&rootfs).await;
        assert!(!rootfs.rootfs_staging().exists());
    }

    #[tokio::test]
    async fn clear_rootfs_staging_noop_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "noop-hash");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        // No staging file — must not error.
        clear_rootfs_staging(&rootfs).await;
        assert!(!rootfs.rootfs_staging().exists());
    }

    #[tokio::test]
    async fn clear_rootfs_staging_leaves_committed_rootfs_alone() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "preserve-hash");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        tokio::fs::write(rootfs.rootfs(), b"real-rootfs")
            .await
            .unwrap();
        tokio::fs::write(rootfs.rootfs_staging(), b"residue")
            .await
            .unwrap();

        clear_rootfs_staging(&rootfs).await;
        assert!(rootfs.rootfs().exists(), "committed rootfs must survive");
        assert!(!rootfs.rootfs_staging().exists());
    }

    #[tokio::test]
    async fn demote_to_staging_moves_committed_file() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "demote-hash");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        tokio::fs::write(rootfs.rootfs(), b"downloaded")
            .await
            .unwrap();

        demote_to_staging(&rootfs).await.unwrap();

        assert!(
            !rootfs.rootfs().exists(),
            "rootfs.ext4 must not exist after demotion (otherwise Fast path \
             would reuse an un-CA-injected image — see #11007)"
        );
        assert!(rootfs.rootfs_staging().exists());
        let content = tokio::fs::read(rootfs.rootfs_staging()).await.unwrap();
        assert_eq!(content, b"downloaded");
    }

    #[tokio::test]
    async fn commit_staging_renames_to_final() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "commit-hash");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        tokio::fs::write(rootfs.rootfs_staging(), b"ca-injected")
            .await
            .unwrap();

        commit_staging(&rootfs).await.unwrap();

        assert!(!rootfs.rootfs_staging().exists());
        assert!(rootfs.rootfs().exists());
        let content = tokio::fs::read(rootfs.rootfs()).await.unwrap();
        assert_eq!(content, b"ca-injected");
    }

    /// End-to-end contract simulation for the R2 + CA-injection path:
    /// download writes `rootfs.ext4`, we demote to staging, CA injection
    /// succeeds (modeled as a no-op mutation of the staging file), we
    /// commit via rename. After success, only `rootfs.ext4` exists.
    #[tokio::test]
    async fn staging_contract_happy_path() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "happy-hash");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        // Simulate R2 download.
        tokio::fs::write(rootfs.rootfs(), b"r2-download")
            .await
            .unwrap();

        // Demote → inject-ca (mutate staging) → commit.
        demote_to_staging(&rootfs).await.unwrap();
        tokio::fs::write(rootfs.rootfs_staging(), b"ca-injected")
            .await
            .unwrap();
        commit_staging(&rootfs).await.unwrap();

        assert!(rootfs.rootfs().exists());
        assert!(!rootfs.rootfs_staging().exists());
        assert!(is_rootfs_present(&rootfs).await.unwrap());
    }

    /// Failure simulation: demote succeeded, CA injection failed, build
    /// returned Err. The next build must see no committed rootfs (so it
    /// redownloads) and `clear_rootfs_staging` must wipe the partial file.
    #[tokio::test]
    async fn staging_contract_inject_failure_leaves_recoverable_state() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::paths::HomePaths::with_root(dir.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "fail-hash");
        tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

        tokio::fs::write(rootfs.rootfs(), b"r2-download")
            .await
            .unwrap();
        demote_to_staging(&rootfs).await.unwrap();
        // Pretend inject-ca failed: staging persists, rootfs.ext4 absent.

        assert!(!is_rootfs_present(&rootfs).await.unwrap());
        assert!(rootfs.rootfs_staging().exists());

        // Next build's cleanup step.
        clear_rootfs_staging(&rootfs).await;
        assert!(!rootfs.rootfs_staging().exists());
        assert!(!is_rootfs_present(&rootfs).await.unwrap());
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

        // Create a stale directory that should also be removed
        let stale_dir = rootfs.dir().join("stale-dir");
        tokio::fs::create_dir_all(&stale_dir).await.unwrap();
        tokio::fs::write(stale_dir.join("old.bin"), b"old")
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
        assert!(!stale_dir.exists(), "stale directory must be removed");
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
