use std::path::{Path, PathBuf};

use clap::Args;
use sha2::{Digest, Sha256};

use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;

const BUILD_SCRIPT: &str = include_str!("../build-rootfs.sh");
const EMBEDDED_DOCKERFILE: &str = include_str!("../rootfs.Dockerfile");

const ROOTFS_FILE: &str = "rootfs.squashfs";
const CA_CERT_FILE: &str = "mitmproxy-ca-cert.pem";
const CA_KEY_FILE: &str = "mitmproxy-ca-key.pem";
const CA_COMBINED_FILE: &str = "mitmproxy-ca.pem";

#[derive(Args)]
pub struct BuildRootfsArgs {
    #[arg(long)]
    guest_init: PathBuf,
    #[arg(long)]
    guest_download: PathBuf,
    #[arg(long)]
    guest_agent: PathBuf,
    #[arg(long)]
    guest_mock_claude: PathBuf,
}

impl BuildRootfsArgs {
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

pub async fn run_build_rootfs(args: BuildRootfsArgs) -> RunnerResult<()> {
    let guest_bins = args.guest_bins();
    let paths = HomePaths::new()?;

    // Compute input hash: script + dockerfile + guest binaries.
    // The build script content is included so any logic change invalidates cache.
    let hash = compute_input_hash(&guest_bins).await?;
    tracing::info!("rootfs input hash: {hash}");

    let output_dir = paths.rootfs_dir().join(&hash);

    if is_build_complete(&output_dir).await? {
        tracing::info!("[OK] rootfs already built: {}", output_dir.display());
        return Ok(());
    }

    // Create output directory
    tokio::fs::create_dir_all(&output_dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create {}: {e}", output_dir.display())))?;

    // Write build script and Dockerfile to a temp directory
    let work_dir =
        tempfile::tempdir().map_err(|e| RunnerError::Internal(format!("create temp dir: {e}")))?;
    tokio::fs::write(work_dir.path().join("build-rootfs.sh"), BUILD_SCRIPT)
        .await
        .map_err(|e| RunnerError::Internal(format!("write build script: {e}")))?;
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

    // Verify output file exists
    let rootfs_path = output_dir.join(ROOTFS_FILE);
    let exists = tokio::fs::try_exists(&rootfs_path)
        .await
        .map_err(|e| RunnerError::Internal(format!("check {}: {e}", rootfs_path.display())))?;
    if !exists {
        return Err(RunnerError::Internal(
            "build script succeeded but rootfs.squashfs not found".into(),
        ));
    }

    tracing::info!("[OK] rootfs ready: {}", output_dir.display());
    Ok(())
}

/// Check whether all expected build outputs exist in the directory.
async fn is_build_complete(dir: &Path) -> RunnerResult<bool> {
    let files = [ROOTFS_FILE, CA_CERT_FILE, CA_KEY_FILE, CA_COMBINED_FILE];
    for name in files {
        let path = dir.join(name);
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
