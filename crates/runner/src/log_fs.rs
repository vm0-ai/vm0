use std::path::{Component, Path, PathBuf};

use crate::error::{RunnerError, RunnerResult};

pub(crate) const LOG_DIR_MODE: u32 = 0o700;
pub(crate) const LOG_FILE_MODE: u32 = 0o600;
#[cfg(unix)]
const GROUP_OR_OTHER_WRITE_BITS: u32 = 0o022;
#[cfg(unix)]
const ROOT_UID: u32 = 0;
#[cfg(unix)]
const STICKY_BIT: u32 = 0o1000;

#[cfg(unix)]
pub(crate) fn ensure_log_dir_sync(dir: &Path) -> RunnerResult<()> {
    let expected_uid = nix::unistd::geteuid().as_raw();
    let fd = ensure_log_dir_exists_without_symlinks(dir, expected_uid)?;
    secure_open_log_dir(&fd, dir, expected_uid, true)
}

#[cfg(not(unix))]
pub(crate) fn ensure_log_dir_sync(dir: &Path) -> RunnerResult<()> {
    std::fs::create_dir_all(dir)
        .map_err(|e| RunnerError::Internal(format!("create logs_dir {}: {e}", dir.display())))
}

#[cfg(unix)]
pub(crate) async fn ensure_log_dir(dir: &Path) -> RunnerResult<()> {
    ensure_log_dir_sync(dir)
}

#[cfg(not(unix))]
pub(crate) async fn ensure_log_dir(dir: &Path) -> RunnerResult<()> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create logs_dir {}: {e}", dir.display())))
}

#[cfg(unix)]
pub(crate) fn secure_open_log_file_sync(file: &std::fs::File, path: &Path) -> std::io::Result<()> {
    secure_open_log_fd_sync(file, path)
}

#[cfg(unix)]
pub(crate) fn secure_open_log_fd_sync<Fd: std::os::fd::AsRawFd>(
    file: &Fd,
    path: &Path,
) -> std::io::Result<()> {
    let mut stat = std::mem::MaybeUninit::<nix::libc::stat>::uninit();
    // SAFETY: `stat` points to valid writable memory and `file` owns a live fd.
    let result = unsafe { nix::libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: successful `fstat` initialized the full `stat` struct.
    let stat = unsafe { stat.assume_init() };
    let file_type = stat.st_mode & nix::libc::S_IFMT;
    if file_type != nix::libc::S_IFREG {
        return Err(std::io::Error::other(format!(
            "{} is not a regular log file",
            path.display()
        )));
    }
    ensure_trusted_log_owner_io(path, stat.st_uid, nix::unistd::geteuid().as_raw())?;
    if stat.st_mode & 0o777 == LOG_FILE_MODE {
        return Ok(());
    }
    // SAFETY: `fchmod` operates on the live fd and does not affect Rust aliasing.
    let result = unsafe { nix::libc::fchmod(file.as_raw_fd(), LOG_FILE_MODE as nix::libc::mode_t) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(unix))]
pub(crate) fn secure_open_log_file_sync(
    _file: &std::fs::File,
    _path: &Path,
) -> std::io::Result<()> {
    Ok(())
}

#[cfg(not(unix))]
pub(crate) fn secure_open_log_fd_sync<Fd>(_file: &Fd, _path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
pub(crate) async fn secure_log_file(path: &Path) -> RunnerResult<()> {
    secure_log_file_sync(path)
}

#[cfg(not(unix))]
pub(crate) async fn secure_log_file(_path: &Path) -> RunnerResult<()> {
    Ok(())
}

#[cfg(unix)]
fn ensure_log_dir_exists_without_symlinks(
    path: &Path,
    expected_uid: u32,
) -> RunnerResult<std::os::fd::OwnedFd> {
    use nix::fcntl::open;
    use nix::sys::stat::Mode;

    if path.as_os_str().is_empty() {
        return Err(RunnerError::Internal(
            "empty logs_dir path is not a directory".to_string(),
        ));
    }

    let start = if path.is_absolute() {
        Path::new("/")
    } else {
        Path::new(".")
    };
    let mut current = open(start, log_dir_open_flags(), Mode::empty()).map_err(|e| {
        RunnerError::Internal(format!("open logs_dir root for {}: {e}", path.display()))
    })?;
    let mut current_path = start.to_path_buf();
    let mut saw_normal_component = false;
    let mut components = path.components().peekable();
    while let Some(component) = components.next() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                return Err(RunnerError::Internal(format!(
                    "{} contains a parent directory segment; refusing to use it as logs_dir",
                    path.display()
                )));
            }
            Component::Normal(name) => {
                saw_normal_component = true;
                let is_final = components.peek().is_none();
                current = open_or_create_log_dir_component(
                    &current,
                    name,
                    &current_path,
                    path,
                    expected_uid,
                    is_final,
                )?;
                current_path = log_dir_component_path(&current_path, name);
            }
            Component::Prefix(prefix) => {
                return Err(RunnerError::Internal(format!(
                    "{} contains unsupported path prefix {}; refusing to use it as logs_dir",
                    path.display(),
                    prefix.as_os_str().to_string_lossy()
                )));
            }
        }
    }

    if !saw_normal_component {
        return Err(RunnerError::Internal(format!(
            "{} does not name a logs_dir",
            path.display()
        )));
    }
    Ok(current)
}

#[cfg(unix)]
fn open_or_create_log_dir_component(
    parent: &(impl std::os::fd::AsFd + std::os::fd::AsRawFd),
    name: &std::ffi::OsStr,
    parent_path: &Path,
    full_path: &Path,
    expected_uid: u32,
    is_final: bool,
) -> RunnerResult<std::os::fd::OwnedFd> {
    use nix::errno::Errno;
    use nix::fcntl::openat;
    use nix::sys::stat::{Mode, mkdirat};

    ensure_log_dir_parent_not_replaceable(parent, parent_path, full_path, expected_uid)?;
    let component_path = log_dir_component_path(parent_path, name);
    match openat(parent, name, log_dir_open_flags(), Mode::empty()) {
        Ok(fd) => {
            secure_open_log_dir(&fd, &component_path, expected_uid, is_final)?;
            Ok(fd)
        }
        Err(Errno::ENOENT) => {
            let created = match mkdirat(parent, name, Mode::from_bits_truncate(LOG_DIR_MODE)) {
                Ok(()) => true,
                Err(Errno::EEXIST) => false,
                Err(e) => {
                    return Err(RunnerError::Internal(format!(
                        "create logs_dir component {} for {}: {e}",
                        name.to_string_lossy(),
                        full_path.display()
                    )));
                }
            };
            let fd = openat(parent, name, log_dir_open_flags(), Mode::empty())
                .map_err(|e| log_dir_component_error("open", name, full_path, e))?;
            secure_open_log_dir(&fd, &component_path, expected_uid, created || is_final)?;
            Ok(fd)
        }
        Err(e) => Err(log_dir_component_error("open", name, full_path, e)),
    }
}

#[cfg(unix)]
fn ensure_log_dir_parent_not_replaceable(
    parent: &(impl std::os::fd::AsFd + std::os::fd::AsRawFd),
    parent_path: &Path,
    full_path: &Path,
    expected_uid: u32,
) -> RunnerResult<()> {
    use nix::sys::stat::{SFlag, fstat};

    let stat = fstat(parent).map_err(|e| {
        RunnerError::Internal(format!(
            "stat logs_dir parent {} for {}: {e}",
            parent_path.display(),
            full_path.display()
        ))
    })?;
    let file_type = SFlag::from_bits_truncate(stat.st_mode & SFlag::S_IFMT.bits());
    if file_type != SFlag::S_IFDIR {
        return Err(RunnerError::Internal(format!(
            "{} is not a logs_dir parent",
            parent_path.display()
        )));
    }
    ensure_trusted_log_owner(parent_path, stat.st_uid, expected_uid)?;
    let mode = (stat.st_mode as u32) & 0o7777;
    if mode & GROUP_OR_OTHER_WRITE_BITS != 0 && mode & STICKY_BIT == 0 {
        return Err(RunnerError::Internal(format!(
            "logs_dir parent {} is group/other writable without the sticky bit; fix parent permissions before starting the runner",
            parent_path.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn secure_open_log_dir(
    fd: &std::os::fd::OwnedFd,
    dir: &Path,
    expected_uid: u32,
    enforce_private_mode: bool,
) -> RunnerResult<()> {
    use nix::sys::stat::{SFlag, fstat};

    let stat = fstat(fd)
        .map_err(|e| RunnerError::Internal(format!("stat logs_dir {}: {e}", dir.display())))?;
    let file_type = SFlag::from_bits_truncate(stat.st_mode & SFlag::S_IFMT.bits());
    if file_type != SFlag::S_IFDIR {
        return Err(RunnerError::Internal(format!(
            "{} is not a logs_dir",
            dir.display()
        )));
    }
    ensure_trusted_log_owner(dir, stat.st_uid, expected_uid)?;
    if enforce_private_mode && (stat.st_mode as u32) & 0o777 != LOG_DIR_MODE {
        chmod_open_log_dir(fd, dir)?;
    }
    Ok(())
}

#[cfg(unix)]
fn log_dir_component_path(parent: &Path, name: &std::ffi::OsStr) -> PathBuf {
    let mut path = parent.to_path_buf();
    path.push(Path::new(name));
    path
}

#[cfg(unix)]
fn log_dir_component_error(
    operation: &str,
    name: &std::ffi::OsStr,
    full_path: &Path,
    error: nix::errno::Errno,
) -> RunnerError {
    match error {
        nix::errno::Errno::ELOOP => RunnerError::Internal(format!(
            "{} contains symlink component {}; refusing to use it as logs_dir",
            full_path.display(),
            name.to_string_lossy()
        )),
        nix::errno::Errno::ENOTDIR => {
            RunnerError::Internal(format!("{} is not a logs_dir", full_path.display()))
        }
        _ => RunnerError::Internal(format!(
            "{operation} logs_dir component {} for {}: {error}",
            name.to_string_lossy(),
            full_path.display()
        )),
    }
}

#[cfg(all(unix, target_os = "linux"))]
fn log_dir_open_flags() -> nix::fcntl::OFlag {
    nix::fcntl::OFlag::O_PATH
        | nix::fcntl::OFlag::O_DIRECTORY
        | nix::fcntl::OFlag::O_NOFOLLOW
        | nix::fcntl::OFlag::O_CLOEXEC
}

#[cfg(all(unix, not(target_os = "linux")))]
fn log_dir_open_flags() -> nix::fcntl::OFlag {
    nix::fcntl::OFlag::O_RDONLY
        | nix::fcntl::OFlag::O_DIRECTORY
        | nix::fcntl::OFlag::O_NOFOLLOW
        | nix::fcntl::OFlag::O_CLOEXEC
}

#[cfg(all(unix, target_os = "linux"))]
fn chmod_open_log_dir<Fd: std::os::fd::AsRawFd>(fd: &Fd, path: &Path) -> RunnerResult<()> {
    use std::os::unix::fs::PermissionsExt;

    let fd_path = PathBuf::from(format!("/proc/self/fd/{}", fd.as_raw_fd()));
    std::fs::set_permissions(&fd_path, std::fs::Permissions::from_mode(LOG_DIR_MODE))
        .map_err(|e| RunnerError::Internal(format!("chmod logs_dir {}: {e}", path.display())))
}

#[cfg(all(unix, not(target_os = "linux")))]
fn chmod_open_log_dir<Fd: std::os::fd::AsFd>(fd: &Fd, path: &Path) -> RunnerResult<()> {
    nix::sys::stat::fchmod(fd, nix::sys::stat::Mode::from_bits_truncate(LOG_DIR_MODE))
        .map_err(|e| RunnerError::Internal(format!("chmod logs_dir {}: {e}", path.display())))
}

#[cfg(unix)]
fn secure_log_file_sync(path: &Path) -> RunnerResult<()> {
    use nix::fcntl::open;
    use nix::sys::stat::Mode;

    let fd = open(path, log_file_open_flags(), Mode::empty()).map_err(|e| {
        RunnerError::Internal(format!(
            "open log file {} without following symlinks: {e}",
            path.display()
        ))
    })?;
    secure_open_log_file_fd(&fd, path)
}

#[cfg(unix)]
fn secure_open_log_file_fd(fd: &std::os::fd::OwnedFd, path: &Path) -> RunnerResult<()> {
    use nix::sys::stat::{SFlag, fstat};

    let stat = fstat(fd)
        .map_err(|e| RunnerError::Internal(format!("stat log file {}: {e}", path.display())))?;
    let file_type = SFlag::from_bits_truncate(stat.st_mode & SFlag::S_IFMT.bits());
    if file_type != SFlag::S_IFREG {
        return Err(RunnerError::Internal(format!(
            "{} is not a regular log file",
            path.display()
        )));
    }
    ensure_trusted_log_owner(path, stat.st_uid, nix::unistd::geteuid().as_raw())?;
    if (stat.st_mode as u32) & 0o777 != LOG_FILE_MODE {
        chmod_open_log_file(fd, path)?;
    }
    Ok(())
}

#[cfg(all(unix, target_os = "linux"))]
fn log_file_open_flags() -> nix::fcntl::OFlag {
    nix::fcntl::OFlag::O_PATH | nix::fcntl::OFlag::O_NOFOLLOW | nix::fcntl::OFlag::O_CLOEXEC
}

#[cfg(all(unix, not(target_os = "linux")))]
fn log_file_open_flags() -> nix::fcntl::OFlag {
    nix::fcntl::OFlag::O_RDONLY | nix::fcntl::OFlag::O_NOFOLLOW | nix::fcntl::OFlag::O_CLOEXEC
}

#[cfg(all(unix, target_os = "linux"))]
fn chmod_open_log_file<Fd: std::os::fd::AsRawFd>(fd: &Fd, path: &Path) -> RunnerResult<()> {
    use std::os::unix::fs::PermissionsExt;

    let fd_path = PathBuf::from(format!("/proc/self/fd/{}", fd.as_raw_fd()));
    std::fs::set_permissions(&fd_path, std::fs::Permissions::from_mode(LOG_FILE_MODE))
        .map_err(|e| RunnerError::Internal(format!("chmod log file {}: {e}", path.display())))
}

#[cfg(all(unix, not(target_os = "linux")))]
fn chmod_open_log_file<Fd: std::os::fd::AsFd>(fd: &Fd, path: &Path) -> RunnerResult<()> {
    nix::sys::stat::fchmod(fd, nix::sys::stat::Mode::from_bits_truncate(LOG_FILE_MODE))
        .map_err(|e| RunnerError::Internal(format!("chmod log file {}: {e}", path.display())))
}

#[cfg(unix)]
fn ensure_trusted_log_owner(path: &Path, owner_uid: u32, expected_uid: u32) -> RunnerResult<()> {
    if !is_trusted_log_owner(owner_uid, expected_uid) {
        return Err(RunnerError::Internal(format!(
            "{} is owned by untrusted uid {owner_uid}; fix ownership before starting the runner",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn ensure_trusted_log_owner_io(
    path: &Path,
    owner_uid: u32,
    expected_uid: u32,
) -> std::io::Result<()> {
    if !is_trusted_log_owner(owner_uid, expected_uid) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!(
                "{} is owned by untrusted uid {owner_uid}; fix ownership before starting the runner",
                path.display()
            ),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn is_trusted_log_owner(owner_uid: u32, expected_uid: u32) -> bool {
    owner_uid == ROOT_UID || owner_uid == expected_uid
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn ensure_log_dir_sync_creates_private_dir() {
        let dir = tempfile::tempdir().unwrap();
        let logs_dir = dir.path().join("logs");

        ensure_log_dir_sync(&logs_dir).unwrap();

        assert_eq!(mode(&logs_dir), LOG_DIR_MODE);
    }

    #[tokio::test]
    async fn ensure_log_dir_tightens_existing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let logs_dir = dir.path().join("logs");
        std::fs::create_dir(&logs_dir).unwrap();
        std::fs::set_permissions(&logs_dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        ensure_log_dir(&logs_dir).await.unwrap();

        assert_eq!(mode(&logs_dir), LOG_DIR_MODE);
    }

    #[test]
    fn ensure_log_dir_sync_rejects_symlink_component() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("link");
        std::fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let error = ensure_log_dir_sync(&link.join("logs")).unwrap_err();

        assert!(
            error.to_string().contains("logs_dir"),
            "unexpected error: {error}"
        );
        assert!(!target.join("logs").exists());
    }

    #[test]
    fn trusted_log_owner_allows_root_or_current_user_only() {
        assert!(is_trusted_log_owner(0, 1000));
        assert!(is_trusted_log_owner(1000, 1000));
        assert!(!is_trusted_log_owner(1001, 1000));
    }

    #[tokio::test]
    async fn secure_log_file_tightens_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let log_file = dir.path().join("network.jsonl");
        std::fs::write(&log_file, "{}\n").unwrap();
        std::fs::set_permissions(&log_file, std::fs::Permissions::from_mode(0o644)).unwrap();

        secure_log_file(&log_file).await.unwrap();

        assert_eq!(mode(&log_file), LOG_FILE_MODE);
    }

    #[test]
    fn secure_open_log_file_checks_open_fd_after_path_replacement() {
        use nix::unistd::{Uid, chown};

        if !nix::unistd::geteuid().is_root() {
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        let log_file = dir.path().join("network.jsonl");
        std::fs::write(&log_file, "{}\n").unwrap();
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&log_file)
            .unwrap();
        chown(&log_file, Some(Uid::from_raw(1)), None).unwrap();
        std::fs::remove_file(&log_file).unwrap();
        std::fs::write(&log_file, "{}\n").unwrap();
        std::fs::set_permissions(&log_file, std::fs::Permissions::from_mode(0o644)).unwrap();

        let error = secure_open_log_file_sync(&file, &log_file).unwrap_err();

        assert!(
            error.to_string().contains("untrusted uid"),
            "unexpected error: {error}"
        );
        assert_eq!(mode(&log_file), 0o644);
    }

    #[tokio::test]
    async fn secure_log_file_rejects_symlink_without_chmodding_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.log");
        let link = dir.path().join("link.log");
        std::fs::write(&target, "secret\n").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let error = secure_log_file(&link).await.unwrap_err();

        assert!(
            error.to_string().contains("regular log file")
                || error.to_string().contains("without following symlinks"),
            "unexpected error: {error}"
        );
        assert_eq!(mode(&target), 0o644);
    }

    #[test]
    fn secure_log_file_rejects_fifo_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stdout.log");
        let c_path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
        assert_eq!(
            result,
            0,
            "mkfifo failed: {}",
            std::io::Error::last_os_error()
        );

        let (tx, rx) = std::sync::mpsc::channel();
        let path_for_thread = path.clone();
        std::thread::spawn(move || {
            let result = secure_log_file_sync(&path_for_thread).map_err(|e| e.to_string());
            let _ = tx.send(result);
        });
        let error = rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("secure_log_file_sync should not block on FIFO")
            .unwrap_err();

        assert!(
            error.contains("regular log file"),
            "unexpected error: {error}"
        );
    }
}
