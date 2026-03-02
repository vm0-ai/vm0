use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::deps::{
    FIRECRACKER_SHA256_AARCH64, FIRECRACKER_SHA256_X86_64, FIRECRACKER_VERSION,
    KERNEL_SHA256_AARCH64, KERNEL_SHA256_X86_64, KERNEL_VERSION, MITMDUMP_SHA256_AARCH64,
    MITMDUMP_SHA256_X86_64, MITMDUMP_TAR_ENTRY, MITMPROXY_VERSION, firecracker_tar_entry,
    firecracker_url, kernel_url, mitmdump_url,
};
use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;

pub async fn run_setup() -> RunnerResult<()> {
    let arch = check_architecture()?;
    let missing_required = check_system_dependencies();

    let paths = HomePaths::new()?;
    create_directories(&paths).await?;
    download_firecracker(&paths, arch).await?;
    download_kernel(&paths, arch).await?;
    download_mitmdump(&paths, arch).await?;
    check_kvm();

    if !missing_required.is_empty() {
        return Err(RunnerError::Config(format!(
            "missing required dependencies: {}",
            missing_required.join(", ")
        )));
    }

    tracing::info!("setup complete");
    Ok(())
}

fn check_architecture() -> RunnerResult<&'static str> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        other => {
            return Err(RunnerError::Config(format!(
                "unsupported architecture: {other}"
            )));
        }
    };
    tracing::info!("[OK] architecture: {arch}");
    Ok(arch)
}

/// Returns names of missing required dependencies.
fn check_system_dependencies() -> Vec<&'static str> {
    // Required by `runner start` (sandbox networking)
    let required = ["ip", "iptables", "iptables-save", "sysctl"];
    // Only needed by specific commands (rootfs, build, etc.)
    let optional = ["pgrep", "mkfs.ext4", "mksquashfs", "docker"];

    let missing_required: Vec<&str> = required
        .iter()
        .filter(|dep| which::which(dep).is_err())
        .copied()
        .collect();
    let missing_optional: Vec<&str> = optional
        .iter()
        .filter(|dep| which::which(dep).is_err())
        .copied()
        .collect();

    if missing_required.is_empty() {
        tracing::info!("[OK] all required system dependencies found");
    } else {
        tracing::warn!(
            "missing required dependencies (needed by `runner start`): {}",
            missing_required.join(", ")
        );
    }

    if !missing_optional.is_empty() {
        tracing::warn!(
            "missing optional dependencies (needed by other commands): {}",
            missing_optional.join(", ")
        );
    }

    missing_required
}

async fn create_directories(paths: &HomePaths) -> RunnerResult<()> {
    let dirs = [
        paths.bin_dir(),
        paths.firecracker_dir(FIRECRACKER_VERSION),
        paths.mitmproxy_dir(MITMPROXY_VERSION),
        paths.runners_dir(),
    ];
    for dir in &dirs {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| RunnerError::Internal(format!("create {}: {e}", dir.display())))?;
    }
    tracing::info!("[OK] directory structure created");
    Ok(())
}

// ---------------------------------------------------------------------------
// Shared download helpers
// ---------------------------------------------------------------------------

/// Stream an HTTP response to a file, computing SHA256 incrementally.
/// Returns the hex-encoded digest.
async fn stream_to_file(mut response: reqeast::Response, path: &Path) -> RunnerResult<String> {
    let mut file = tokio::fs::File::create(path)
        .await
        .map_err(|e| RunnerError::Internal(format!("create {}: {e}", path.display())))?;
    let mut hasher = Sha256::new();

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| RunnerError::Internal(format!("read response chunk: {e}")))?
    {
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| RunnerError::Internal(format!("write {}: {e}", path.display())))?;
    }

    file.flush()
        .await
        .map_err(|e| RunnerError::Internal(format!("flush {}: {e}", path.display())))?;

    Ok(format!("{:x}", hasher.finalize()))
}

/// Download a URL to a temp file. Cleans up on failure. Returns hex SHA256.
async fn download_to_temp(url: &str, tmp_path: &Path, label: &str) -> RunnerResult<String> {
    let response = reqeast::get(url)
        .await
        .map_err(|e| RunnerError::Internal(format!("download {label}: {e}")))?;

    if !response.status().is_success() {
        return Err(RunnerError::Internal(format!(
            "download {label}: HTTP {}",
            response.status()
        )));
    }

    match stream_to_file(response, tmp_path).await {
        Ok(sha) => Ok(sha),
        Err(e) => {
            let _ = tokio::fs::remove_file(tmp_path).await;
            Err(e)
        }
    }
}

/// Download a tarball, extract a named entry. Cleans up tarball after extraction.
/// Returns hex SHA256 of the extracted entry. Cleans up tmp_path on failure.
async fn download_and_extract(
    url: &str,
    label: &str,
    entry_name: &str,
    tarball_path: &Path,
    tmp_path: &Path,
) -> RunnerResult<String> {
    // Tarball SHA is intentionally discarded — we verify the extracted binary's SHA instead.
    download_to_temp(url, tarball_path, label).await?;

    let result = extract_tar_entry(tarball_path, tmp_path, entry_name).await;
    let _ = tokio::fs::remove_file(tarball_path).await;
    match result {
        Ok(sha) => Ok(sha),
        Err(e) => {
            let _ = tokio::fs::remove_file(tmp_path).await;
            Err(e)
        }
    }
}

/// Extract a named entry from a gzipped tarball, writing to tmp_path.
/// Matches by file_name (last path component). Returns the SHA256 hex digest.
async fn extract_tar_entry(
    tarball_path: &Path,
    tmp_path: &Path,
    entry_name: &str,
) -> RunnerResult<String> {
    let tarball = tarball_path.to_owned();
    let tmp = tmp_path.to_owned();
    let entry_name = entry_name.to_owned();

    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&tarball)
            .map_err(|e| RunnerError::Internal(format!("open tarball: {e}")))?;
        let decoder = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);

        let entries = archive
            .entries()
            .map_err(|e| RunnerError::Internal(format!("read tarball entries: {e}")))?;

        for entry in entries {
            let mut entry =
                entry.map_err(|e| RunnerError::Internal(format!("read tarball entry: {e}")))?;

            let path = entry
                .path()
                .map_err(|e| RunnerError::Internal(format!("read entry path: {e}")))?;

            let file_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();

            if file_name == entry_name {
                let mut out = std::fs::File::create(&tmp)
                    .map_err(|e| RunnerError::Internal(format!("create temp binary: {e}")))?;
                let mut hasher = Sha256::new();
                let mut buf = [0u8; 64 * 1024];
                loop {
                    let n = entry
                        .read(&mut buf)
                        .map_err(|e| RunnerError::Internal(format!("read tar entry: {e}")))?;
                    if n == 0 {
                        break;
                    }
                    let chunk = buf.get(..n).ok_or_else(|| {
                        RunnerError::Internal("read returned invalid length".into())
                    })?;
                    hasher.update(chunk);
                    std::io::Write::write_all(&mut out, chunk)
                        .map_err(|e| RunnerError::Internal(format!("write binary: {e}")))?;
                }
                return Ok(format!("{:x}", hasher.finalize()));
            }
        }

        Err(RunnerError::Internal(format!(
            "'{entry_name}' not found in tarball"
        )))
    })
    .await
    .map_err(|e| RunnerError::Internal(format!("extract task failed: {e}")))?
}

/// Verify SHA256, set permissions, atomically rename to target.
/// If rename fails but target already exists, assumes another process installed it.
async fn verify_and_install(
    sha_hex: &str,
    expected_sha: &str,
    label: &str,
    tmp_path: &Path,
    target: &Path,
    mode: Option<u32>,
) -> RunnerResult<()> {
    if let Err(e) = verify_sha256(sha_hex, expected_sha, label) {
        let _ = tokio::fs::remove_file(tmp_path).await;
        return Err(e);
    }

    match atomic_rename(tmp_path, target, mode).await {
        Ok(()) => Ok(()),
        Err(e) => {
            if tokio::fs::try_exists(target).await.unwrap_or(false) {
                tracing::info!("[OK] {label} installed by another process");
                Ok(())
            } else {
                Err(e)
            }
        }
    }
}

/// Set permissions then atomically rename. Cleans up temp on failure.
async fn atomic_rename(tmp_path: &Path, target: &Path, mode: Option<u32>) -> RunnerResult<()> {
    let result = async {
        if let Some(mode) = mode {
            tokio::fs::set_permissions(tmp_path, std::fs::Permissions::from_mode(mode))
                .await
                .map_err(|e| RunnerError::Internal(format!("chmod {}: {e}", target.display())))?;
        }
        tokio::fs::rename(tmp_path, target)
            .await
            .map_err(|e| RunnerError::Internal(format!("rename to {}: {e}", target.display())))
    }
    .await;

    if result.is_err() {
        let _ = tokio::fs::remove_file(tmp_path).await;
    }
    result
}

#[allow(clippy::unreachable)] // arch validated by check_architecture
fn select_sha<'a>(arch: &str, x86_64: &'a str, aarch64: &'a str) -> &'a str {
    match arch {
        "x86_64" => x86_64,
        "aarch64" => aarch64,
        _ => unreachable!(),
    }
}

fn verify_sha256(actual_hex: &str, expected_hex: &str, label: &str) -> RunnerResult<()> {
    if actual_hex != expected_hex {
        return Err(RunnerError::Internal(format!(
            "{label} SHA256 mismatch: expected {expected_hex}, got {actual_hex}"
        )));
    }
    tracing::info!("[OK] {label} SHA256 verified");
    Ok(())
}

// ---------------------------------------------------------------------------
// Artifact downloads
// ---------------------------------------------------------------------------

/// Compute SHA256 of an existing file. Returns hex digest.
async fn file_sha256(path: &Path) -> RunnerResult<String> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut file = std::fs::File::open(&path)
            .map_err(|e| RunnerError::Internal(format!("open {}: {e}", path.display())))?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = file
                .read(&mut buf)
                .map_err(|e| RunnerError::Internal(format!("read {}: {e}", path.display())))?;
            if n == 0 {
                break;
            }
            let chunk = buf
                .get(..n)
                .ok_or_else(|| RunnerError::Internal("read returned invalid length".into()))?;
            hasher.update(chunk);
        }
        Ok(format!("{:x}", hasher.finalize()))
    })
    .await
    .map_err(|e| RunnerError::Internal(format!("sha256 task failed: {e}")))?
}

/// Check if an artifact is already installed with the expected SHA256.
async fn is_already_installed(path: &Path, expected_sha: &str) -> bool {
    if !tokio::fs::try_exists(path).await.unwrap_or(false) {
        return false;
    }
    let Ok(sha) = file_sha256(path).await else {
        return false;
    };
    sha == expected_sha
}

async fn download_firecracker(paths: &HomePaths, arch: &str) -> RunnerResult<()> {
    let bin_path = paths.firecracker_bin(FIRECRACKER_VERSION);
    let expected_sha = select_sha(arch, FIRECRACKER_SHA256_X86_64, FIRECRACKER_SHA256_AARCH64);

    if is_already_installed(&bin_path, expected_sha).await {
        tracing::info!(
            "[OK] firecracker {FIRECRACKER_VERSION} already installed, skipping download"
        );
        return Ok(());
    }

    let url = firecracker_url(arch);
    tracing::info!("downloading firecracker from {url}");

    let tarball_path = bin_path.with_extension(format!("tgz.{}", std::process::id()));
    let tmp_path = bin_path.with_extension(format!("tmp.{}", std::process::id()));
    let fc_entry = firecracker_tar_entry(arch);
    let sha_hex =
        download_and_extract(&url, "firecracker", &fc_entry, &tarball_path, &tmp_path).await?;

    verify_and_install(
        &sha_hex,
        expected_sha,
        "firecracker",
        &tmp_path,
        &bin_path,
        Some(0o755),
    )
    .await?;
    tracing::info!("[OK] firecracker {FIRECRACKER_VERSION} installed");
    Ok(())
}

async fn download_kernel(paths: &HomePaths, arch: &str) -> RunnerResult<()> {
    let kernel_path = paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION);
    let expected_sha = select_sha(arch, KERNEL_SHA256_X86_64, KERNEL_SHA256_AARCH64);

    if is_already_installed(&kernel_path, expected_sha).await {
        tracing::info!("[OK] kernel vmlinux-{KERNEL_VERSION} already installed, skipping download");
        return Ok(());
    }

    let url = kernel_url(arch);
    tracing::info!("downloading kernel from {url}");

    let tmp_path = kernel_path.with_extension(format!("tmp.{}", std::process::id()));
    let sha_hex = download_to_temp(&url, &tmp_path, "kernel").await?;

    verify_and_install(
        &sha_hex,
        expected_sha,
        "kernel",
        &tmp_path,
        &kernel_path,
        None,
    )
    .await?;
    tracing::info!("[OK] kernel vmlinux-{KERNEL_VERSION} installed");
    Ok(())
}

async fn download_mitmdump(paths: &HomePaths, arch: &str) -> RunnerResult<()> {
    let bin_path = paths.mitmdump_bin(MITMPROXY_VERSION);
    let expected_sha = select_sha(arch, MITMDUMP_SHA256_X86_64, MITMDUMP_SHA256_AARCH64);

    if is_already_installed(&bin_path, expected_sha).await {
        tracing::info!("[OK] mitmdump {MITMPROXY_VERSION} already installed, skipping download");
        return Ok(());
    }

    let url = mitmdump_url(arch);
    tracing::info!("downloading mitmdump from {url}");

    let tarball_path = bin_path.with_extension(format!("tgz.{}", std::process::id()));
    let tmp_path = bin_path.with_extension(format!("tmp.{}", std::process::id()));
    let sha_hex = download_and_extract(
        &url,
        "mitmdump",
        MITMDUMP_TAR_ENTRY,
        &tarball_path,
        &tmp_path,
    )
    .await?;

    verify_and_install(
        &sha_hex,
        expected_sha,
        "mitmdump",
        &tmp_path,
        &bin_path,
        Some(0o755),
    )
    .await?;
    tracing::info!("[OK] mitmdump {MITMPROXY_VERSION} installed");
    Ok(())
}

// ---------------------------------------------------------------------------
// Host checks
// ---------------------------------------------------------------------------

fn check_kvm() {
    use std::fs::File;

    match File::options().read(true).write(true).open("/dev/kvm") {
        Ok(_) => {
            tracing::info!("[OK] KVM accessible");
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::warn!("/dev/kvm not found — ensure bare-metal with KVM enabled");
        }
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            tracing::warn!("/dev/kvm not accessible — run: sudo chmod 666 /dev/kvm");
        }
        Err(e) => {
            tracing::warn!("/dev/kvm check failed: {e}");
        }
    }
}
