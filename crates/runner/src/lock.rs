use std::fs::File;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

use nix::fcntl::{Flock, FlockArg};

use crate::error::{RunnerError, RunnerResult};

const LOCK_BUSY_ERROR: &str = "lock is already held by another process";
const GROUP_OR_OTHER_WRITE_BITS: u32 = 0o022;
const LOCK_DIR_MODE: u32 = 0o755;
const LOCK_FILE_MODE: u32 = 0o600;
const OWNER_DIRECTORY_BITS: u32 = 0o700;
const ROOT_UID: u32 = 0;

/// Open (or create) the lock file, creating parent directories as needed.
pub(crate) fn open_lock_file(path: &Path) -> RunnerResult<File> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        ensure_lock_parent_dir(parent)?;
    }
    let mut options = File::options();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(LOCK_FILE_MODE)
            .custom_flags(nix::libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|e| RunnerError::Internal(format!("open lock {}: {e}", path.display())))?;
    secure_lock_file_permissions(&file, path)?;
    Ok(file)
}

#[cfg(unix)]
fn ensure_lock_parent_dir(parent: &Path) -> RunnerResult<()> {
    let expected_uid = nix::unistd::geteuid().as_raw();
    let fd = ensure_lock_parent_dir_exists_without_symlinks(parent, expected_uid)?;
    secure_open_lock_parent_dir(&fd, parent, expected_uid)
}

#[cfg(not(unix))]
fn ensure_lock_parent_dir(parent: &Path) -> RunnerResult<()> {
    std::fs::create_dir_all(parent)
        .map_err(|e| RunnerError::Internal(format!("create lock dir {}: {e}", parent.display())))?;
    secure_lock_parent_dir_permissions(parent)
}

#[cfg(unix)]
fn ensure_lock_parent_dir_exists_without_symlinks(
    parent: &Path,
    expected_uid: u32,
) -> RunnerResult<OwnedFd> {
    use nix::fcntl::open;
    use nix::sys::stat::Mode;

    let start = if parent.is_absolute() {
        Path::new("/")
    } else {
        Path::new(".")
    };
    let mut current = open(start, lock_parent_dir_open_flags(), Mode::empty()).map_err(|e| {
        RunnerError::Internal(format!("open lock dir root for {}: {e}", parent.display()))
    })?;
    let mut current_path = start.to_path_buf();
    let components: Vec<_> = parent
        .components()
        .filter_map(|component| match component {
            Component::RootDir | Component::CurDir => None,
            Component::Normal(name) => Some(Ok(name.to_owned())),
            Component::ParentDir => Some(Err(RunnerError::Internal(format!(
                "lock dir {} contains a parent directory segment",
                parent.display()
            )))),
            Component::Prefix(prefix) => Some(Err(RunnerError::Internal(format!(
                "lock dir {} contains unsupported path prefix {}",
                parent.display(),
                prefix.as_os_str().to_string_lossy()
            )))),
        })
        .collect::<RunnerResult<Vec<_>>>()?;

    for name in &components {
        ensure_lock_dir_parent_not_replaceable(&current, &current_path, parent, expected_uid)?;
        current = open_or_create_lock_dir_component(&current, name, &current_path, parent)?;
        current_path = lock_dir_component_path(&current_path, name);
    }

    Ok(current)
}

#[cfg(unix)]
fn ensure_lock_dir_parent_not_replaceable(
    fd: &(impl AsFd + AsRawFd),
    current_path: &Path,
    full_parent: &Path,
    expected_uid: u32,
) -> RunnerResult<()> {
    use nix::sys::stat::fstat;

    let stat = fstat(fd).map_err(|e| {
        RunnerError::Internal(format!(
            "stat lock dir parent {} for {}: {e}",
            current_path.display(),
            full_parent.display()
        ))
    })?;
    ensure_trusted_lock_parent_dir_owner(current_path, stat.st_uid, expected_uid)?;
    let mode = (stat.st_mode as u32) & 0o7777;
    if mode & GROUP_OR_OTHER_WRITE_BITS != 0 && mode & 0o1000 == 0 {
        return Err(RunnerError::Internal(format!(
            "lock dir parent {} is group/other writable without the sticky bit; fix parent permissions before acquiring locks",
            current_path.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn open_or_create_lock_dir_component(
    parent_fd: &(impl AsFd + AsRawFd),
    name: &std::ffi::OsStr,
    current_path: &Path,
    full_parent: &Path,
) -> RunnerResult<OwnedFd> {
    use nix::errno::Errno;
    use nix::fcntl::openat;
    use nix::sys::stat::{Mode, mkdirat};

    match openat(parent_fd, name, lock_parent_dir_open_flags(), Mode::empty()) {
        Ok(fd) => Ok(fd),
        Err(Errno::ENOENT) => {
            let created = match mkdirat(parent_fd, name, Mode::from_bits_truncate(LOCK_DIR_MODE)) {
                Ok(()) => true,
                Err(Errno::EEXIST) => false,
                Err(e) => {
                    return Err(RunnerError::Internal(format!(
                        "create lock dir component {} for {}: {e}",
                        name.to_string_lossy(),
                        full_parent.display()
                    )));
                }
            };
            let fd = openat(parent_fd, name, lock_parent_dir_open_flags(), Mode::empty())
                .map_err(|e| lock_dir_component_error("open", name, full_parent, e))?;
            if created {
                chmod_open_lock_parent_dir(
                    &fd,
                    &lock_dir_component_path(current_path, name),
                    LOCK_DIR_MODE,
                )?;
            }
            Ok(fd)
        }
        Err(e) => Err(lock_dir_component_error("open", name, full_parent, e)),
    }
}

#[cfg(unix)]
fn lock_dir_component_path(parent: &Path, name: &std::ffi::OsStr) -> PathBuf {
    let mut path = parent.to_path_buf();
    path.push(Path::new(name));
    path
}

#[cfg(unix)]
fn lock_dir_component_error(
    operation: &str,
    name: &std::ffi::OsStr,
    full_parent: &Path,
    error: nix::errno::Errno,
) -> RunnerError {
    match error {
        nix::errno::Errno::ELOOP => RunnerError::Internal(format!(
            "{} contains symlink component {}; refusing to use it as a lock directory",
            full_parent.display(),
            name.to_string_lossy()
        )),
        nix::errno::Errno::ENOTDIR => {
            RunnerError::Internal(format!("{} is not a lock directory", full_parent.display()))
        }
        _ => RunnerError::Internal(format!(
            "{operation} lock dir component {} for {}: {error}",
            name.to_string_lossy(),
            full_parent.display()
        )),
    }
}

#[cfg(unix)]
fn secure_open_lock_parent_dir(fd: &OwnedFd, parent: &Path, expected_uid: u32) -> RunnerResult<()> {
    use nix::sys::stat::{SFlag, fstat};

    let stat = fstat(fd)
        .map_err(|e| RunnerError::Internal(format!("stat lock dir {}: {e}", parent.display())))?;
    let file_type = SFlag::from_bits_truncate(stat.st_mode & SFlag::S_IFMT.bits());
    if file_type != SFlag::S_IFDIR {
        return Err(RunnerError::Internal(format!(
            "{} is not a lock directory",
            parent.display()
        )));
    }
    ensure_trusted_lock_parent_dir_owner(parent, stat.st_uid, expected_uid)?;

    let current_mode = (stat.st_mode as u32) & 0o7777;
    let secure_mode = if current_mode & 0o1000 == 0 {
        (current_mode | OWNER_DIRECTORY_BITS) & !GROUP_OR_OTHER_WRITE_BITS
    } else {
        current_mode | OWNER_DIRECTORY_BITS
    };
    if secure_mode != current_mode {
        chmod_open_lock_parent_dir(fd, parent, secure_mode)?;
    }
    Ok(())
}

#[cfg(unix)]
fn ensure_trusted_lock_parent_dir_owner(
    parent: &Path,
    owner_uid: u32,
    expected_uid: u32,
) -> RunnerResult<()> {
    if owner_uid != ROOT_UID && owner_uid != expected_uid {
        return Err(RunnerError::Internal(format!(
            "lock dir {} is owned by untrusted uid {owner_uid}; fix ownership before acquiring locks",
            parent.display()
        )));
    }
    Ok(())
}

#[cfg(not(unix))]
fn secure_lock_parent_dir_permissions(parent: &Path) -> RunnerResult<()> {
    let metadata = std::fs::metadata(parent)
        .map_err(|e| RunnerError::Internal(format!("stat lock dir {}: {e}", parent.display())))?;
    if !metadata.is_dir() {
        return Err(RunnerError::Internal(format!(
            "{} is not a lock directory",
            parent.display()
        )));
    }
    Ok(())
}

#[cfg(all(unix, target_os = "linux"))]
fn lock_parent_dir_open_flags() -> nix::fcntl::OFlag {
    nix::fcntl::OFlag::O_PATH
        | nix::fcntl::OFlag::O_DIRECTORY
        | nix::fcntl::OFlag::O_NOFOLLOW
        | nix::fcntl::OFlag::O_CLOEXEC
}

#[cfg(all(unix, not(target_os = "linux")))]
fn lock_parent_dir_open_flags() -> nix::fcntl::OFlag {
    nix::fcntl::OFlag::O_RDONLY
        | nix::fcntl::OFlag::O_DIRECTORY
        | nix::fcntl::OFlag::O_NOFOLLOW
        | nix::fcntl::OFlag::O_CLOEXEC
}

#[cfg(all(unix, target_os = "linux"))]
fn chmod_open_lock_parent_dir<Fd: std::os::fd::AsRawFd>(
    fd: &Fd,
    parent: &Path,
    mode: u32,
) -> RunnerResult<()> {
    use std::os::unix::fs::PermissionsExt;

    let fd_path = PathBuf::from(format!("/proc/self/fd/{}", fd.as_raw_fd()));
    std::fs::set_permissions(&fd_path, std::fs::Permissions::from_mode(mode))
        .map_err(|e| RunnerError::Internal(format!("chmod lock dir {}: {e}", parent.display())))
}

#[cfg(all(unix, not(target_os = "linux")))]
fn chmod_open_lock_parent_dir<Fd: std::os::fd::AsFd>(
    fd: &Fd,
    parent: &Path,
    mode: u32,
) -> RunnerResult<()> {
    nix::sys::stat::fchmod(fd, nix::sys::stat::Mode::from_bits_truncate(mode))
        .map_err(|e| RunnerError::Internal(format!("chmod lock dir {}: {e}", parent.display())))
}

#[cfg(unix)]
fn secure_lock_file_permissions(file: &File, path: &Path) -> RunnerResult<()> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = file
        .metadata()
        .map_err(|e| RunnerError::Internal(format!("stat lock {}: {e}", path.display())))?;
    if !metadata.file_type().is_file() {
        return Err(RunnerError::Internal(format!(
            "{} is not a regular lock file",
            path.display()
        )));
    }
    ensure_trusted_lock_file_owner(path, metadata.uid(), nix::unistd::geteuid().as_raw())?;
    file.set_permissions(std::fs::Permissions::from_mode(LOCK_FILE_MODE))
        .map_err(|e| RunnerError::Internal(format!("chmod lock {}: {e}", path.display())))
}

#[cfg(unix)]
fn ensure_trusted_lock_file_owner(
    path: &Path,
    owner_uid: u32,
    expected_uid: u32,
) -> RunnerResult<()> {
    if owner_uid != ROOT_UID && owner_uid != expected_uid {
        return Err(RunnerError::Internal(format!(
            "lock {} is owned by untrusted uid {owner_uid}; fix ownership before acquiring locks",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(not(unix))]
fn secure_lock_file_permissions(_file: &File, _path: &Path) -> RunnerResult<()> {
    Ok(())
}

/// Check whether the locked fd still refers to the file currently at `path`.
///
/// Returns `false` if the file was unlinked and recreated (stale inode),
/// meaning the caller should retry lock acquisition.
fn is_current_inode(lock: &Flock<File>, path: &Path) -> bool {
    let Ok(lock_meta) = lock.metadata() else {
        return true;
    };
    let Ok(path_meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    lock_meta.dev() == path_meta.dev() && lock_meta.ino() == path_meta.ino()
}

#[derive(Clone, Copy)]
enum LockMode {
    Exclusive,
    Shared,
    TryExclusive,
}

impl LockMode {
    fn arg(self) -> FlockArg {
        match self {
            Self::Exclusive => FlockArg::LockExclusive,
            Self::Shared => FlockArg::LockShared,
            Self::TryExclusive => FlockArg::LockExclusiveNonblock,
        }
    }

    fn map_error(self, path: &Path, e: nix::errno::Errno) -> RunnerError {
        RunnerError::Internal(format!("flock {}: {e}", path.display()))
    }
}

pub(crate) enum TryLock {
    Acquired(Flock<File>),
    Busy,
}

enum LockAcquire {
    Acquired(Flock<File>),
    Busy,
}

async fn acquire_result_with(path: PathBuf, mode: LockMode) -> RunnerResult<LockAcquire> {
    tokio::task::spawn_blocking(move || {
        loop {
            let file = open_lock_file(&path)?;
            let lock = match Flock::lock(file, mode.arg()) {
                Ok(lock) => lock,
                Err((_file, e))
                    if matches!(mode, LockMode::TryExclusive)
                        && e == nix::errno::Errno::EWOULDBLOCK =>
                {
                    return Ok(LockAcquire::Busy);
                }
                Err((_file, e)) => return Err(mode.map_error(&path, e)),
            };
            if is_current_inode(&lock, &path) {
                return Ok(LockAcquire::Acquired(lock));
            }
        }
    })
    .await
    .map_err(|e| RunnerError::Internal(format!("lock task: {e}")))?
}

async fn acquire_with(path: PathBuf, mode: LockMode) -> RunnerResult<Flock<File>> {
    match acquire_result_with(path, mode).await? {
        LockAcquire::Acquired(lock) => Ok(lock),
        LockAcquire::Busy => Err(RunnerError::Config(LOCK_BUSY_ERROR.into())),
    }
}

/// Acquire an exclusive flock on the given path, blocking until available.
///
/// The returned guard holds the lock until dropped.
pub async fn acquire(path: PathBuf) -> RunnerResult<Flock<File>> {
    acquire_with(path, LockMode::Exclusive).await
}

/// Acquire a shared flock on the given path, blocking until available.
///
/// Multiple shared locks can coexist; only exclusive locks conflict.
/// The returned guard holds the lock until dropped.
pub async fn acquire_shared(path: PathBuf) -> RunnerResult<Flock<File>> {
    acquire_with(path, LockMode::Shared).await
}

/// Try to acquire an exclusive flock, returning an error immediately if held by another process.
///
/// The returned guard holds the lock until dropped.
pub async fn try_acquire(path: PathBuf) -> RunnerResult<Flock<File>> {
    acquire_with(path, LockMode::TryExclusive).await
}

pub async fn try_acquire_or_busy(path: PathBuf) -> RunnerResult<TryLock> {
    match acquire_result_with(path, LockMode::TryExclusive).await? {
        LockAcquire::Acquired(lock) => Ok(TryLock::Acquired(lock)),
        LockAcquire::Busy => Ok(TryLock::Busy),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn file_mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn assert_secure_lock_dir(path: &Path) {
        let mode = file_mode(path);
        assert_eq!(
            mode & GROUP_OR_OTHER_WRITE_BITS,
            0,
            "{} should not be group/other writable: {mode:o}",
            path.display()
        );
        assert_eq!(
            mode & OWNER_DIRECTORY_BITS,
            OWNER_DIRECTORY_BITS,
            "{} should preserve owner rwx access: {mode:o}",
            path.display()
        );
    }

    #[tokio::test]
    async fn acquire_creates_lock_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let guard = acquire(path.clone()).await.unwrap();
        assert!(path.exists());
        drop(guard);
    }

    #[tokio::test]
    async fn acquire_creates_private_lock_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let guard = acquire(path.clone()).await.unwrap();

        assert_eq!(file_mode(&path), LOCK_FILE_MODE);
        drop(guard);
    }

    #[tokio::test]
    async fn acquire_tightens_existing_wide_lock_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");
        std::fs::write(&path, b"lock").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();

        let guard = acquire(path.clone()).await.unwrap();

        assert_eq!(file_mode(&path), LOCK_FILE_MODE);
        drop(guard);
    }

    #[tokio::test]
    async fn acquire_rejects_lock_symlink_without_chmodding_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let path = dir.path().join("test.lock");
        std::fs::write(&target, b"target").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        symlink(&target, &path).unwrap();

        let error = acquire(path).await.unwrap_err();

        assert!(
            error.to_string().contains("open lock"),
            "unexpected error: {error}"
        );
        assert_eq!(file_mode(&target), 0o644);
    }

    #[test]
    fn current_inode_rejects_symlink_replacement_to_same_inode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");
        let target = dir.path().join("held.lock");
        std::fs::write(&path, b"lock").unwrap();
        let file = open_lock_file(&path).unwrap();
        let lock = Flock::lock(file, FlockArg::LockExclusiveNonblock).unwrap();
        std::fs::rename(&path, &target).unwrap();
        symlink(&target, &path).unwrap();

        assert!(!is_current_inode(&lock, &path));
    }

    #[tokio::test]
    async fn acquire_rejects_non_regular_lock_file() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");
        let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
        let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
        assert_eq!(
            result,
            0,
            "mkfifo failed: {}",
            std::io::Error::last_os_error()
        );

        let error = acquire(path).await.unwrap_err();

        assert!(
            error.to_string().contains("not a regular lock file"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn held_lock_blocks_nonblocking_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        // Hold the lock via acquire().
        let _guard = acquire(path.clone()).await.unwrap();

        // A non-blocking attempt on the same file must fail with EWOULDBLOCK.
        let file = std::fs::File::options()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let err = Flock::lock(file, FlockArg::LockExclusiveNonblock).unwrap_err();
        assert_eq!(err.1, nix::errno::Errno::EWOULDBLOCK);
    }

    #[tokio::test]
    async fn lock_released_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let guard = acquire(path.clone()).await.unwrap();
        drop(guard);

        // After drop, a non-blocking lock should succeed.
        let file = std::fs::File::options()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let _lock = Flock::lock(file, FlockArg::LockExclusiveNonblock).unwrap();
    }

    #[tokio::test]
    async fn acquire_creates_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a").join("b").join("test.lock");

        let guard = acquire(path.clone()).await.unwrap();

        assert!(path.exists());
        assert_secure_lock_dir(&dir.path().join("a"));
        assert_secure_lock_dir(&dir.path().join("a").join("b"));
        drop(guard);
    }

    #[tokio::test]
    async fn acquire_tightens_existing_wide_parent_directory() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("locks");
        let path = parent.join("test.lock");
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o777)).unwrap();

        let guard = acquire(path).await.unwrap();

        assert_secure_lock_dir(&parent);
        drop(guard);
    }

    #[tokio::test]
    async fn acquire_preserves_sticky_lock_parent_directory_mode() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("sticky-locks");
        let path = parent.join("test.lock");
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o1777)).unwrap();

        let guard = acquire(path).await.unwrap();

        let mode = std::fs::metadata(&parent).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode, 0o1777);
        drop(guard);
    }

    #[tokio::test]
    async fn acquire_rejects_lock_parent_symlink_without_chmodding_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let parent = dir.path().join("locks");
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o777)).unwrap();
        symlink(&target, &parent).unwrap();

        let error = acquire(parent.join("test.lock")).await.unwrap_err();

        let message = error.to_string();
        assert!(
            message.contains("symlink component") || message.contains("not a lock directory"),
            "unexpected error: {error}"
        );
        assert_eq!(file_mode(&target), 0o777);
    }

    #[tokio::test]
    async fn acquire_rejects_intermediate_lock_parent_symlink_without_creating_target_child() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("link");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &link).unwrap();
        let path = link.join("locks").join("test.lock");

        let error = acquire(path).await.unwrap_err();

        let message = error.to_string();
        assert!(
            message.contains("symlink component") || message.contains("not a lock directory"),
            "unexpected error: {error}"
        );
        assert!(
            !target.join("locks").exists(),
            "lock parent should not be created through an intermediate symlink"
        );
    }

    #[tokio::test]
    async fn acquire_rejects_replaceable_lock_parent_ancestor() {
        let dir = tempfile::tempdir().unwrap();
        let ancestor = dir.path().join("shared");
        std::fs::create_dir(&ancestor).unwrap();
        std::fs::set_permissions(&ancestor, std::fs::Permissions::from_mode(0o777)).unwrap();
        let path = ancestor.join("locks").join("test.lock");

        let error = acquire(path).await.unwrap_err();

        assert!(
            error.to_string().contains("group/other writable"),
            "unexpected error: {error}"
        );
        assert!(
            !ancestor.join("locks").exists(),
            "lock parent should not be created under a replaceable ancestor"
        );
    }

    #[test]
    fn lock_parent_dir_owner_must_be_current_user_or_root() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("locks");

        ensure_trusted_lock_parent_dir_owner(&path, 0, 1000).unwrap();
        ensure_trusted_lock_parent_dir_owner(&path, 1000, 1000).unwrap();
        let error = ensure_trusted_lock_parent_dir_owner(&path, 1001, 1000).unwrap_err();

        assert!(
            error.to_string().contains("untrusted uid"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn lock_file_owner_must_be_current_user_or_root() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        ensure_trusted_lock_file_owner(&path, 0, 1000).unwrap();
        ensure_trusted_lock_file_owner(&path, 1000, 1000).unwrap();
        let error = ensure_trusted_lock_file_owner(&path, 1001, 1000).unwrap_err();

        assert!(
            error.to_string().contains("untrusted uid"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn try_acquire_fails_when_held() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let _guard = acquire(path.clone()).await.unwrap();
        let err = try_acquire(path).await.unwrap_err();
        assert!(err.to_string().contains("already held by another process"));
    }

    #[tokio::test]
    async fn try_acquire_succeeds_when_free() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let guard = try_acquire(path.clone()).await.unwrap();
        assert!(path.exists());
        drop(guard);
    }

    #[tokio::test]
    async fn try_acquire_or_busy_reports_busy_when_held() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");
        let _guard = acquire(path.clone()).await.unwrap();

        let result = try_acquire_or_busy(path).await.unwrap();

        assert!(matches!(result, TryLock::Busy));
    }

    #[tokio::test]
    async fn try_acquire_or_busy_propagates_lock_path_errors() {
        let path = PathBuf::from("/dev/null/impossible/test.lock");

        let result = try_acquire_or_busy(path).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn shared_locks_coexist() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let _guard1 = acquire_shared(path.clone()).await.unwrap();
        let _guard2 = acquire_shared(path.clone()).await.unwrap();
        // Both held simultaneously — no conflict.
    }

    #[tokio::test]
    async fn shared_lock_blocks_exclusive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let _guard = acquire_shared(path.clone()).await.unwrap();
        let err = try_acquire(path).await.unwrap_err();
        assert!(err.to_string().contains("already held by another process"));
    }

    #[tokio::test]
    async fn exclusive_blocks_shared_nonblocking() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.lock");

        let _guard = acquire(path.clone()).await.unwrap();

        // A nonblocking shared attempt must fail.
        let file = std::fs::File::options()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let err = Flock::lock(file, FlockArg::LockSharedNonblock).unwrap_err();
        assert_eq!(err.1, nix::errno::Errno::EWOULDBLOCK);
    }

    #[tokio::test]
    async fn invalid_path_returns_error() {
        // /dev/null is a file, so create_dir_all cannot create a child directory
        // inside it — this fails even as root.
        let path = PathBuf::from("/dev/null/impossible/test.lock");
        let result = acquire(path).await;
        assert!(result.is_err());
    }
}
