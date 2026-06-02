//! Prepare a host to run vm0 sandboxes.
//!
//! The setup command validates host prerequisites, creates the runner home
//! layout, and installs the pinned Firecracker, kernel, and mitmdump artifacts
//! used by sandbox startup.

use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::deps::{
    FIRECRACKER_SHA256_AARCH64, FIRECRACKER_SHA256_X86_64, FIRECRACKER_VERSION,
    KERNEL_SHA256_AARCH64, KERNEL_SHA256_X86_64, KERNEL_VERSION, MITMDUMP_SHA256_AARCH64,
    MITMDUMP_SHA256_X86_64, MITMDUMP_TAR_ENTRY, MITMPROXY_VERSION, SYSTEM_CA_BUNDLE,
    firecracker_tar_entry, firecracker_url, kernel_url, mitmdump_url,
};
use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;

/// Run the host setup workflow for sandbox execution.
///
/// Returns `RunnerError::Config` when the host configuration is unsupported or
/// missing required prerequisites, and `RunnerError::Internal` when filesystem,
/// download, extraction, checksum, or install operations fail. KVM access
/// problems are reported as warnings so setup can still prepare shared files.
pub async fn run_setup() -> RunnerResult<()> {
    let arch = check_architecture()?;
    let missing_required = check_system_dependencies();

    let paths = HomePaths::new()?;
    create_directories(&paths).await?;
    download_firecracker(&paths, arch).await?;
    download_kernel(&paths, arch).await?;
    download_mitmdump(&paths, arch).await?;
    check_system_ca_bundle()?;
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
    // Required by `runner start` (sandbox networking and workspace images).
    let required = [
        "ip",
        "iptables",
        "iptables-save",
        "sysctl",
        "dnsmasq",
        "mkfs.ext4",
    ];
    // Only needed by specific commands (rootfs, build, etc.)
    let optional = ["pgrep", "debootstrap", "flock", "openssl"];

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
async fn stream_to_file(mut response: reqwest::Response, path: &Path) -> RunnerResult<String> {
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

    Ok(hex::encode(hasher.finalize()))
}

/// Download a URL to a temp file. Cleans up on failure. Returns hex SHA256.
async fn download_to_temp(url: &str, tmp_path: &Path, label: &str) -> RunnerResult<String> {
    let response = reqwest::get(url)
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
                return Ok(hex::encode(hasher.finalize()));
            }
        }

        Err(RunnerError::Internal(format!(
            "'{entry_name}' not found in tarball"
        )))
    })
    .await
    .map_err(|e| RunnerError::Internal(format!("extract task failed: {e}")))?
}

/// Verify SHA256, set permissions, and atomically rename to target.
/// A failed rename only counts as a concurrent install if the target verifies.
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
        Err(e) => match ensure_artifact_installed(target, expected_sha, mode).await {
            Ok(true) => {
                tracing::info!("[OK] {label} verified after another install attempt");
                Ok(())
            }
            Ok(false) => Err(e),
            Err(validate_err) => Err(RunnerError::Internal(format!(
                "{e}; failed to validate existing {}: {validate_err}",
                target.display()
            ))),
        },
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
        Ok(hex::encode(hasher.finalize()))
    })
    .await
    .map_err(|e| RunnerError::Internal(format!("sha256 task failed: {e}")))?
}

/// Ensure an existing setup artifact matches its pinned SHA and usable mode.
async fn ensure_artifact_installed(
    path: &Path,
    expected_sha: &str,
    mode: Option<u32>,
) -> RunnerResult<bool> {
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "stat {}: {e}",
                path.display()
            )));
        }
    };

    if !metadata.is_file() {
        return Ok(false);
    }

    if file_sha256(path).await? != expected_sha {
        return Ok(false);
    }

    let Some(mode) = mode else {
        return Ok(true);
    };

    if (metadata.permissions().mode() & 0o7777) == mode {
        return Ok(true);
    }

    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .await
        .map_err(|e| RunnerError::Internal(format!("chmod {}: {e}", path.display())))?;

    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|e| RunnerError::Internal(format!("stat {}: {e}", path.display())))?;

    if !metadata.is_file() || (metadata.permissions().mode() & 0o7777) != mode {
        return Ok(false);
    }

    Ok(file_sha256(path).await? == expected_sha)
}

async fn download_firecracker(paths: &HomePaths, arch: &str) -> RunnerResult<()> {
    let bin_path = paths.firecracker_bin(FIRECRACKER_VERSION);
    let expected_sha = select_sha(arch, FIRECRACKER_SHA256_X86_64, FIRECRACKER_SHA256_AARCH64);

    if ensure_artifact_installed(&bin_path, expected_sha, Some(0o755)).await? {
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

    if ensure_artifact_installed(&kernel_path, expected_sha, None).await? {
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

    if ensure_artifact_installed(&bin_path, expected_sha, Some(0o755)).await? {
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

fn check_system_ca_bundle() -> RunnerResult<()> {
    if Path::new(SYSTEM_CA_BUNDLE).exists() {
        tracing::info!("[OK] system CA bundle found at {SYSTEM_CA_BUNDLE}");
        Ok(())
    } else {
        Err(RunnerError::Config(format!(
            "system CA bundle not found at {SYSTEM_CA_BUNDLE} — \
             install ca-certificates: sudo apt install ca-certificates"
        )))
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_architecture_returns_current() {
        let arch = check_architecture().unwrap();
        assert!(
            arch == "x86_64" || arch == "aarch64",
            "unexpected arch: {arch}"
        );
        assert_eq!(arch, std::env::consts::ARCH);
    }

    #[test]
    fn select_sha_x86_64() {
        assert_eq!(select_sha("x86_64", "sha_x86", "sha_arm"), "sha_x86");
    }

    #[test]
    fn select_sha_aarch64() {
        assert_eq!(select_sha("aarch64", "sha_x86", "sha_arm"), "sha_arm");
    }

    #[test]
    fn verify_sha256_matching() {
        let result = verify_sha256("abc123", "abc123", "test");
        assert!(result.is_ok());
    }

    #[test]
    fn verify_sha256_mismatch() {
        let result = verify_sha256("abc123", "def456", "test");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("SHA256 mismatch"), "got: {err}");
        assert!(err.contains("abc123"));
        assert!(err.contains("def456"));
    }

    #[test]
    fn check_system_dependencies_only_returns_known_deps() {
        let missing = check_system_dependencies();
        let known = [
            "ip",
            "iptables",
            "iptables-save",
            "sysctl",
            "dnsmasq",
            "mkfs.ext4",
        ];
        for dep in &missing {
            assert!(
                known.contains(dep),
                "unexpected dependency reported as missing: {dep}"
            );
        }
    }

    #[tokio::test]
    async fn file_sha256_computes_correctly() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.bin");
        std::fs::write(&path, b"hello world").unwrap();
        let sha = file_sha256(&path).await.unwrap();
        // SHA256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
        assert_eq!(
            sha,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[tokio::test]
    async fn file_sha256_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.bin");
        std::fs::write(&path, b"").unwrap();
        let sha = file_sha256(&path).await.unwrap();
        // SHA256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        assert_eq!(
            sha,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[tokio::test]
    async fn ensure_artifact_installed_returns_false_for_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nonexistent");
        assert!(
            !ensure_artifact_installed(&path, "anything", None)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn ensure_artifact_installed_returns_false_for_wrong_sha() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::write(&path, b"content").unwrap();
        assert!(
            !ensure_artifact_installed(&path, "wrong_sha", None)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn ensure_artifact_installed_returns_true_for_matching_sha_without_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::write(&path, b"content").unwrap();
        let sha = file_sha256(&path).await.unwrap();
        assert!(ensure_artifact_installed(&path, &sha, None).await.unwrap());
    }

    #[tokio::test]
    async fn ensure_artifact_installed_returns_true_for_matching_sha_and_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::write(&path, b"content").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let sha = file_sha256(&path).await.unwrap();

        assert!(
            ensure_artifact_installed(&path, &sha, Some(0o755))
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn ensure_artifact_installed_repairs_matching_file_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::write(&path, b"content").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let sha = file_sha256(&path).await.unwrap();

        assert!(
            ensure_artifact_installed(&path, &sha, Some(0o755))
                .await
                .unwrap()
        );
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
    }

    #[tokio::test]
    async fn ensure_artifact_installed_returns_false_for_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::create_dir(&path).unwrap();

        assert!(
            !ensure_artifact_installed(&path, "anything", Some(0o755))
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn verify_and_install_errors_when_rename_fails_with_invalid_target() {
        let dir = tempfile::tempdir().unwrap();
        let tmp_path = dir.path().join("tmp.bin");
        let target = dir.path().join("target.bin");
        std::fs::write(&tmp_path, b"content").unwrap();
        std::fs::create_dir(&target).unwrap();
        let sha = file_sha256(&tmp_path).await.unwrap();

        let result = verify_and_install(&sha, &sha, "test", &tmp_path, &target, None).await;

        assert!(result.is_err());
        assert!(target.is_dir());
        assert!(!tmp_path.exists(), "failed install should clean temp file");
    }

    #[tokio::test]
    async fn verify_and_install_replaces_wrong_sha_regular_target() {
        let dir = tempfile::tempdir().unwrap();
        let tmp_path = dir.path().join("tmp.bin");
        let target = dir.path().join("target.bin");
        std::fs::write(&tmp_path, b"new content").unwrap();
        std::fs::write(&target, b"old content").unwrap();
        let sha = file_sha256(&tmp_path).await.unwrap();

        verify_and_install(&sha, &sha, "test", &tmp_path, &target, None)
            .await
            .unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"new content");
    }

    #[tokio::test]
    async fn verify_and_install_accepts_verified_target_after_install_failure() {
        let dir = tempfile::tempdir().unwrap();
        let tmp_path = dir.path().join("missing-tmp.bin");
        let target = dir.path().join("target.bin");
        std::fs::write(&target, b"content").unwrap();
        let sha = file_sha256(&target).await.unwrap();

        verify_and_install(&sha, &sha, "test", &tmp_path, &target, None)
            .await
            .unwrap();
    }

    #[test]
    fn check_system_ca_bundle_consistent_with_filesystem() {
        let result = check_system_ca_bundle();
        let exists = std::path::Path::new(SYSTEM_CA_BUNDLE).exists();
        assert_eq!(
            result.is_ok(),
            exists,
            "check_system_ca_bundle should succeed iff {} exists",
            SYSTEM_CA_BUNDLE
        );
        if let Err(e) = result {
            let msg = e.to_string();
            assert!(msg.contains(SYSTEM_CA_BUNDLE), "error should mention path");
            assert!(msg.contains("ca-certificates"), "error should suggest fix");
        }
    }
}
