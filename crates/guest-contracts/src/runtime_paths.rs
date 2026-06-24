//! Shared guest runtime path contract and private runtime file helpers.

use std::env;
use std::fs::File;
#[cfg(not(unix))]
use std::fs::{self, OpenOptions};
use std::io;
#[cfg(unix)]
use std::path::Component;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::ffi::{CString, OsStr};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;

pub const GUEST_RUNTIME_DIR_ENV: &str = "VM0_GUEST_RUNTIME_DIR";
const DEFAULT_RUNTIME_PARENT: &str = ".vm0/guest-agent/runs";
#[cfg(unix)]
const PRIVATE_DIR_MODE: libc::mode_t = 0o700;
#[cfg(unix)]
const PRIVATE_FILE_MODE: libc::mode_t = 0o600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimePathError {
    MissingRunId,
    InvalidRunId,
    MissingHome,
    InvalidRuntimeDir,
}

impl std::fmt::Display for RuntimePathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingRunId => f.write_str("VM0_RUN_ID is required for guest runtime paths"),
            Self::InvalidRunId => f.write_str("VM0_RUN_ID must be a single safe path segment"),
            Self::MissingHome => f.write_str("HOME is required for guest runtime paths"),
            Self::InvalidRuntimeDir => {
                f.write_str("VM0_GUEST_RUNTIME_DIR must be an absolute path")
            }
        }
    }
}

impl std::error::Error for RuntimePathError {}

fn is_safe_run_id(run_id: &str) -> bool {
    !run_id.is_empty()
        && run_id != "."
        && run_id != ".."
        && !run_id.contains('/')
        && !run_id.contains('\\')
        && !run_id.contains('\0')
}

pub fn validate_run_id(run_id: &str) -> Result<(), RuntimePathError> {
    if run_id.is_empty() {
        return Err(RuntimePathError::MissingRunId);
    }
    if !is_safe_run_id(run_id) {
        return Err(RuntimePathError::InvalidRunId);
    }
    Ok(())
}

pub fn run_dir_for_home(
    guest_home: impl AsRef<Path>,
    run_id: &str,
) -> Result<PathBuf, RuntimePathError> {
    validate_run_id(run_id)?;
    Ok(guest_home
        .as_ref()
        .join(DEFAULT_RUNTIME_PARENT)
        .join(run_id))
}

pub fn run_dir_from_env(run_id: &str) -> Result<PathBuf, RuntimePathError> {
    if let Some(path) = env::var_os(GUEST_RUNTIME_DIR_ENV)
        && !path.is_empty()
    {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err(RuntimePathError::InvalidRuntimeDir);
        }
        return Ok(path);
    }

    let home = env::var_os("HOME").ok_or(RuntimePathError::MissingHome)?;
    if home.is_empty() {
        return Err(RuntimePathError::MissingHome);
    }
    run_dir_for_home(home, run_id)
}

fn file(run_dir: impl AsRef<Path>, name: &str) -> PathBuf {
    run_dir.as_ref().join(name)
}

fn log_file(run_dir: impl AsRef<Path>, name: &str) -> PathBuf {
    run_dir.as_ref().join("logs").join(name)
}

fn telemetry_file(run_dir: impl AsRef<Path>, name: &str) -> PathBuf {
    run_dir.as_ref().join("telemetry").join(name)
}

pub fn session_id_file(run_dir: impl AsRef<Path>) -> PathBuf {
    file(run_dir, "session-id")
}

pub fn session_history_marker_file(run_dir: impl AsRef<Path>) -> PathBuf {
    file(run_dir, "session-history-marker")
}

pub fn event_error_file(run_dir: impl AsRef<Path>) -> PathBuf {
    file(run_dir, "event-error")
}

pub fn checkpoint_error_file(run_dir: impl AsRef<Path>) -> PathBuf {
    file(run_dir, "checkpoint-error")
}

pub fn failure_diagnostic_file(run_dir: impl AsRef<Path>) -> PathBuf {
    file(run_dir, "failure-diagnostic.json")
}

pub fn system_log_file(run_dir: impl AsRef<Path>) -> PathBuf {
    log_file(run_dir, "system.log")
}

pub fn agent_log_file(run_dir: impl AsRef<Path>) -> PathBuf {
    log_file(run_dir, "agent.jsonl")
}

pub fn metrics_log_file(run_dir: impl AsRef<Path>) -> PathBuf {
    log_file(run_dir, "metrics.jsonl")
}

pub fn sandbox_ops_log_file(run_dir: impl AsRef<Path>) -> PathBuf {
    log_file(run_dir, "sandbox-ops.jsonl")
}

pub fn telemetry_system_log_pos_file(run_dir: impl AsRef<Path>) -> PathBuf {
    telemetry_file(run_dir, "system-log.pos")
}

pub fn telemetry_metrics_pos_file(run_dir: impl AsRef<Path>) -> PathBuf {
    telemetry_file(run_dir, "metrics.pos")
}

pub fn telemetry_sandbox_ops_pos_file(run_dir: impl AsRef<Path>) -> PathBuf {
    telemetry_file(run_dir, "sandbox-ops.pos")
}

#[cfg(unix)]
fn permission_denied(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

#[cfg(unix)]
fn wrap_last_os_error(context: String) -> io::Error {
    let error = io::Error::last_os_error();
    io::Error::new(error.kind(), format!("{context}: {error}"))
}

#[cfg(unix)]
fn wrap_io_error(error: io::Error, context: String) -> io::Error {
    io::Error::new(error.kind(), format!("{context}: {error}"))
}

#[cfg(unix)]
fn component_cstring(name: &OsStr, path: &Path) -> io::Result<CString> {
    CString::new(name.as_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{} contains a NUL byte in component {}",
                path.display(),
                name.to_string_lossy()
            ),
        )
    })
}

#[cfg(unix)]
fn open_dir_root(path: &Path) -> io::Result<OwnedFd> {
    let root = if path.is_absolute() { "/" } else { "." };
    let root = CString::new(root).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid runtime directory root: {error}"),
        )
    })?;
    // SAFETY: `root` is NUL-terminated and points to a static path string.
    let fd = unsafe {
        libc::open(
            root.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(wrap_last_os_error(format!(
            "open runtime directory root for {}",
            path.display()
        )));
    }
    // SAFETY: `fd` is a fresh descriptor returned by `open`.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

#[cfg(unix)]
fn dir_open_flags() -> libc::c_int {
    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC
}

#[cfg(unix)]
fn validate_dir_fd(fd: &OwnedFd, path: &Path) -> io::Result<()> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `stat` points to writable memory and `fd` owns a live descriptor.
    let result = unsafe { libc::fstat(fd.as_raw_fd(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(wrap_last_os_error(format!(
            "stat runtime directory {}",
            path.display()
        )));
    }
    // SAFETY: successful `fstat` initialized the full struct.
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Err(permission_denied(format!(
            "{} is not a runtime directory",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn chmod_dir_fd(fd: &OwnedFd, path: &Path) -> io::Result<()> {
    // SAFETY: `fd` owns a live directory descriptor.
    let result = unsafe { libc::fchmod(fd.as_raw_fd(), PRIVATE_DIR_MODE) };
    if result == 0 {
        Ok(())
    } else {
        Err(wrap_last_os_error(format!(
            "chmod runtime directory {}",
            path.display()
        )))
    }
}

#[cfg(unix)]
fn dir_component_error(operation: &str, name: &OsStr, full_path: &Path) -> io::Error {
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(code) if code == libc::ELOOP => permission_denied(format!(
            "{} contains symlink component {}; refusing to use it as runtime directory",
            full_path.display(),
            name.to_string_lossy()
        )),
        Some(code) if code == libc::ENOTDIR => permission_denied(format!(
            "{} is not a directory; refusing to use it as runtime directory",
            full_path.display()
        )),
        _ => io::Error::new(
            error.kind(),
            format!(
                "{operation} runtime directory component {} for {}: {error}",
                name.to_string_lossy(),
                full_path.display()
            ),
        ),
    }
}

#[cfg(unix)]
fn component_path(parent_path: &Path, name: &OsStr) -> PathBuf {
    let mut path = parent_path.to_path_buf();
    path.push(Path::new(name));
    path
}

#[cfg(unix)]
fn open_or_create_dir_component(
    parent: &OwnedFd,
    parent_path: &Path,
    name: &OsStr,
    full_path: &Path,
    is_final: bool,
) -> io::Result<OwnedFd> {
    let name_c = component_cstring(name, full_path)?;
    let path = component_path(parent_path, name);
    // SAFETY: `name_c` is NUL-terminated and `parent` owns a live directory fd.
    let mut fd = unsafe { libc::openat(parent.as_raw_fd(), name_c.as_ptr(), dir_open_flags()) };
    if fd < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
        // SAFETY: `name_c` is NUL-terminated and `parent` owns a live directory fd.
        let mkdir_result =
            unsafe { libc::mkdirat(parent.as_raw_fd(), name_c.as_ptr(), PRIVATE_DIR_MODE) };
        if mkdir_result != 0 && io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
            return Err(wrap_last_os_error(format!(
                "create runtime directory component {} for {}",
                name.to_string_lossy(),
                full_path.display()
            )));
        }
        // SAFETY: `name_c` is NUL-terminated and `parent` owns a live directory fd.
        fd = unsafe { libc::openat(parent.as_raw_fd(), name_c.as_ptr(), dir_open_flags()) };
    }
    if fd < 0 {
        return Err(dir_component_error("open", name, full_path));
    }

    // SAFETY: `fd` is a fresh descriptor returned by `openat`.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    validate_dir_fd(&fd, &path)?;
    if is_final {
        chmod_dir_fd(&fd, &path)?;
    }
    Ok(fd)
}

#[cfg(unix)]
fn open_or_create_private_dir(path: &Path) -> io::Result<OwnedFd> {
    if path.as_os_str().is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "runtime directory path is empty",
        ));
    }
    validate_dir_path_components(path)?;

    let mut current = open_dir_root(path)?;
    let mut current_path = if path.is_absolute() {
        PathBuf::from("/")
    } else {
        PathBuf::from(".")
    };
    let mut components = path.components().peekable();
    let mut saw_normal_component = false;

    while let Some(component) = components.next() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                return Err(permission_denied(format!(
                    "{} contains a parent directory segment",
                    path.display()
                )));
            }
            Component::Normal(name) => {
                saw_normal_component = true;
                let is_final = components.peek().is_none();
                current =
                    open_or_create_dir_component(&current, &current_path, name, path, is_final)?;
                current_path = component_path(&current_path, name);
            }
            Component::Prefix(prefix) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "{} contains unsupported path prefix {}",
                        path.display(),
                        prefix.as_os_str().to_string_lossy()
                    ),
                ));
            }
        }
    }

    if !saw_normal_component {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "runtime directory path has no components: {}",
                path.display()
            ),
        ));
    }

    Ok(current)
}

#[cfg(unix)]
fn validate_dir_path_components(path: &Path) -> io::Result<()> {
    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir | Component::Normal(_) => {}
            Component::ParentDir => {
                return Err(permission_denied(format!(
                    "{} contains a parent directory segment",
                    path.display()
                )));
            }
            Component::Prefix(prefix) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "{} contains unsupported path prefix {}",
                        path.display(),
                        prefix.as_os_str().to_string_lossy()
                    ),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_dir_private(_path: &Path) -> io::Result<()> {
    Ok(())
}

pub fn ensure_dir(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref();
    #[cfg(unix)]
    {
        open_or_create_private_dir(path)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(path)?;
        set_dir_private(path)
    }
}

pub fn ensure_parent_dir(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref();
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("runtime path has no parent: {}", path.display()),
        )
    })?;
    ensure_dir(parent)
}

#[cfg(not(unix))]
fn private_file_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    options
}

#[cfg(unix)]
fn set_file_private(file: &File) -> io::Result<()> {
    // SAFETY: `file` owns a live descriptor.
    let result = unsafe { libc::fchmod(file.as_raw_fd(), PRIVATE_FILE_MODE) };
    if result == 0 {
        Ok(())
    } else {
        Err(wrap_last_os_error("chmod runtime file".to_string()))
    }
}

#[cfg(not(unix))]
fn set_file_private(_file: &File) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn file_name(path: &Path) -> io::Result<&OsStr> {
    path.file_name()
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("runtime path has no file name: {}", path.display()),
            )
        })
}

#[cfg(unix)]
fn parent_dir(path: &Path) -> io::Result<&Path> {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("runtime path has no parent: {}", path.display()),
            )
        })
}

#[cfg(unix)]
fn open_private_file(path: &Path, append: bool) -> io::Result<File> {
    let parent = parent_dir(path)?;
    let parent = open_or_create_private_dir(parent)?;
    let name = file_name(path)?;
    let name_c = component_cstring(name, path)?;
    let mut flags =
        libc::O_WRONLY | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
    if append {
        flags |= libc::O_APPEND;
    } else {
        flags |= libc::O_TRUNC;
    }

    // SAFETY: `name_c` is NUL-terminated and `parent` owns a verified directory fd.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name_c.as_ptr(),
            flags,
            PRIVATE_FILE_MODE,
        )
    };
    if fd < 0 {
        let error = io::Error::last_os_error();
        let error = if error.raw_os_error() == Some(libc::ELOOP) {
            permission_denied(format!(
                "{} is a symlink; refusing to use it as runtime file",
                path.display()
            ))
        } else {
            wrap_io_error(error, format!("open runtime file {}", path.display()))
        };
        return Err(error);
    }
    // SAFETY: `fd` is a fresh descriptor returned by `openat`.
    let file = unsafe { File::from_raw_fd(fd) };
    secure_regular_private_file(&file, path)?;
    Ok(file)
}

#[cfg(unix)]
fn secure_regular_private_file(file: &File, path: &Path) -> io::Result<()> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `stat` points to writable memory and `file` owns a live descriptor.
    let result = unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(wrap_last_os_error(format!(
            "stat runtime file {}",
            path.display()
        )));
    }
    // SAFETY: successful `fstat` initialized the full struct.
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(permission_denied(format!(
            "{} is not a regular runtime file",
            path.display()
        )));
    }
    set_file_private(file)?;
    Ok(())
}

#[cfg(unix)]
pub fn create_private(path: impl AsRef<Path>) -> io::Result<File> {
    open_private_file(path.as_ref(), false)
}

#[cfg(not(unix))]
pub fn create_private(path: impl AsRef<Path>) -> io::Result<File> {
    let path = path.as_ref();
    ensure_parent_dir(path)?;
    let file = private_file_options().open(path).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("open runtime file {}: {e}", path.display()),
        )
    })?;
    set_file_private(&file)?;
    Ok(file)
}

pub fn write_private(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) -> io::Result<()> {
    let mut file = create_private(path)?;
    std::io::Write::write_all(&mut file, bytes.as_ref())
}

#[cfg(not(unix))]
fn private_append_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    options
}

#[cfg(unix)]
pub fn open_private_append(path: impl AsRef<Path>) -> io::Result<File> {
    open_private_file(path.as_ref(), true)
}

#[cfg(not(unix))]
pub fn open_private_append(path: impl AsRef<Path>) -> io::Result<File> {
    let path = path.as_ref();
    ensure_parent_dir(path)?;
    let file = private_append_options().open(path).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("open runtime file {}: {e}", path.display()),
        )
    })?;
    set_file_private(&file)?;
    Ok(file)
}

#[cfg(test)]
fn path_is_under(path: &Path, parent: &Path) -> bool {
    path.starts_with(parent)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn canonical_paths_are_not_under_tmp() {
        let run_dir =
            run_dir_for_home("/home/user", "00000000-0000-0000-0000-000000000001").unwrap();
        let files = [
            session_id_file(&run_dir),
            session_history_marker_file(&run_dir),
            event_error_file(&run_dir),
            checkpoint_error_file(&run_dir),
            failure_diagnostic_file(&run_dir),
            system_log_file(&run_dir),
            agent_log_file(&run_dir),
            metrics_log_file(&run_dir),
            sandbox_ops_log_file(&run_dir),
            telemetry_system_log_pos_file(&run_dir),
            telemetry_metrics_pos_file(&run_dir),
            telemetry_sandbox_ops_pos_file(&run_dir),
        ];

        for path in files {
            assert!(!path_is_under(&path, Path::new("/tmp")));
            assert!(path.starts_with("/home/user/.vm0/guest-agent/runs/"));
        }
    }

    #[test]
    fn rejects_unsafe_run_id_segments() {
        for run_id in ["", ".", "..", "a/b", "a\\b", "a\0b"] {
            assert!(run_dir_for_home("/home/user", run_id).is_err());
        }
    }

    #[test]
    fn env_runtime_dir_wins_without_run_id_segment() {
        let temp = tempfile::tempdir().unwrap();
        unsafe {
            env::set_var(GUEST_RUNTIME_DIR_ENV, temp.path());
        }

        let dir = run_dir_from_env("not/validated/when/env/is/set").unwrap();

        assert_eq!(dir, temp.path());
        unsafe {
            env::remove_var(GUEST_RUNTIME_DIR_ENV);
        }
    }

    #[test]
    fn write_private_creates_private_parent_dirs() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("run/logs/system.log");

        write_private(&path, b"hello").unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"hello");
        #[cfg(unix)]
        {
            let run_mode = std::fs::metadata(temp.path().join("run"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            let logs_mode = std::fs::metadata(temp.path().join("run/logs"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            let file_mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(run_mode, 0o700);
            assert_eq!(logs_mode, 0o700);
            assert_eq!(file_mode, 0o600);
        }
    }

    #[test]
    fn write_private_rejects_symlink_file() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        let link = temp.path().join("link");
        std::fs::write(&target, b"secret").unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &link).unwrap();
            assert!(write_private(&link, b"new").is_err());
            assert_eq!(std::fs::read(&target).unwrap(), b"secret");
        }
    }

    #[test]
    fn open_private_append_rejects_symlink_file() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        let link = temp.path().join("link");
        std::fs::write(&target, b"secret").unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &link).unwrap();
            assert!(open_private_append(&link).is_err());
            assert_eq!(std::fs::read(&target).unwrap(), b"secret");
        }
    }

    #[test]
    fn write_private_rejects_symlink_parent_without_touching_target() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        let link = temp.path().join("link");
        std::fs::create_dir(&target).unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &link).unwrap();

            let error = write_private(link.join("system.log"), b"new").unwrap_err();

            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
            assert!(!target.join("system.log").exists());
        }
    }

    #[test]
    fn create_private_rejects_symlink_parent_without_touching_target() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        let link = temp.path().join("link");
        std::fs::create_dir(&target).unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &link).unwrap();

            let error = create_private(link.join("agent.jsonl")).unwrap_err();

            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
            assert!(!target.join("agent.jsonl").exists());
        }
    }

    #[test]
    fn open_private_append_rejects_symlink_parent_without_touching_target() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        let link = temp.path().join("link");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("metrics.jsonl"), b"secret").unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &link).unwrap();

            let error = open_private_append(link.join("metrics.jsonl")).unwrap_err();

            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
            assert_eq!(
                std::fs::read(target.join("metrics.jsonl")).unwrap(),
                b"secret"
            );
        }
    }

    #[test]
    fn ensure_dir_rejects_parent_segment_before_creating_missing_prefix() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("base");
        std::fs::create_dir(&base).unwrap();

        #[cfg(unix)]
        {
            let error = ensure_dir(base.join("missing").join("..").join("leaf")).unwrap_err();

            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
            assert!(!base.join("missing").exists());
            assert!(!base.join("leaf").exists());
        }
    }
}
