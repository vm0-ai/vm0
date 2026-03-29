use std::path::{Path, PathBuf};

use clap::Args;
use sha2::{Digest, Sha256};

use crate::ca;
use crate::error::{RunnerError, RunnerResult};
use crate::lock;
use crate::paths::{HomePaths, RootfsPaths, touch_mtime};
use crate::profile;

const BUILD_SCRIPT: &str = include_str!("../../scripts/build-rootfs.sh");
const VERIFY_SCRIPT: &str = include_str!("../../scripts/verify-rootfs.sh");

/// Bump this to invalidate all cached rootfs images without changing any input files.
const ROOTFS_CACHE_VERSION: u32 = 1;

#[cfg(bundled_guests)]
mod embedded {
    pub const GUEST_INIT: &[u8] = include_bytes!(env!("BUNDLED_GUEST_INIT"));
    pub const GUEST_DOWNLOAD: &[u8] = include_bytes!(env!("BUNDLED_GUEST_DOWNLOAD"));
    pub const GUEST_AGENT: &[u8] = include_bytes!(env!("BUNDLED_GUEST_AGENT"));
    pub const GUEST_MOCK_CLAUDE: &[u8] = include_bytes!(env!("BUNDLED_GUEST_MOCK_CLAUDE"));
}

#[cfg(bundled_guests)]
fn bundled_guest(name: &str) -> Option<&'static [u8]> {
    match name {
        "guest-agent" => Some(embedded::GUEST_AGENT),
        "guest-download" => Some(embedded::GUEST_DOWNLOAD),
        "guest-init" => Some(embedded::GUEST_INIT),
        "guest-mock-claude" => Some(embedded::GUEST_MOCK_CLAUDE),
        _ => None,
    }
}

#[cfg(not(bundled_guests))]
fn bundled_guest(_name: &str) -> Option<&'static [u8]> {
    None
}

#[derive(Args)]
pub struct RootfsArgs {
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
    /// Profile to build (determines Dockerfile)
    #[arg(long)]
    pub profile: String,
    /// Compute and print the input hash without building
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

/// Build rootfs and return the content hash of the inputs.
pub async fn run_rootfs(args: RootfsArgs) -> RunnerResult<String> {
    let def = profile::get(&args.profile)?;
    let dockerfile = def.dockerfile;
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

    // Sorted by dest name for deterministic hashing.
    let bins: [(&Path, &str); 4] = [
        (guest_agent.as_path(), "/usr/local/bin/guest-agent"),
        (guest_download.as_path(), "/usr/local/bin/guest-download"),
        (guest_init.as_path(), "/sbin/guest-init"),
        (
            guest_mock_claude.as_path(),
            "/usr/local/bin/guest-mock-claude",
        ),
    ];

    // Compute input hash: script + dockerfile + guest binaries.
    // The build script content is included so any logic change invalidates cache.
    let hash = compute_input_hash(dockerfile, &bins).await?;
    tracing::info!("rootfs input hash: {hash}");
    // Machine-readable output — do not change format without updating consumers
    println!("rootfs_hash={hash}");

    if dry_run {
        return Ok(hash);
    }

    let paths = HomePaths::new()?;

    // Ensure CA exists — rootfs build embeds the CA cert into the image.
    ca::ensure(&paths).await?;

    let rootfs_paths = RootfsPaths::new(&paths, &hash);
    let output_dir = rootfs_paths.dir();

    if is_build_complete(&rootfs_paths).await? {
        tracing::info!("[OK] rootfs already built: {}", output_dir.display());
        tracing::info!("rootfs hash: {hash}");
        touch_mtime(output_dir);
        return Ok(hash);
    }

    // Acquire exclusive lock to prevent concurrent builds with the same hash.
    let _lock = lock::acquire(paths.rootfs_lock(&hash)).await?;

    // Re-check after acquiring lock — another process may have completed the build.
    if is_build_complete(&rootfs_paths).await? {
        tracing::info!("[OK] rootfs already built: {}", output_dir.display());
        tracing::info!("rootfs hash: {hash}");
        touch_mtime(output_dir);
        return Ok(hash);
    }

    // Create output directory
    tokio::fs::create_dir_all(&output_dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create {}: {e}", output_dir.display())))?;

    // Write scripts and Dockerfile to a temp directory
    let work_dir =
        tempfile::tempdir().map_err(|e| RunnerError::Internal(format!("create temp dir: {e}")))?;
    tokio::fs::write(work_dir.path().join("build-rootfs.sh"), BUILD_SCRIPT)
        .await
        .map_err(|e| RunnerError::Internal(format!("write build script: {e}")))?;
    tokio::fs::write(work_dir.path().join("verify-rootfs.sh"), VERIFY_SCRIPT)
        .await
        .map_err(|e| RunnerError::Internal(format!("write verify script: {e}")))?;
    tokio::fs::write(work_dir.path().join("Dockerfile"), dockerfile)
        .await
        .map_err(|e| RunnerError::Internal(format!("write Dockerfile: {e}")))?;

    // Run build script with stdout/stderr inherited (visible to the user)
    let script_path = work_dir.path().join("build-rootfs.sh");
    let output_dir_str = output_dir.to_string_lossy();
    let work_dir_str = work_dir.path().to_string_lossy();
    let guest_agent_str = guest_agent.to_string_lossy();
    let guest_download_str = guest_download.to_string_lossy();
    let guest_init_str = guest_init.to_string_lossy();
    let guest_mock_claude_str = guest_mock_claude.to_string_lossy();
    let ca_dir_str = paths.ca_dir().to_string_lossy().to_string();

    let status = tokio::process::Command::new("bash")
        .arg(&script_path)
        .args([
            "--output-dir",
            &output_dir_str,
            "--work-dir",
            &work_dir_str,
            "--ca-dir",
            &ca_dir_str,
            "--guest-agent",
            &guest_agent_str,
            "--guest-download",
            &guest_download_str,
            "--guest-init",
            &guest_init_str,
            "--guest-mock-claude",
            &guest_mock_claude_str,
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

    // Verify rootfs contents (verify script is NOT part of the input hash)
    let rootfs_path = rootfs_paths.rootfs();
    let verify_path = work_dir.path().join("verify-rootfs.sh");
    let rootfs_str = rootfs_path.to_string_lossy();

    let status = tokio::process::Command::new("bash")
        .arg(&verify_path)
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

    tracing::info!("[OK] rootfs ready: {}", output_dir.display());
    tracing::info!("rootfs hash: {hash}");
    Ok(hash)
}

/// Check whether all expected build outputs exist in the directory.
async fn is_build_complete(rootfs: &RootfsPaths) -> RunnerResult<bool> {
    for path in rootfs.expected_files() {
        let exists = tokio::fs::try_exists(&path)
            .await
            .map_err(|e| RunnerError::Internal(format!("check {}: {e}", path.display())))?;
        if !exists {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Hash all deterministic inputs: build script, Dockerfile, and guest binaries.
async fn compute_input_hash(
    dockerfile: &str,
    guest_bins: &[(&Path, &str)],
) -> RunnerResult<String> {
    let mut hasher = Sha256::new();

    // Cache version seed — bump ROOTFS_CACHE_VERSION to force invalidation.
    hasher.update(b"version:");
    hasher.update(ROOTFS_CACHE_VERSION.to_le_bytes());

    // Hash build script content (includes resolv.conf, constants, all logic)
    hasher.update(b"script:");
    hasher.update(BUILD_SCRIPT.as_bytes());

    // Hash Dockerfile content
    hasher.update(b"dockerfile:");
    hasher.update(dockerfile.as_bytes());

    // Hash guest binaries (already sorted by name via guest_bins())
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
