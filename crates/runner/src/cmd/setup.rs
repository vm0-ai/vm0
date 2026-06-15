//! Prepare a host to run vm0 sandboxes.
//!
//! The setup command validates host prerequisites, creates the runner home
//! layout, and installs the pinned Firecracker, kernel, and mitmdump artifacts
//! used by sandbox startup.

use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};

use nix::fcntl::{OFlag, open, openat};
use nix::sys::stat::{Mode, SFlag, fstat, mkdirat};
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

const SETUP_SHARED_DIR_MODE: u32 = 0o755;
const SETUP_TEMP_ARTIFACT_MODE: u32 = 0o600;
const SETUP_EXECUTABLE_ARTIFACT_MODE: u32 = 0o755;
const SETUP_KERNEL_ARTIFACT_MODE: u32 = 0o644;
const SETUP_TEMP_CREATE_ATTEMPTS: usize = 16;
const GROUP_OR_OTHER_WRITE_BITS: u32 = 0o022;
const ROOT_UID: u32 = 0;
const STICKY_BIT: u32 = 0o1000;

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
        ensure_setup_shared_dir(dir)?;
    }
    tracing::info!("[OK] directory structure created");
    Ok(())
}

fn ensure_setup_shared_dir(path: &Path) -> RunnerResult<()> {
    if path.as_os_str().is_empty() {
        return Err(RunnerError::Internal(
            "empty setup directory path is not supported".into(),
        ));
    }

    let expected_uid = nix::unistd::geteuid().as_raw();
    let start = if path.is_absolute() {
        Path::new("/")
    } else {
        Path::new(".")
    };
    let mut current = open(start, setup_dir_open_flags(), Mode::empty()).map_err(|e| {
        RunnerError::Internal(format!(
            "open setup directory root for {}: {e}",
            path.display()
        ))
    })?;
    let mut current_path = start.to_path_buf();
    let mut components = path.components().peekable();
    let mut saw_normal_component = false;

    while let Some(component) = components.next() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                return Err(RunnerError::Internal(format!(
                    "{} contains a parent directory segment",
                    path.display()
                )));
            }
            Component::Normal(name) => {
                saw_normal_component = true;
                let is_final = components.peek().is_none();
                current = open_or_create_setup_dir_component(
                    &current,
                    name,
                    &current_path,
                    path,
                    expected_uid,
                    is_final,
                )?;
                current_path = path_component(&current_path, name);
            }
            Component::Prefix(prefix) => {
                return Err(RunnerError::Internal(format!(
                    "{} contains unsupported path prefix {}",
                    path.display(),
                    prefix.as_os_str().to_string_lossy()
                )));
            }
        }
    }

    if !saw_normal_component {
        secure_setup_dir_component(&current, &current_path, path, expected_uid, true, false)?;
    }

    Ok(())
}

fn open_or_create_setup_dir_component(
    parent: &(impl AsFd + AsRawFd),
    name: &OsStr,
    parent_path: &Path,
    full_path: &Path,
    expected_uid: u32,
    is_final: bool,
) -> RunnerResult<OwnedFd> {
    ensure_setup_parent_not_replaceable(parent, parent_path, full_path, expected_uid)?;
    let component_path = path_component(parent_path, name);

    match openat(parent, name, setup_dir_open_flags(), Mode::empty()) {
        Ok(fd) => {
            secure_setup_dir_component(
                &fd,
                &component_path,
                full_path,
                expected_uid,
                is_final,
                false,
            )?;
            Ok(fd)
        }
        Err(nix::errno::Errno::ENOENT) => {
            match mkdirat(
                parent,
                name,
                Mode::from_bits_truncate(SETUP_SHARED_DIR_MODE),
            ) {
                Ok(()) | Err(nix::errno::Errno::EEXIST) => {}
                Err(e) => {
                    return Err(RunnerError::Internal(format!(
                        "create setup directory component {} for {}: {e}",
                        name.to_string_lossy(),
                        full_path.display()
                    )));
                }
            }

            let fd = openat(parent, name, setup_dir_open_flags(), Mode::empty())
                .map_err(|e| setup_dir_component_error("open", name, full_path, e))?;
            secure_setup_dir_component(
                &fd,
                &component_path,
                full_path,
                expected_uid,
                is_final,
                true,
            )?;
            Ok(fd)
        }
        Err(e) => Err(setup_dir_component_error("open", name, full_path, e)),
    }
}

fn ensure_setup_parent_not_replaceable(
    parent: &(impl AsFd + AsRawFd),
    parent_path: &Path,
    full_path: &Path,
    expected_uid: u32,
) -> RunnerResult<()> {
    let stat = fstat(parent).map_err(|e| {
        RunnerError::Internal(format!(
            "stat setup directory parent {} for {}: {e}",
            parent_path.display(),
            full_path.display()
        ))
    })?;
    let mode = (stat.st_mode as u32) & 0o7777;
    if stat.st_uid != ROOT_UID && stat.st_uid != expected_uid {
        return Err(RunnerError::Internal(format!(
            "setup directory parent {} is owned by untrusted uid {}",
            parent_path.display(),
            stat.st_uid
        )));
    }
    if mode & GROUP_OR_OTHER_WRITE_BITS != 0 && mode & STICKY_BIT == 0 {
        return Err(RunnerError::Internal(format!(
            "setup directory parent {} is group/other writable without the sticky bit",
            parent_path.display()
        )));
    }
    Ok(())
}

fn secure_setup_dir_component(
    fd: &(impl AsFd + AsRawFd),
    component_path: &Path,
    full_path: &Path,
    expected_uid: u32,
    is_final: bool,
    created: bool,
) -> RunnerResult<()> {
    let stat = fstat(fd).map_err(|e| {
        RunnerError::Internal(format!(
            "stat setup directory component {} for {}: {e}",
            component_path.display(),
            full_path.display()
        ))
    })?;
    let file_type = SFlag::from_bits_truncate(stat.st_mode & SFlag::S_IFMT.bits());
    if file_type != SFlag::S_IFDIR {
        return Err(RunnerError::Internal(format!(
            "{} is not a directory",
            component_path.display()
        )));
    }
    if stat.st_uid != ROOT_UID && stat.st_uid != expected_uid {
        return Err(RunnerError::Internal(format!(
            "setup directory component {} is owned by untrusted uid {}",
            component_path.display(),
            stat.st_uid
        )));
    }

    let mode = (stat.st_mode as u32) & 0o7777;
    if mode & GROUP_OR_OTHER_WRITE_BITS != 0 && (is_final || mode & STICKY_BIT == 0) {
        return Err(RunnerError::Internal(format!(
            "setup directory component {} is group/other writable",
            component_path.display()
        )));
    }

    if (created || is_final) && stat.st_uid == expected_uid && mode != SETUP_SHARED_DIR_MODE {
        chmod_fd(fd, component_path, SETUP_SHARED_DIR_MODE, "setup directory")?;
    }

    Ok(())
}

fn setup_dir_component_error(
    operation: &str,
    name: &OsStr,
    full_path: &Path,
    error: nix::errno::Errno,
) -> RunnerError {
    match error {
        nix::errno::Errno::ELOOP => RunnerError::Internal(format!(
            "{} contains symlink component {}",
            full_path.display(),
            name.to_string_lossy()
        )),
        nix::errno::Errno::ENOTDIR => {
            RunnerError::Internal(format!("{} is not a directory", full_path.display()))
        }
        _ => RunnerError::Internal(format!(
            "{operation} setup directory component {} for {}: {error}",
            name.to_string_lossy(),
            full_path.display()
        )),
    }
}

fn path_component(parent_path: &Path, name: &OsStr) -> PathBuf {
    let mut path = parent_path.to_path_buf();
    path.push(Path::new(name));
    path
}

fn setup_dir_open_flags() -> OFlag {
    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC
}

fn create_setup_temp_file(target: &Path, kind: &str) -> RunnerResult<(PathBuf, File)> {
    let parent = file_parent(target);
    ensure_setup_shared_dir(parent)?;
    let file_name = target.file_name().ok_or_else(|| {
        RunnerError::Internal(format!(
            "{} does not have a file name; refusing to create setup temp artifact",
            target.display()
        ))
    })?;

    for _ in 0..SETUP_TEMP_CREATE_ATTEMPTS {
        let mut tmp_name = OsString::from(".");
        tmp_name.push(file_name);
        tmp_name.push(".");
        tmp_name.push(kind);
        tmp_name.push(".");
        tmp_name.push(uuid::Uuid::new_v4().to_string());
        tmp_name.push(".tmp");
        let tmp_path = target.with_file_name(tmp_name);

        match open_setup_temp_file_at(&tmp_path) {
            Ok(file) => {
                secure_setup_temp_file(&file, &tmp_path)?;
                return Ok((tmp_path, file));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(RunnerError::Internal(format!(
                    "create setup temp artifact {}: {error}",
                    tmp_path.display()
                )));
            }
        }
    }

    Err(RunnerError::Internal(format!(
        "create setup temp artifact for {}: exhausted {SETUP_TEMP_CREATE_ATTEMPTS} attempts",
        target.display()
    )))
}

#[cfg(test)]
fn create_setup_temp_file_at(path: &Path) -> RunnerResult<File> {
    ensure_setup_shared_dir(file_parent(path))?;
    let file = open_setup_temp_file_at(path).map_err(|e| {
        RunnerError::Internal(format!(
            "create setup temp artifact {}: {e}",
            path.display()
        ))
    })?;
    secure_setup_temp_file(&file, path)?;
    Ok(file)
}

fn open_setup_temp_file_at(path: &Path) -> std::io::Result<File> {
    let mut options = File::options();
    options
        .read(true)
        .write(true)
        .create_new(true)
        .mode(SETUP_TEMP_ARTIFACT_MODE)
        .custom_flags(setup_file_open_flags());
    options.open(path)
}

fn secure_setup_temp_file(file: &File, path: &Path) -> RunnerResult<()> {
    let stat = setup_file_stat(file, path, "setup temp artifact")?;
    let file_type = stat.st_mode & libc::S_IFMT;
    if file_type != libc::S_IFREG {
        return Err(RunnerError::Internal(format!(
            "{} is not a regular setup temp artifact",
            path.display()
        )));
    }

    let expected_uid = nix::unistd::geteuid().as_raw();
    if stat.st_uid != expected_uid {
        return Err(RunnerError::Internal(format!(
            "{} is owned by uid {}, but runner euid is {expected_uid}",
            path.display(),
            stat.st_uid
        )));
    }

    let mode = stat.st_mode & 0o7777;
    if mode != SETUP_TEMP_ARTIFACT_MODE {
        chmod_fd(file, path, SETUP_TEMP_ARTIFACT_MODE, "setup temp artifact")?;
    }
    Ok(())
}

fn install_temp_artifact(
    tmp_path: &Path,
    target: &Path,
    expected_sha: &str,
    mode: u32,
) -> RunnerResult<()> {
    let mut options = File::options();
    options
        .read(true)
        .write(true)
        .custom_flags(setup_file_open_flags());
    let mut file = options.open(tmp_path).map_err(|e| {
        RunnerError::Internal(format!(
            "open setup temp artifact {}: {e}",
            tmp_path.display()
        ))
    })?;
    let stat = setup_file_stat(&file, tmp_path, "setup temp artifact")?;
    validate_trusted_regular_setup_file(&stat, tmp_path, "setup temp artifact")?;
    if (stat.st_mode & GROUP_OR_OTHER_WRITE_BITS) != 0 {
        return Err(RunnerError::Internal(format!(
            "{} is group/other writable",
            tmp_path.display()
        )));
    }

    let sha = file_sha256_open(&mut file, tmp_path)?;
    if sha != expected_sha {
        return Err(RunnerError::Internal(format!(
            "setup temp artifact SHA256 mismatch for {}: expected {expected_sha}, got {sha}",
            tmp_path.display()
        )));
    }

    chmod_fd(&file, tmp_path, mode, "setup temp artifact")?;
    drop(file);

    std::fs::rename(tmp_path, target)
        .map_err(|e| RunnerError::Internal(format!("rename to {}: {e}", target.display())))?;

    if ensure_artifact_installed_blocking(target, expected_sha, mode)? {
        Ok(())
    } else {
        Err(RunnerError::Internal(format!(
            "installed setup artifact {} failed validation",
            target.display()
        )))
    }
}

fn ensure_artifact_installed_blocking(
    path: &Path,
    expected_sha: &str,
    mode: u32,
) -> RunnerResult<bool> {
    let Some(mut file) = open_existing_setup_artifact(path)? else {
        return Ok(false);
    };

    let stat = setup_file_stat(&file, path, "setup artifact")?;
    if (stat.st_mode & libc::S_IFMT) != libc::S_IFREG {
        return Ok(false);
    }
    validate_trusted_setup_owner(&stat, path, "setup artifact")?;

    let current_mode = stat.st_mode & 0o7777;
    if current_mode & GROUP_OR_OTHER_WRITE_BITS != 0 {
        return Ok(false);
    }

    if file_sha256_open(&mut file, path)? != expected_sha {
        return Ok(false);
    }

    if current_mode != mode {
        chmod_fd(&file, path, mode, "setup artifact")?;
        let repaired = setup_file_stat(&file, path, "setup artifact")?;
        if (repaired.st_mode & 0o7777) != mode {
            return Ok(false);
        }
        if file_sha256_open(&mut file, path)? != expected_sha {
            return Ok(false);
        }
    }

    Ok(true)
}

fn open_existing_setup_artifact(path: &Path) -> RunnerResult<Option<File>> {
    if !setup_artifact_path_is_regular(path)? {
        return Ok(None);
    }

    let mut options = File::options();
    options.read(true).custom_flags(setup_file_open_flags());
    match options.open(path) {
        Ok(file) => Ok(Some(file)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => Ok(None),
        Err(e) => {
            if !setup_artifact_path_is_regular(path)? {
                return Ok(None);
            }
            Err(RunnerError::Internal(format!(
                "open setup artifact {}: {e}",
                path.display()
            )))
        }
    }
}

fn setup_artifact_path_is_regular(path: &Path) -> RunnerResult<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_file()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(RunnerError::Internal(format!(
            "stat setup artifact {}: {e}",
            path.display()
        ))),
    }
}

fn file_sha256_open(file: &mut File, path: &Path) -> RunnerResult<String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|e| RunnerError::Internal(format!("seek {}: {e}", path.display())))?;
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
}

fn setup_file_stat<Fd: AsRawFd>(file: &Fd, path: &Path, context: &str) -> RunnerResult<libc::stat> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `stat` points to writable memory and `file` owns a live fd.
    let result = unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(RunnerError::Internal(format!(
            "stat {context} {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        )));
    }
    // SAFETY: successful `fstat` initialized the full struct.
    Ok(unsafe { stat.assume_init() })
}

fn validate_trusted_regular_setup_file(
    stat: &libc::stat,
    path: &Path,
    context: &str,
) -> RunnerResult<()> {
    if (stat.st_mode & libc::S_IFMT) != libc::S_IFREG {
        return Err(RunnerError::Internal(format!(
            "{} is not a regular {context}",
            path.display()
        )));
    }
    validate_trusted_setup_owner(stat, path, context)
}

fn validate_trusted_setup_owner(stat: &libc::stat, path: &Path, context: &str) -> RunnerResult<()> {
    let expected_uid = nix::unistd::geteuid().as_raw();
    if stat.st_uid != ROOT_UID && stat.st_uid != expected_uid {
        return Err(RunnerError::Internal(format!(
            "{context} {} is owned by untrusted uid {}",
            path.display(),
            stat.st_uid
        )));
    }
    Ok(())
}

fn chmod_fd<Fd: AsRawFd>(file: &Fd, path: &Path, mode: u32, context: &str) -> RunnerResult<()> {
    // SAFETY: `fchmod` operates on the live fd and does not affect Rust aliasing.
    let result = unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) };
    if result == 0 {
        Ok(())
    } else {
        Err(RunnerError::Internal(format!(
            "chmod {context} {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        )))
    }
}

fn setup_file_open_flags() -> i32 {
    libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK
}

fn file_parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

// ---------------------------------------------------------------------------
// Shared download helpers
// ---------------------------------------------------------------------------

/// Stream an HTTP response to an opened temp file, computing SHA256 incrementally.
/// Returns the hex-encoded digest.
async fn stream_to_file(
    mut response: reqwest::Response,
    mut file: tokio::fs::File,
    path: &Path,
) -> RunnerResult<String> {
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
async fn download_to_temp(
    url: &str,
    target: &Path,
    kind: &str,
    label: &str,
) -> RunnerResult<(PathBuf, String)> {
    let (tmp_path, file) = create_setup_temp_file(target, kind)?;
    let result = async {
        let response = reqwest::get(url)
            .await
            .map_err(|e| RunnerError::Internal(format!("download {label}: {e}")))?;

        if !response.status().is_success() {
            return Err(RunnerError::Internal(format!(
                "download {label}: HTTP {}",
                response.status()
            )));
        }

        stream_to_file(response, tokio::fs::File::from_std(file), &tmp_path).await
    }
    .await;

    match result {
        Ok(sha) => Ok((tmp_path, sha)),
        Err(error) => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            Err(error)
        }
    }
}

/// Download a tarball, extract a named entry. Cleans up tarball after extraction.
/// Returns hex SHA256 of the extracted entry. Cleans up tmp_path on failure.
async fn download_and_extract(
    url: &str,
    label: &str,
    entry_name: &str,
    target: &Path,
) -> RunnerResult<(PathBuf, String)> {
    // Tarball SHA is intentionally discarded — we verify the extracted binary's SHA instead.
    let (tarball_path, _) = download_to_temp(url, target, "tarball", label).await?;

    let result = extract_tar_entry(&tarball_path, target, entry_name).await;
    let _ = tokio::fs::remove_file(&tarball_path).await;
    result
}

/// Extract a named entry from a gzipped tarball, writing to tmp_path.
/// Matches by file_name (last path component). Returns the SHA256 hex digest.
async fn extract_tar_entry(
    tarball_path: &Path,
    target: &Path,
    entry_name: &str,
) -> RunnerResult<(PathBuf, String)> {
    let tarball = tarball_path.to_owned();
    let target = target.to_owned();
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
                let (tmp, mut out) = create_setup_temp_file(&target, "extract")?;
                let mut hasher = Sha256::new();
                let mut buf = [0u8; 64 * 1024];
                let result = loop {
                    let n = entry
                        .read(&mut buf)
                        .map_err(|e| RunnerError::Internal(format!("read tar entry: {e}")))?;
                    if n == 0 {
                        std::io::Write::flush(&mut out)
                            .map_err(|e| RunnerError::Internal(format!("flush binary: {e}")))?;
                        break Ok(hex::encode(hasher.finalize()));
                    }
                    let chunk = buf.get(..n).ok_or_else(|| {
                        RunnerError::Internal("read returned invalid length".into())
                    })?;
                    hasher.update(chunk);
                    std::io::Write::write_all(&mut out, chunk)
                        .map_err(|e| RunnerError::Internal(format!("write binary: {e}")))?;
                };
                if result.is_err() {
                    let _ = std::fs::remove_file(&tmp);
                }
                return result.map(|sha| (tmp, sha));
            }
        }

        Err(RunnerError::Internal(format!(
            "'{entry_name}' not found in tarball"
        )))
    })
    .await
    .map_err(|e| RunnerError::Internal(format!("extract task failed: {e}")))?
}

/// Verify SHA256, set permissions through the temp fd, and atomically rename to target.
/// A failed rename only counts as a concurrent install if the target verifies.
async fn verify_and_install(
    sha_hex: &str,
    expected_sha: &str,
    label: &str,
    tmp_path: &Path,
    target: &Path,
    mode: u32,
) -> RunnerResult<()> {
    if let Err(e) = verify_sha256(sha_hex, expected_sha, label) {
        let _ = tokio::fs::remove_file(tmp_path).await;
        return Err(e);
    }

    match atomic_rename(tmp_path, target, expected_sha, mode).await {
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

/// Prepare temp artifact through its fd, then atomically rename. Cleans up temp on failure.
async fn atomic_rename(
    tmp_path: &Path,
    target: &Path,
    expected_sha: &str,
    mode: u32,
) -> RunnerResult<()> {
    let tmp = tmp_path.to_owned();
    let target = target.to_owned();
    let expected_sha = expected_sha.to_owned();
    let result = tokio::task::spawn_blocking(move || {
        install_temp_artifact(&tmp, &target, &expected_sha, mode)
    })
    .await
    .map_err(|e| RunnerError::Internal(format!("install task failed: {e}")))?;

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
#[cfg(test)]
async fn file_sha256(path: &Path) -> RunnerResult<String> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let Some(mut file) = open_existing_setup_artifact(&path)? else {
            return Err(RunnerError::Internal(format!(
                "open {}: not found",
                path.display()
            )));
        };
        let stat = setup_file_stat(&file, &path, "setup artifact")?;
        validate_trusted_regular_setup_file(&stat, &path, "setup artifact")?;
        file_sha256_open(&mut file, &path)
    })
    .await
    .map_err(|e| RunnerError::Internal(format!("sha256 task failed: {e}")))?
}

/// Ensure an existing setup artifact matches its pinned SHA and usable mode.
async fn ensure_artifact_installed(
    path: &Path,
    expected_sha: &str,
    mode: u32,
) -> RunnerResult<bool> {
    let path = path.to_owned();
    let expected_sha = expected_sha.to_owned();
    tokio::task::spawn_blocking(move || {
        ensure_artifact_installed_blocking(&path, &expected_sha, mode)
    })
    .await
    .map_err(|e| RunnerError::Internal(format!("artifact validation task failed: {e}")))?
}

async fn download_firecracker(paths: &HomePaths, arch: &str) -> RunnerResult<()> {
    let bin_path = paths.firecracker_bin(FIRECRACKER_VERSION);
    let expected_sha = select_sha(arch, FIRECRACKER_SHA256_X86_64, FIRECRACKER_SHA256_AARCH64);

    if ensure_artifact_installed(&bin_path, expected_sha, SETUP_EXECUTABLE_ARTIFACT_MODE).await? {
        tracing::info!(
            "[OK] firecracker {FIRECRACKER_VERSION} already installed, skipping download"
        );
        return Ok(());
    }

    let url = firecracker_url(arch);
    tracing::info!("downloading firecracker from {url}");

    let fc_entry = firecracker_tar_entry(arch);
    let (tmp_path, sha_hex) =
        download_and_extract(&url, "firecracker", &fc_entry, &bin_path).await?;

    verify_and_install(
        &sha_hex,
        expected_sha,
        "firecracker",
        &tmp_path,
        &bin_path,
        SETUP_EXECUTABLE_ARTIFACT_MODE,
    )
    .await?;
    tracing::info!("[OK] firecracker {FIRECRACKER_VERSION} installed");
    Ok(())
}

async fn download_kernel(paths: &HomePaths, arch: &str) -> RunnerResult<()> {
    let kernel_path = paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION);
    let expected_sha = select_sha(arch, KERNEL_SHA256_X86_64, KERNEL_SHA256_AARCH64);

    if ensure_artifact_installed(&kernel_path, expected_sha, SETUP_KERNEL_ARTIFACT_MODE).await? {
        tracing::info!("[OK] kernel vmlinux-{KERNEL_VERSION} already installed, skipping download");
        return Ok(());
    }

    let url = kernel_url(arch);
    tracing::info!("downloading kernel from {url}");

    let (tmp_path, sha_hex) = download_to_temp(&url, &kernel_path, "download", "kernel").await?;

    verify_and_install(
        &sha_hex,
        expected_sha,
        "kernel",
        &tmp_path,
        &kernel_path,
        SETUP_KERNEL_ARTIFACT_MODE,
    )
    .await?;
    tracing::info!("[OK] kernel vmlinux-{KERNEL_VERSION} installed");
    Ok(())
}

async fn download_mitmdump(paths: &HomePaths, arch: &str) -> RunnerResult<()> {
    let bin_path = paths.mitmdump_bin(MITMPROXY_VERSION);
    let expected_sha = select_sha(arch, MITMDUMP_SHA256_X86_64, MITMDUMP_SHA256_AARCH64);

    if ensure_artifact_installed(&bin_path, expected_sha, SETUP_EXECUTABLE_ARTIFACT_MODE).await? {
        tracing::info!("[OK] mitmdump {MITMPROXY_VERSION} already installed, skipping download");
        return Ok(());
    }

    let url = mitmdump_url(arch);
    tracing::info!("downloading mitmdump from {url}");

    let (tmp_path, sha_hex) =
        download_and_extract(&url, "mitmdump", MITMDUMP_TAR_ENTRY, &bin_path).await?;

    verify_and_install(
        &sha_hex,
        expected_sha,
        "mitmdump",
        &tmp_path,
        &bin_path,
        SETUP_EXECUTABLE_ARTIFACT_MODE,
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
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::os::unix::net::UnixListener;

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

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

    #[test]
    fn ensure_setup_shared_dir_creates_shared_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("setup").join("firecracker");

        ensure_setup_shared_dir(&path).unwrap();

        assert_eq!(mode(&path), SETUP_SHARED_DIR_MODE);
        assert!(path.is_dir());
    }

    #[test]
    fn ensure_setup_shared_dir_rejects_final_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("link");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &link).unwrap();

        let error = ensure_setup_shared_dir(&link).unwrap_err();

        assert!(
            error.to_string().contains("symlink") || error.to_string().contains("not a directory"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn ensure_setup_shared_dir_rejects_intermediate_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("link");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &link).unwrap();

        let error = ensure_setup_shared_dir(&link.join("child")).unwrap_err();

        assert!(
            error.to_string().contains("symlink") || error.to_string().contains("not a directory"),
            "unexpected error: {error}"
        );
        assert!(!target.join("child").exists());
    }

    #[test]
    fn ensure_setup_shared_dir_rejects_unsafe_writable_parent() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("unsafe");
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o777)).unwrap();

        let error = ensure_setup_shared_dir(&parent.join("child")).unwrap_err();

        assert!(
            error.to_string().contains("group/other writable"),
            "unexpected error: {error}"
        );
        assert!(!parent.join("child").exists());
    }

    #[test]
    fn create_setup_temp_file_at_creates_private_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".artifact.tmp");

        let file = create_setup_temp_file_at(&path).unwrap();
        drop(file);

        assert_eq!(mode(&path), SETUP_TEMP_ARTIFACT_MODE);
    }

    #[test]
    fn create_setup_temp_file_at_rejects_stale_symlink_without_following() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside");
        let link = dir.path().join(".artifact.tmp");
        std::fs::write(&outside, b"outside").unwrap();
        symlink(&outside, &link).unwrap();

        let error = create_setup_temp_file_at(&link).unwrap_err();

        assert!(
            error.to_string().contains("File exists")
                || error.to_string().contains("file exists")
                || error.to_string().contains("exists"),
            "unexpected error: {error}"
        );
        assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
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
            !ensure_artifact_installed(&path, "anything", SETUP_EXECUTABLE_ARTIFACT_MODE)
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
            !ensure_artifact_installed(&path, "wrong_sha", SETUP_EXECUTABLE_ARTIFACT_MODE)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn ensure_artifact_installed_returns_true_for_matching_sha_and_kernel_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::write(&path, b"content").unwrap();
        std::fs::set_permissions(
            &path,
            std::fs::Permissions::from_mode(SETUP_KERNEL_ARTIFACT_MODE),
        )
        .unwrap();
        let sha = file_sha256(&path).await.unwrap();
        assert!(
            ensure_artifact_installed(&path, &sha, SETUP_KERNEL_ARTIFACT_MODE)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn ensure_artifact_installed_returns_true_for_matching_sha_and_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::write(&path, b"content").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let sha = file_sha256(&path).await.unwrap();

        assert!(
            ensure_artifact_installed(&path, &sha, SETUP_EXECUTABLE_ARTIFACT_MODE)
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
            ensure_artifact_installed(&path, &sha, SETUP_EXECUTABLE_ARTIFACT_MODE)
                .await
                .unwrap()
        );
        assert_eq!(mode(&path), SETUP_EXECUTABLE_ARTIFACT_MODE);
    }

    #[tokio::test]
    async fn ensure_artifact_installed_repairs_readonly_trusted_file_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::write(&path, b"content").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
        let sha = file_sha256(&path).await.unwrap();

        assert!(
            ensure_artifact_installed(&path, &sha, SETUP_KERNEL_ARTIFACT_MODE)
                .await
                .unwrap()
        );
        assert_eq!(mode(&path), SETUP_KERNEL_ARTIFACT_MODE);
    }

    #[tokio::test]
    async fn ensure_artifact_installed_does_not_follow_symlink_artifact() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside.bin");
        let link = dir.path().join("file.bin");
        std::fs::write(&outside, b"content").unwrap();
        symlink(&outside, &link).unwrap();
        let sha = file_sha256(&outside).await.unwrap();

        assert!(
            !ensure_artifact_installed(&link, &sha, SETUP_EXECUTABLE_ARTIFACT_MODE)
                .await
                .unwrap()
        );
        assert_eq!(std::fs::read(&outside).unwrap(), b"content");
    }

    #[tokio::test]
    async fn ensure_artifact_installed_returns_false_for_fifo_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        nix::unistd::mkfifo(&path, Mode::from_bits_truncate(0o600)).unwrap();

        assert!(
            !ensure_artifact_installed(&path, "anything", SETUP_EXECUTABLE_ARTIFACT_MODE)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn ensure_artifact_installed_returns_false_for_unix_socket() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        let _listener = UnixListener::bind(&path).unwrap();

        assert!(
            !ensure_artifact_installed(&path, "anything", SETUP_EXECUTABLE_ARTIFACT_MODE)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn ensure_artifact_installed_returns_false_for_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.bin");
        std::fs::create_dir(&path).unwrap();

        assert!(
            !ensure_artifact_installed(&path, "anything", SETUP_EXECUTABLE_ARTIFACT_MODE)
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
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::create_dir(&target).unwrap();
        let sha = file_sha256(&tmp_path).await.unwrap();

        let result = verify_and_install(
            &sha,
            &sha,
            "test",
            &tmp_path,
            &target,
            SETUP_EXECUTABLE_ARTIFACT_MODE,
        )
        .await;

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
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::write(&target, b"old content").unwrap();
        let sha = file_sha256(&tmp_path).await.unwrap();

        verify_and_install(
            &sha,
            &sha,
            "test",
            &tmp_path,
            &target,
            SETUP_EXECUTABLE_ARTIFACT_MODE,
        )
        .await
        .unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"new content");
        assert_eq!(mode(&target), SETUP_EXECUTABLE_ARTIFACT_MODE);
    }

    #[tokio::test]
    async fn verify_and_install_accepts_verified_target_after_install_failure() {
        let dir = tempfile::tempdir().unwrap();
        let tmp_path = dir.path().join("missing-tmp.bin");
        let target = dir.path().join("target.bin");
        std::fs::write(&target, b"content").unwrap();
        std::fs::set_permissions(
            &target,
            std::fs::Permissions::from_mode(SETUP_EXECUTABLE_ARTIFACT_MODE),
        )
        .unwrap();
        let sha = file_sha256(&target).await.unwrap();

        verify_and_install(
            &sha,
            &sha,
            "test",
            &tmp_path,
            &target,
            SETUP_EXECUTABLE_ARTIFACT_MODE,
        )
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
