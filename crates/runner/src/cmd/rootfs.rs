use std::path::{Path, PathBuf};

use clap::Args;
use sha2::{Digest, Sha256};

use crate::error::{RunnerError, RunnerResult};
use crate::paths::{HomePaths, LockPaths, RootfsPaths};

const BUILD_SCRIPT: &str = include_str!("../../scripts/build-rootfs.sh");
const VERIFY_SCRIPT: &str = include_str!("../../scripts/verify-rootfs.sh");
const EMBEDDED_DOCKERFILE: &str = include_str!("../../scripts/rootfs.Dockerfile");

#[derive(Args)]
pub struct RootfsArgs {
    #[arg(long)]
    guest_init: PathBuf,
    #[arg(long)]
    guest_download: PathBuf,
    #[arg(long)]
    guest_agent: PathBuf,
    #[arg(long)]
    guest_mock_claude: PathBuf,
}

impl RootfsArgs {
    /// Returns (source_path, rootfs_dest) pairs sorted by name for deterministic hashing.
    fn guest_bins(&self) -> [(&Path, &str); 4] {
        [
            (self.guest_agent.as_path(), "/usr/local/bin/guest-agent"),
            (
                self.guest_download.as_path(),
                "/usr/local/bin/guest-download",
            ),
            (self.guest_init.as_path(), "/sbin/guest-init"),
            (
                self.guest_mock_claude.as_path(),
                "/usr/local/bin/guest-mock-claude",
            ),
        ]
    }
}

/// Build rootfs and return the content hash of the inputs.
pub async fn run_rootfs(args: RootfsArgs) -> RunnerResult<String> {
    let guest_bins = args.guest_bins();
    let paths = HomePaths::new()?;

    // Compute input hash: script + dockerfile + guest binaries.
    // The build script content is included so any logic change invalidates cache.
    let hash = compute_input_hash(&guest_bins).await?;
    tracing::info!("rootfs input hash: {hash}");

    let rootfs_paths = RootfsPaths::new(&paths, &hash);
    let output_dir = rootfs_paths.dir();

    if is_build_complete(&rootfs_paths).await? {
        tracing::info!("[OK] rootfs already built: {}", output_dir.display());
        tracing::info!("rootfs hash: {hash}");
        return Ok(hash);
    }

    // Acquire exclusive lock to prevent concurrent builds with the same hash.
    let locks = LockPaths::new();
    let _lock = crate::lock::acquire(locks.rootfs(&hash)).await?;

    // Re-check after acquiring lock — another process may have completed the build.
    if is_build_complete(&rootfs_paths).await? {
        tracing::info!("[OK] rootfs already built: {}", output_dir.display());
        tracing::info!("rootfs hash: {hash}");
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
    tokio::fs::write(work_dir.path().join("Dockerfile"), EMBEDDED_DOCKERFILE)
        .await
        .map_err(|e| RunnerError::Internal(format!("write Dockerfile: {e}")))?;

    // Run build script with stdout/stderr inherited (visible to the user)
    let script_path = work_dir.path().join("build-rootfs.sh");
    let output_dir_str = output_dir.to_string_lossy();
    let work_dir_str = work_dir.path().to_string_lossy();
    let guest_init_str = args.guest_init.to_string_lossy();
    let guest_download_str = args.guest_download.to_string_lossy();
    let guest_agent_str = args.guest_agent.to_string_lossy();
    let guest_mock_claude_str = args.guest_mock_claude.to_string_lossy();

    let status = tokio::process::Command::new("bash")
        .arg(&script_path)
        .args([
            "--output-dir",
            &output_dir_str,
            "--work-dir",
            &work_dir_str,
            "--guest-init",
            &guest_init_str,
            "--guest-download",
            &guest_download_str,
            "--guest-agent",
            &guest_agent_str,
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
async fn compute_input_hash(guest_bins: &[(&Path, &str)]) -> RunnerResult<String> {
    let mut hasher = Sha256::new();

    // Hash build script content (includes resolv.conf, constants, all logic)
    hasher.update(b"script:");
    hasher.update(BUILD_SCRIPT.as_bytes());

    // Hash Dockerfile content
    hasher.update(b"dockerfile:");
    hasher.update(EMBEDDED_DOCKERFILE.as_bytes());

    // Hash guest binaries (already sorted by name via guest_bins())
    for (src, dest) in guest_bins {
        let content = tokio::fs::read(src)
            .await
            .map_err(|e| RunnerError::Internal(format!("read {}: {e}", src.display())))?;
        let tag = format!("bin:{dest}:");
        hasher.update(tag.as_bytes());
        hasher.update(&content);
    }

    Ok(format!("{:x}", hasher.finalize()))
}
