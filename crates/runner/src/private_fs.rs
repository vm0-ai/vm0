use std::ffi::OsStr;
use std::os::fd::{AsFd, OwnedFd};
use std::path::{Component, Path, PathBuf};

use crate::error::{RunnerError, RunnerResult};

const PRIVATE_DIR_MODE: u32 = 0o700;
const PRIVATE_FILE_MODE: u32 = 0o600;
const RESERVED_PRIVATE_DIR_PATHS: &[&str] = &[
    "/",
    "/bin",
    "/boot",
    "/dev",
    "/etc",
    "/home",
    "/lib",
    "/lib64",
    "/opt",
    "/proc",
    "/root",
    "/run",
    "/sbin",
    "/srv",
    "/sys",
    "/tmp",
    "/usr",
    "/var",
    "/var/lib",
    "/var/lib/vm0-runner",
    "/var/lib/vm0-runner/runners",
];
const RESERVED_PRIVATE_DIR_SUBTREES: &[&str] = &[
    "/var/lib/vm0-runner/bin",
    "/var/lib/vm0-runner/ca",
    "/var/lib/vm0-runner/debootstrap",
    "/var/lib/vm0-runner/firecracker",
    "/var/lib/vm0-runner/groups",
    "/var/lib/vm0-runner/images",
    "/var/lib/vm0-runner/locks",
    "/var/lib/vm0-runner/logs",
    "/var/lib/vm0-runner/mitmproxy",
    "/var/lib/vm0-runner/storages",
    "/var/lib/vm0-runner/workspace-image-cache",
];

/// Ensure `path` is private runtime state for the current runner process.
///
/// The runner normally runs as root. This intentionally keeps runtime state
/// owned by the effective uid instead of chowning it back to `SUDO_USER`.
#[cfg(unix)]
pub async fn ensure_private_dir(path: &Path) -> RunnerResult<()> {
    reject_reserved_private_dir_path(path)?;
    reject_parent_dir_components(path)?;
    reject_existing_symlink_components(path).await?;
    let fd = ensure_private_dir_exists_without_symlinks(path)?;
    ensure_private_dir_fd_owned_by(path, &fd, nix::unistd::geteuid().as_raw())
}

#[cfg(not(unix))]
pub async fn ensure_private_dir(path: &Path) -> RunnerResult<()> {
    tokio::fs::create_dir_all(path)
        .await
        .map_err(|e| RunnerError::Config(format!("create private dir {}: {e}", path.display())))
}

#[cfg(unix)]
fn reject_parent_dir_components(path: &Path) -> RunnerResult<()> {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(RunnerError::Config(format!(
            "{} contains a parent directory segment; refusing to use it as private runner state",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
async fn reject_existing_symlink_components(path: &Path) -> RunnerResult<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        let metadata = match tokio::fs::symlink_metadata(&current).await {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotADirectory => {
                return Err(RunnerError::Config(format!(
                    "{} is not a directory; refusing to use it as private runner state",
                    path.display()
                )));
            }
            Err(e) => {
                return Err(RunnerError::Config(format!(
                    "stat private dir component {}: {e}",
                    current.display()
                )));
            }
        };
        if metadata.file_type().is_symlink() {
            return Err(RunnerError::Config(format!(
                "{} contains symlink component {}; refusing to use it as private runner state",
                path.display(),
                current.display()
            )));
        }
    }
    Ok(())
}

#[cfg(unix)]
pub async fn write_private_file(path: &Path, content: &[u8]) -> RunnerResult<()> {
    use std::ffi::OsString;
    use std::os::unix::fs::PermissionsExt;
    use tokio::io::AsyncWriteExt;

    let file_name = path.file_name().ok_or_else(|| {
        RunnerError::Config(format!(
            "{} does not have a file name; refusing to write private file",
            path.display()
        ))
    })?;
    let mut tmp_name = OsString::from(".");
    tmp_name.push(file_name);
    tmp_name.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let tmp = path.with_file_name(tmp_name);

    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true).mode(PRIVATE_FILE_MODE);
    let mut file = options.open(&tmp).await.map_err(|e| {
        RunnerError::Config(format!("open private file tmp {}: {e}", tmp.display()))
    })?;
    tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(PRIVATE_FILE_MODE))
        .await
        .map_err(|e| {
            RunnerError::Config(format!("chmod private file tmp {}: {e}", tmp.display()))
        })?;
    file.write_all(content).await.map_err(|e| {
        RunnerError::Config(format!("write private file tmp {}: {e}", tmp.display()))
    })?;
    file.flush().await.map_err(|e| {
        RunnerError::Config(format!("flush private file tmp {}: {e}", tmp.display()))
    })?;
    drop(file);

    tokio::fs::rename(&tmp, path)
        .await
        .map_err(|e| RunnerError::Config(format!("rename private file {}: {e}", path.display())))?;
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(PRIVATE_FILE_MODE))
        .await
        .map_err(|e| RunnerError::Config(format!("chmod private file {}: {e}", path.display())))?;
    Ok(())
}

#[cfg(not(unix))]
pub async fn write_private_file(path: &Path, content: &[u8]) -> RunnerResult<()> {
    tokio::fs::write(path, content)
        .await
        .map_err(|e| RunnerError::Config(format!("write private file {}: {e}", path.display())))
}

#[cfg(unix)]
fn ensure_private_dir_exists_without_symlinks(path: &Path) -> RunnerResult<OwnedFd> {
    use nix::fcntl::open;
    use nix::sys::stat::Mode;

    if path.as_os_str().is_empty() {
        return Err(RunnerError::Config(format!(
            "{} does not name a directory; refusing to use it as private runner state",
            path.display()
        )));
    }

    let start = if path.is_absolute() {
        Path::new("/")
    } else {
        Path::new(".")
    };
    let mut current = open(start, private_dir_open_flags(), Mode::empty()).map_err(|e| {
        RunnerError::Config(format!("open private dir root for {}: {e}", path.display()))
    })?;
    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                return Err(RunnerError::Config(format!(
                    "{} contains a parent directory segment; refusing to use it as private runner state",
                    path.display()
                )));
            }
            Component::Normal(name) => {
                current = open_or_create_private_dir_component(&current, name, path)?;
            }
            Component::Prefix(prefix) => {
                return Err(RunnerError::Config(format!(
                    "{} contains unsupported path prefix {}; refusing to use it as private runner state",
                    path.display(),
                    prefix.as_os_str().to_string_lossy()
                )));
            }
        }
    }

    Ok(current)
}

#[cfg(unix)]
fn open_or_create_private_dir_component(
    parent: &impl AsFd,
    name: &OsStr,
    full_path: &Path,
) -> RunnerResult<OwnedFd> {
    use nix::errno::Errno;
    use nix::fcntl::openat;
    use nix::sys::stat::{Mode, mkdirat};

    match openat(parent, name, private_dir_open_flags(), Mode::empty()) {
        Ok(fd) => Ok(fd),
        Err(Errno::ENOENT) => {
            let created = match mkdirat(parent, name, Mode::from_bits_truncate(PRIVATE_DIR_MODE)) {
                Ok(()) => true,
                Err(Errno::EEXIST) => false,
                Err(e) => {
                    return Err(RunnerError::Config(format!(
                        "create private dir component {} for {}: {e}",
                        name.to_string_lossy(),
                        full_path.display()
                    )));
                }
            };
            let fd = openat(parent, name, private_dir_open_flags(), Mode::empty())
                .map_err(|e| private_dir_component_error("open", name, full_path, e))?;
            if created {
                chmod_open_private_dir(&fd, full_path)?;
            }
            Ok(fd)
        }
        Err(e) => Err(private_dir_component_error("open", name, full_path, e)),
    }
}

#[cfg(unix)]
fn private_dir_component_error(
    operation: &str,
    name: &OsStr,
    full_path: &Path,
    error: nix::errno::Errno,
) -> RunnerError {
    match error {
        nix::errno::Errno::ELOOP => RunnerError::Config(format!(
            "{} contains symlink component {}; refusing to use it as private runner state",
            full_path.display(),
            name.to_string_lossy()
        )),
        nix::errno::Errno::ENOTDIR => RunnerError::Config(format!(
            "{} is not a directory; refusing to use it as private runner state",
            full_path.display()
        )),
        _ => RunnerError::Config(format!(
            "{operation} private dir component {} for {}: {error}",
            name.to_string_lossy(),
            full_path.display()
        )),
    }
}

#[cfg(unix)]
fn ensure_private_dir_fd_owned_by(
    path: &Path,
    fd: &OwnedFd,
    expected_uid: u32,
) -> RunnerResult<()> {
    use nix::sys::stat::{SFlag, fstat};

    let stat = fstat(fd)
        .map_err(|e| RunnerError::Config(format!("stat private dir fd {}: {e}", path.display())))?;
    let fd_file_type = SFlag::from_bits_truncate(stat.st_mode & SFlag::S_IFMT.bits());
    if fd_file_type != SFlag::S_IFDIR {
        return Err(RunnerError::Config(format!(
            "{} is not a directory; refusing to use it as private runner state",
            path.display()
        )));
    }

    let actual_uid = stat.st_uid;
    if actual_uid != expected_uid {
        return Err(RunnerError::Config(format!(
            "{} is owned by uid {actual_uid}, but runner euid is {expected_uid}; fix ownership before starting the runner",
            path.display()
        )));
    }

    chmod_open_private_dir(fd, path)?;
    Ok(())
}

#[cfg(all(unix, target_os = "linux"))]
fn chmod_open_private_dir<Fd: std::os::fd::AsRawFd>(fd: &Fd, path: &Path) -> RunnerResult<()> {
    use std::os::unix::fs::PermissionsExt;

    let fd_path = PathBuf::from(format!("/proc/self/fd/{}", fd.as_raw_fd()));
    std::fs::set_permissions(&fd_path, std::fs::Permissions::from_mode(PRIVATE_DIR_MODE))
        .map_err(|e| RunnerError::Config(format!("chmod private dir {}: {e}", path.display())))
}

#[cfg(all(unix, not(target_os = "linux")))]
fn chmod_open_private_dir<Fd: std::os::fd::AsFd>(fd: &Fd, path: &Path) -> RunnerResult<()> {
    nix::sys::stat::fchmod(
        fd,
        nix::sys::stat::Mode::from_bits_truncate(PRIVATE_DIR_MODE),
    )
    .map_err(|e| RunnerError::Config(format!("chmod private dir {}: {e}", path.display())))
}

#[cfg(all(unix, target_os = "linux"))]
fn private_dir_open_flags() -> nix::fcntl::OFlag {
    nix::fcntl::OFlag::O_PATH
        | nix::fcntl::OFlag::O_DIRECTORY
        | nix::fcntl::OFlag::O_NOFOLLOW
        | nix::fcntl::OFlag::O_CLOEXEC
}

#[cfg(all(unix, not(target_os = "linux")))]
fn private_dir_open_flags() -> nix::fcntl::OFlag {
    nix::fcntl::OFlag::O_RDONLY
        | nix::fcntl::OFlag::O_DIRECTORY
        | nix::fcntl::OFlag::O_NOFOLLOW
        | nix::fcntl::OFlag::O_CLOEXEC
}

#[cfg(unix)]
fn reject_reserved_private_dir_path(path: &Path) -> RunnerResult<()> {
    let normalized = normalize_private_dir_policy_path(path)?;
    reject_reserved_normalized_private_dir_path(path, &normalized)
}

#[cfg(unix)]
fn normalize_private_dir_policy_path(path: &Path) -> RunnerResult<PathBuf> {
    let path = if path.is_relative() {
        std::env::current_dir()
            .map_err(|e| {
                RunnerError::Config(format!("resolve private dir {}: {e}", path.display()))
            })?
            .join(path)
    } else {
        path.to_path_buf()
    };
    Ok(normalize_path_lexically(&path))
}

#[cfg(test)]
#[cfg(unix)]
fn reject_reserved_private_dir_path_with_cwd(path: &Path, cwd: &Path) -> RunnerResult<()> {
    let normalized = normalize_path_lexically(&if path.is_relative() {
        cwd.join(path)
    } else {
        path.to_path_buf()
    });
    reject_reserved_normalized_private_dir_path(path, &normalized)
}

#[cfg(unix)]
fn reject_reserved_normalized_private_dir_path(
    original: &Path,
    normalized: &Path,
) -> RunnerResult<()> {
    if RESERVED_PRIVATE_DIR_PATHS
        .iter()
        .any(|reserved| normalized == Path::new(reserved))
        || RESERVED_PRIVATE_DIR_SUBTREES
            .iter()
            .any(|reserved| normalized.starts_with(Path::new(reserved)))
    {
        return Err(RunnerError::Config(format!(
            "{} is a reserved system path; refusing to use it as private runner state",
            original.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn normalize_path_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() && !normalized.has_root() {
                    normalized.push(component.as_os_str());
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    if normalized.as_os_str().is_empty() {
        path.to_path_buf()
    } else {
        normalized
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[tokio::test]
    async fn ensure_private_dir_creates_missing_dir_with_private_mode() {
        let dir = tempfile::tempdir().unwrap();
        let private_dir = dir.path().join("runner");

        ensure_private_dir(&private_dir).await.unwrap();

        assert_eq!(mode(&private_dir), PRIVATE_DIR_MODE);
    }

    #[tokio::test]
    async fn ensure_private_dir_creates_missing_nested_dir_with_private_mode() {
        let dir = tempfile::tempdir().unwrap();
        let private_dir = dir.path().join("nested").join("runner");

        ensure_private_dir(&private_dir).await.unwrap();

        assert_eq!(mode(&private_dir), PRIVATE_DIR_MODE);
    }

    #[tokio::test]
    async fn ensure_private_dir_rejects_filesystem_root() {
        let error = ensure_private_dir(Path::new("/")).await.unwrap_err();

        assert!(
            error.to_string().contains("reserved system path"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn ensure_private_dir_tightens_existing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let private_dir = dir.path().join("runner");
        std::fs::create_dir(&private_dir).unwrap();
        std::fs::set_permissions(&private_dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        ensure_private_dir(&private_dir).await.unwrap();

        assert_eq!(mode(&private_dir), PRIVATE_DIR_MODE);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn ensure_private_dir_repairs_unreadable_existing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let private_dir = dir.path().join("runner");
        std::fs::create_dir(&private_dir).unwrap();
        std::fs::set_permissions(&private_dir, std::fs::Permissions::from_mode(0o000)).unwrap();

        ensure_private_dir(&private_dir).await.unwrap();

        assert_eq!(mode(&private_dir), PRIVATE_DIR_MODE);
    }

    #[tokio::test]
    async fn ensure_private_dir_rejects_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let private_dir = dir.path().join("runner");
        std::fs::write(&private_dir, b"not a dir").unwrap();

        let error = ensure_private_dir(&private_dir).await.unwrap_err();

        assert!(
            error.to_string().contains("not a directory"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn ensure_private_dir_rejects_intermediate_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file");
        let private_dir = file.join("runner");
        std::fs::write(&file, b"not a dir").unwrap();

        let error = ensure_private_dir(&private_dir).await.unwrap_err();

        assert!(
            error.to_string().contains("not a directory"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn ensure_private_dir_rejects_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let private_dir = dir.path().join("runner");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &private_dir).unwrap();

        let error = ensure_private_dir(&private_dir).await.unwrap_err();

        assert!(
            error.to_string().contains("symlink"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn ensure_private_dir_rejects_symlink_with_trailing_separator() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let private_dir = dir.path().join("runner");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &private_dir).unwrap();
        let private_dir_with_separator = PathBuf::from(format!("{}/", private_dir.display()));

        let error = ensure_private_dir(&private_dir_with_separator)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("symlink"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn ensure_private_dir_rejects_intermediate_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("link");
        let private_dir = link.join("runner");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &link).unwrap();

        let error = ensure_private_dir(&private_dir).await.unwrap_err();

        assert!(
            error.to_string().contains("symlink component"),
            "unexpected error: {error}"
        );
        assert!(
            !target.join("runner").exists(),
            "private dir should not be created through an intermediate symlink"
        );
    }

    #[tokio::test]
    async fn ensure_private_dir_rejects_parent_segments_before_creating_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing-prefix");
        let private_dir = missing.join("..").join("runner");

        let error = ensure_private_dir(&private_dir).await.unwrap_err();

        assert!(
            error.to_string().contains("parent directory segment"),
            "unexpected error: {error}"
        );
        assert!(
            !missing.exists(),
            "private dir validation should not create path prefixes before rejecting parent segments"
        );
    }

    #[test]
    fn reserved_private_dir_path_rejects_lexical_parent_segments() {
        for path in ["/var/lib/../lib", "/..", "/var/../.."] {
            let error = reject_reserved_private_dir_path(Path::new(path))
                .expect_err("reserved path should be rejected");

            assert!(
                error.to_string().contains("reserved system path"),
                "unexpected error for {path}: {error}"
            );
        }
    }

    #[test]
    fn reserved_private_dir_path_rejects_relative_escape_from_cwd() {
        let cwd = Path::new("/var/lib/vm0-runner/runners/runner-01");

        for path in ["..", "../../.."] {
            let error = reject_reserved_private_dir_path_with_cwd(Path::new(path), cwd)
                .expect_err("reserved path should be rejected");

            assert!(
                error.to_string().contains("reserved system path"),
                "unexpected error for {path}: {error}"
            );
        }
    }

    #[test]
    fn reserved_private_dir_path_rejects_shared_home_subtrees() {
        for path in [
            "/var/lib/vm0-runner/images",
            "/var/lib/vm0-runner/images/rootfs-hash",
            "/var/lib/vm0-runner/locks/base-dir.lock",
            "/var/lib/vm0-runner/ca",
            "/var/lib/vm0-runner/storages/cache-entry",
        ] {
            let error = reject_reserved_private_dir_path(Path::new(path))
                .expect_err("shared home subtree should be rejected");

            assert!(
                error.to_string().contains("reserved system path"),
                "unexpected error for {path}: {error}"
            );
        }
    }

    #[test]
    fn reserved_private_dir_path_allows_runner_child_dir() {
        reject_reserved_private_dir_path(Path::new("/var/lib/vm0-runner/runners/runner-01"))
            .unwrap();
        reject_reserved_private_dir_path(Path::new("/data/runner-01")).unwrap();
    }

    #[tokio::test]
    async fn ensure_private_dir_rejects_owner_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let private_dir = dir.path().join("runner");
        std::fs::create_dir(&private_dir).unwrap();
        let actual_uid = std::fs::metadata(&private_dir).unwrap().uid();
        let mismatched_uid = if actual_uid == 0 { 1 } else { 0 };

        let fd = ensure_private_dir_exists_without_symlinks(&private_dir).unwrap();
        let error = ensure_private_dir_fd_owned_by(&private_dir, &fd, mismatched_uid).unwrap_err();

        assert!(
            error.to_string().contains("owned by uid"),
            "unexpected error: {error}"
        );
    }
}
