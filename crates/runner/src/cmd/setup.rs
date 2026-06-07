//! Prepare a host to run vm0 sandboxes.
//!
//! The setup command validates host prerequisites, creates the runner home
//! layout, and installs the pinned Firecracker, kernel, and mitmdump artifacts
//! used by sandbox startup.

use std::io::Read;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

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

const GROUP_OR_OTHER_WRITE_BITS: u32 = 0o022;
const OWNER_DIRECTORY_BITS: u32 = 0o700;
const ROOT_UID: u32 = 0;
const SHARED_DIRECTORY_CREATE_MODE: u32 = 0o755;
const SETUP_TEMP_FILE_MODE: u32 = 0o600;
const EXECUTABLE_ARTIFACT_MODE: u32 = 0o755;
const KERNEL_ARTIFACT_MODE: u32 = 0o644;

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
    create_directories(&paths)?;
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

fn create_directories(paths: &HomePaths) -> RunnerResult<()> {
    let firecracker_version_dir = paths.firecracker_dir(FIRECRACKER_VERSION);
    let mitmproxy_version_dir = paths.mitmproxy_dir(MITMPROXY_VERSION);
    let dirs = [
        paths.root_dir().to_path_buf(),
        paths.bin_dir(),
        parent_dir(&firecracker_version_dir)?,
        firecracker_version_dir,
        parent_dir(&mitmproxy_version_dir)?,
        mitmproxy_version_dir,
        paths.images_dir(),
        paths.logs_dir(),
        paths.runners_dir(),
        paths.workspace_image_cache_dir(),
        paths.groups_dir(),
        paths.debootstrap_dir(),
        paths.locks_dir(),
        paths.storages_dir(),
    ];
    for dir in &dirs {
        ensure_shared_directory(dir)?;
    }
    tracing::info!("[OK] directory structure created");
    Ok(())
}

fn parent_dir(path: &Path) -> RunnerResult<PathBuf> {
    path.parent().map(Path::to_path_buf).ok_or_else(|| {
        RunnerError::Internal(format!(
            "{} does not have a parent directory",
            path.display()
        ))
    })
}

fn ensure_shared_directory(dir: &Path) -> RunnerResult<()> {
    create_shared_directory_all(dir)?;
    secure_shared_directory_permissions(dir)
}

#[cfg(unix)]
fn create_shared_directory_all(dir: &Path) -> RunnerResult<()> {
    use std::os::unix::fs::DirBuilderExt;

    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(SHARED_DIRECTORY_CREATE_MODE)
        .create(dir)
        .map_err(|e| RunnerError::Internal(format!("create {}: {e}", dir.display())))?;
    Ok(())
}

#[cfg(not(unix))]
fn create_shared_directory_all(dir: &Path) -> RunnerResult<()> {
    std::fs::create_dir_all(dir)
        .map_err(|e| RunnerError::Internal(format!("create {}: {e}", dir.display())))?;
    Ok(())
}

#[cfg(unix)]
fn secure_shared_directory_permissions(dir: &Path) -> RunnerResult<()> {
    use nix::fcntl::open;
    use nix::sys::stat::{Mode, SFlag, fstat};

    let fd = open(dir, shared_directory_open_flags(), Mode::empty()).map_err(|e| {
        RunnerError::Internal(format!(
            "open shared directory {} without following symlinks: {e}",
            dir.display()
        ))
    })?;
    let stat = fstat(&fd).map_err(|e| {
        RunnerError::Internal(format!("stat shared directory {}: {e}", dir.display()))
    })?;
    let file_type = SFlag::from_bits_truncate(stat.st_mode & SFlag::S_IFMT.bits());
    if file_type != SFlag::S_IFDIR {
        return Err(RunnerError::Internal(format!(
            "{} is not a directory",
            dir.display()
        )));
    }
    let expected_uid = nix::unistd::geteuid().as_raw();
    ensure_trusted_shared_directory_owner(dir, stat.st_uid, expected_uid)?;

    let current_mode = (stat.st_mode as u32) & 0o7777;
    let secure_mode = (current_mode | OWNER_DIRECTORY_BITS) & !GROUP_OR_OTHER_WRITE_BITS;
    if secure_mode != current_mode {
        chmod_open_shared_directory(&fd, dir, secure_mode)?;
    }
    Ok(())
}

#[cfg(unix)]
fn ensure_trusted_shared_directory_owner(
    dir: &Path,
    owner_uid: u32,
    expected_uid: u32,
) -> RunnerResult<()> {
    if !is_trusted_setup_owner(owner_uid, expected_uid) {
        return Err(RunnerError::Internal(format!(
            "shared directory {} is owned by untrusted uid {owner_uid}; fix ownership before running setup",
            dir.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn is_trusted_setup_owner(owner_uid: u32, expected_uid: u32) -> bool {
    owner_uid == ROOT_UID || owner_uid == expected_uid
}

#[cfg(all(unix, target_os = "linux"))]
fn shared_directory_open_flags() -> nix::fcntl::OFlag {
    nix::fcntl::OFlag::O_PATH
        | nix::fcntl::OFlag::O_DIRECTORY
        | nix::fcntl::OFlag::O_NOFOLLOW
        | nix::fcntl::OFlag::O_CLOEXEC
}

#[cfg(all(unix, not(target_os = "linux")))]
fn shared_directory_open_flags() -> nix::fcntl::OFlag {
    nix::fcntl::OFlag::O_RDONLY
        | nix::fcntl::OFlag::O_DIRECTORY
        | nix::fcntl::OFlag::O_NOFOLLOW
        | nix::fcntl::OFlag::O_CLOEXEC
}

#[cfg(not(unix))]
fn secure_shared_directory_permissions(dir: &Path) -> RunnerResult<()> {
    let metadata = std::fs::metadata(dir).map_err(|e| {
        RunnerError::Internal(format!("stat shared directory {}: {e}", dir.display()))
    })?;
    if !metadata.is_dir() {
        return Err(RunnerError::Internal(format!(
            "{} is not a directory",
            dir.display()
        )));
    }
    Ok(())
}

#[cfg(all(unix, target_os = "linux"))]
fn chmod_open_shared_directory<Fd: std::os::fd::AsRawFd>(
    fd: &Fd,
    dir: &Path,
    mode: u32,
) -> RunnerResult<()> {
    let fd_path = PathBuf::from(format!("/proc/self/fd/{}", fd.as_raw_fd()));
    std::fs::set_permissions(&fd_path, std::fs::Permissions::from_mode(mode)).map_err(|e| {
        RunnerError::Internal(format!("chmod shared directory {}: {e}", dir.display()))
    })
}

#[cfg(all(unix, not(target_os = "linux")))]
fn chmod_open_shared_directory<Fd: std::os::fd::AsFd>(
    fd: &Fd,
    dir: &Path,
    mode: u32,
) -> RunnerResult<()> {
    nix::sys::stat::fchmod(fd, nix::sys::stat::Mode::from_bits_truncate(mode)).map_err(|e| {
        RunnerError::Internal(format!("chmod shared directory {}: {e}", dir.display()))
    })
}

// ---------------------------------------------------------------------------
// Shared download helpers
// ---------------------------------------------------------------------------

/// Stream an HTTP response to a file, computing SHA256 incrementally.
/// Returns the hex-encoded digest.
async fn stream_to_file(mut response: reqwest::Response, path: &Path) -> RunnerResult<String> {
    let mut file = create_setup_temp_file(path, "download temp").await?;
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

async fn create_setup_temp_file(path: &Path, label: &'static str) -> RunnerResult<tokio::fs::File> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "remove stale {label} {}: {e}",
                path.display()
            )));
        }
    }

    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        options.mode(SETUP_TEMP_FILE_MODE);
    }

    let file = options
        .open(path)
        .await
        .map_err(|e| RunnerError::Internal(format!("create {label} {}: {e}", path.display())))?;

    #[cfg(unix)]
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(SETUP_TEMP_FILE_MODE))
        .await
        .map_err(|e| RunnerError::Internal(format!("chmod {label} {}: {e}", path.display())))?;

    Ok(file)
}

fn create_setup_temp_file_sync(path: &Path, label: &'static str) -> RunnerResult<std::fs::File> {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "remove stale {label} {}: {e}",
                path.display()
            )));
        }
    }

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(SETUP_TEMP_FILE_MODE);
    }

    let file = options
        .open(path)
        .map_err(|e| RunnerError::Internal(format!("create {label} {}: {e}", path.display())))?;

    #[cfg(unix)]
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(SETUP_TEMP_FILE_MODE))
        .map_err(|e| RunnerError::Internal(format!("chmod {label} {}: {e}", path.display())))?;

    Ok(file)
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
                let mut out = create_setup_temp_file_sync(&tmp, "extracted temp binary")?;
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
    #[cfg(unix)]
    if !is_trusted_setup_owner(metadata.uid(), nix::unistd::geteuid().as_raw()) {
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
    #[cfg(unix)]
    if !is_trusted_setup_owner(metadata.uid(), nix::unistd::geteuid().as_raw()) {
        return Ok(false);
    }

    Ok(file_sha256(path).await? == expected_sha)
}

async fn download_firecracker(paths: &HomePaths, arch: &str) -> RunnerResult<()> {
    let bin_path = paths.firecracker_bin(FIRECRACKER_VERSION);
    let expected_sha = select_sha(arch, FIRECRACKER_SHA256_X86_64, FIRECRACKER_SHA256_AARCH64);

    if ensure_artifact_installed(&bin_path, expected_sha, Some(EXECUTABLE_ARTIFACT_MODE)).await? {
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
        Some(EXECUTABLE_ARTIFACT_MODE),
    )
    .await?;
    tracing::info!("[OK] firecracker {FIRECRACKER_VERSION} installed");
    Ok(())
}

async fn download_kernel(paths: &HomePaths, arch: &str) -> RunnerResult<()> {
    let kernel_path = paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION);
    let expected_sha = select_sha(arch, KERNEL_SHA256_X86_64, KERNEL_SHA256_AARCH64);

    if ensure_artifact_installed(&kernel_path, expected_sha, Some(KERNEL_ARTIFACT_MODE)).await? {
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
        Some(KERNEL_ARTIFACT_MODE),
    )
    .await?;
    tracing::info!("[OK] kernel vmlinux-{KERNEL_VERSION} installed");
    Ok(())
}

async fn download_mitmdump(paths: &HomePaths, arch: &str) -> RunnerResult<()> {
    let bin_path = paths.mitmdump_bin(MITMPROXY_VERSION);
    let expected_sha = select_sha(arch, MITMDUMP_SHA256_X86_64, MITMDUMP_SHA256_AARCH64);

    if ensure_artifact_installed(&bin_path, expected_sha, Some(EXECUTABLE_ARTIFACT_MODE)).await? {
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
        Some(EXECUTABLE_ARTIFACT_MODE),
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

    #[cfg(unix)]
    #[test]
    fn create_directories_secures_shared_directory_modes() {
        let dir = tempfile::tempdir().unwrap();
        let paths = HomePaths::with_root(dir.path().join("vm0-runner"));
        let bin_dir = paths.bin_dir();
        let runners_dir = paths.runners_dir();
        let logs_dir = paths.logs_dir();

        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::create_dir_all(&runners_dir).unwrap();
        std::fs::create_dir_all(&logs_dir).unwrap();
        std::fs::set_permissions(paths.root_dir(), std::fs::Permissions::from_mode(0o777)).unwrap();
        std::fs::set_permissions(&bin_dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        std::fs::set_permissions(&runners_dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        std::fs::set_permissions(&logs_dir, std::fs::Permissions::from_mode(0o700)).unwrap();

        create_directories(&paths).unwrap();

        let firecracker_version_dir = paths.firecracker_dir(FIRECRACKER_VERSION);
        let mitmproxy_version_dir = paths.mitmproxy_dir(MITMPROXY_VERSION);
        let checked_dirs = [
            paths.root_dir().to_path_buf(),
            paths.bin_dir(),
            parent_dir(&firecracker_version_dir).unwrap(),
            firecracker_version_dir,
            parent_dir(&mitmproxy_version_dir).unwrap(),
            mitmproxy_version_dir,
            paths.images_dir(),
            paths.runners_dir(),
            paths.workspace_image_cache_dir(),
            paths.groups_dir(),
            paths.debootstrap_dir(),
            paths.locks_dir(),
            paths.storages_dir(),
        ];

        for path in checked_dirs {
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(
                mode & GROUP_OR_OTHER_WRITE_BITS,
                0,
                "{} mode should not be group/other writable: {mode:o}",
                path.display()
            );
            assert_eq!(
                mode & OWNER_DIRECTORY_BITS,
                OWNER_DIRECTORY_BITS,
                "{} mode should preserve owner rwx access: {mode:o}",
                path.display()
            );
        }

        let bin_mode = std::fs::metadata(&bin_dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(bin_mode, 0o700);
        let logs_mode = std::fs::metadata(&logs_dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(logs_mode, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn shared_directory_owner_must_be_current_user_or_root() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shared");

        assert!(is_trusted_setup_owner(0, 1000));
        assert!(is_trusted_setup_owner(1000, 1000));
        assert!(!is_trusted_setup_owner(1001, 1000));
        ensure_trusted_shared_directory_owner(&path, 0, 1000).unwrap();
        ensure_trusted_shared_directory_owner(&path, 1000, 1000).unwrap();
        let error = ensure_trusted_shared_directory_owner(&path, 1001, 1000).unwrap_err();

        assert!(
            error.to_string().contains("untrusted uid"),
            "unexpected error: {error}"
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

    #[cfg(unix)]
    #[tokio::test]
    async fn create_setup_temp_file_replaces_stale_wide_file_privately() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("download.tmp");
        std::fs::write(&path, b"stale").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();

        let file = create_setup_temp_file(&path, "test temp").await.unwrap();
        drop(file);

        assert_eq!(std::fs::read(&path).unwrap(), b"");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, SETUP_TEMP_FILE_MODE);
    }

    #[cfg(unix)]
    #[test]
    fn create_setup_temp_file_sync_replaces_stale_wide_file_privately() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("extract.tmp");
        std::fs::write(&path, b"stale").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();

        let file = create_setup_temp_file_sync(&path, "test temp").unwrap();
        drop(file);

        assert_eq!(std::fs::read(&path).unwrap(), b"");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, SETUP_TEMP_FILE_MODE);
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

    #[cfg(unix)]
    #[tokio::test]
    async fn verify_and_install_sets_kernel_artifact_mode() {
        let dir = tempfile::tempdir().unwrap();
        let tmp_path = dir.path().join("kernel.tmp");
        let target = dir.path().join("vmlinux");
        std::fs::write(&tmp_path, b"kernel").unwrap();
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o666)).unwrap();
        let sha = file_sha256(&tmp_path).await.unwrap();

        verify_and_install(
            &sha,
            &sha,
            "kernel",
            &tmp_path,
            &target,
            Some(KERNEL_ARTIFACT_MODE),
        )
        .await
        .unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"kernel");
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, KERNEL_ARTIFACT_MODE);
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
