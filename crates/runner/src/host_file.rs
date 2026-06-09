//! Low-level host filesystem primitives for runner lock/log hardening.
//! Keep policy-specific entry points in `lock.rs` and `log_file.rs`.

use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};

use nix::fcntl::{OFlag, open, openat};
use nix::sys::stat::{Mode, SFlag, fstat, mkdirat};

pub(crate) const PRIVATE_DIR_MODE: u32 = 0o700;
pub(crate) const PRIVATE_FILE_MODE: u32 = 0o600;

const GROUP_OR_OTHER_WRITE_BITS: u32 = 0o022;
const ROOT_UID: u32 = 0;
const STICKY_BIT: u32 = 0o1000;

#[derive(Clone, Copy)]
pub(crate) enum DirMode {
    Private,
    TrustedParent,
}

struct DirWalk<'a> {
    full_path: &'a Path,
    mode: DirMode,
    context: &'a str,
    expected_uid: u32,
    create_missing: bool,
}

pub(crate) fn ensure_dir(path: &Path, mode: DirMode, context: &str) -> io::Result<()> {
    open_dir_components(path, mode, context, true).map(|_| ())
}

pub(crate) fn validate_dir(path: &Path, mode: DirMode, context: &str) -> io::Result<()> {
    open_dir_components(path, mode, context, false).map(|_| ())
}

pub(crate) fn open_private_append_file(path: &Path, read: bool) -> io::Result<File> {
    validate_file_parent(path, "log directory")?;

    let mut options = File::options();
    options
        .create(true)
        .append(true)
        .read(read)
        .mode(PRIVATE_FILE_MODE)
        .custom_flags(private_file_open_flags());
    let file = options
        .open(path)
        .map_err(|e| wrap_io(e, format!("open log file {}", path.display())))?;
    secure_regular_private_file(&file, path, "log file")?;
    Ok(file)
}

pub(crate) fn validate_private_file_destination(path: &Path, context: &str) -> io::Result<()> {
    validate_file_parent(path, context)?;

    let mut options = File::options();
    options
        .read(true)
        .write(true)
        .custom_flags(private_file_open_flags());
    let file = match options.open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(wrap_io(e, format!("open {context} {}", path.display())));
        }
    };
    secure_regular_private_file(&file, path, context)
}

pub(crate) fn secure_regular_private_file<Fd: AsRawFd>(
    file: &Fd,
    path: &Path,
    context: &str,
) -> io::Result<()> {
    let stat = fstat_raw(file, path, context)?;
    let file_type = stat.st_mode & nix::libc::S_IFMT;
    if file_type != nix::libc::S_IFREG {
        return Err(permission_denied(format!(
            "{} is not a regular {context}",
            path.display()
        )));
    }

    let expected_uid = nix::unistd::geteuid().as_raw();
    if stat.st_uid != expected_uid {
        return Err(permission_denied(format!(
            "{} is owned by uid {}, but runner euid is {expected_uid}",
            path.display(),
            stat.st_uid
        )));
    }

    let mode = stat.st_mode & 0o7777;
    if mode & GROUP_OR_OTHER_WRITE_BITS != 0 {
        return Err(permission_denied(format!(
            "{} is group/other writable",
            path.display()
        )));
    }
    if mode != PRIVATE_FILE_MODE {
        chmod_private_file_fd(file, path, context)?;
    }
    Ok(())
}

pub(crate) fn private_file_open_flags() -> i32 {
    nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC | nix::libc::O_NONBLOCK
}

pub(crate) fn validate_file_parent(path: &Path, context: &str) -> io::Result<()> {
    let parent = file_parent(path);
    validate_dir(parent, DirMode::TrustedParent, context)
}

pub(crate) fn file_parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn open_dir_components(
    path: &Path,
    mode: DirMode,
    context: &str,
    create_missing: bool,
) -> io::Result<OwnedFd> {
    if path.as_os_str().is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("empty {context} path"),
        ));
    }

    let expected_uid = nix::unistd::geteuid().as_raw();
    let start = if path.is_absolute() {
        Path::new("/")
    } else {
        Path::new(".")
    };
    let mut current = open(start, dir_open_flags(), Mode::empty()).map_err(|e| {
        io::Error::other(format!("open {context} root for {}: {e}", path.display()))
    })?;
    let mut current_path = start.to_path_buf();
    let mut components = path.components().peekable();
    let mut saw_normal_component = false;
    let walk = DirWalk {
        full_path: path,
        mode,
        context,
        expected_uid,
        create_missing,
    };

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
                current = open_dir_component(&current, name, &current_path, &walk, is_final)?;
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
        secure_dir_component(
            &current,
            &current_path,
            path,
            mode,
            context,
            expected_uid,
            true,
        )?;
    }

    Ok(current)
}

fn open_dir_component(
    parent: &(impl AsFd + AsRawFd),
    name: &OsStr,
    parent_path: &Path,
    walk: &DirWalk<'_>,
    is_final: bool,
) -> io::Result<OwnedFd> {
    ensure_parent_not_replaceable(
        parent,
        parent_path,
        walk.full_path,
        walk.context,
        walk.expected_uid,
    )?;
    match openat(parent, name, dir_open_flags(), Mode::empty()) {
        Ok(fd) => {
            secure_dir_component(
                &fd,
                &component_path(parent_path, name),
                walk.full_path,
                walk.mode,
                walk.context,
                walk.expected_uid,
                is_final,
            )?;
            Ok(fd)
        }
        Err(nix::errno::Errno::ENOENT) if walk.create_missing => {
            create_and_open_dir_component(parent, name, parent_path, walk, is_final)
        }
        Err(e) => Err(dir_component_error(
            "open",
            name,
            walk.full_path,
            walk.context,
            e,
        )),
    }
}

fn create_and_open_dir_component(
    parent: &(impl AsFd + AsRawFd),
    name: &OsStr,
    parent_path: &Path,
    walk: &DirWalk<'_>,
    is_final: bool,
) -> io::Result<OwnedFd> {
    match mkdirat(parent, name, Mode::from_bits_truncate(PRIVATE_DIR_MODE)) {
        Ok(()) | Err(nix::errno::Errno::EEXIST) => {}
        Err(e) => {
            return Err(io::Error::other(format!(
                "create {} component {} for {}: {e}",
                walk.context,
                name.to_string_lossy(),
                walk.full_path.display()
            )));
        }
    }

    let fd = openat(parent, name, dir_open_flags(), Mode::empty())
        .map_err(|e| dir_component_error("open", name, walk.full_path, walk.context, e))?;
    secure_dir_component(
        &fd,
        &component_path(parent_path, name),
        walk.full_path,
        walk.mode,
        walk.context,
        walk.expected_uid,
        is_final,
    )?;
    Ok(fd)
}

fn ensure_parent_not_replaceable(
    parent: &(impl AsFd + AsRawFd),
    parent_path: &Path,
    full_path: &Path,
    context: &str,
    expected_uid: u32,
) -> io::Result<()> {
    let stat = fstat(parent).map_err(|e| {
        io::Error::other(format!(
            "stat {context} parent {} for {}: {e}",
            parent_path.display(),
            full_path.display()
        ))
    })?;
    let mode = (stat.st_mode as u32) & 0o7777;
    if stat.st_uid != ROOT_UID && stat.st_uid != expected_uid {
        return Err(permission_denied(format!(
            "{context} parent {} is owned by untrusted uid {}",
            parent_path.display(),
            stat.st_uid
        )));
    }
    if mode & GROUP_OR_OTHER_WRITE_BITS != 0 && mode & STICKY_BIT == 0 {
        return Err(permission_denied(format!(
            "{context} parent {} is group/other writable without the sticky bit",
            parent_path.display()
        )));
    }
    Ok(())
}

fn secure_dir_component(
    fd: &(impl AsFd + AsRawFd),
    component_path: &Path,
    full_path: &Path,
    mode: DirMode,
    context: &str,
    expected_uid: u32,
    is_final: bool,
) -> io::Result<()> {
    let stat = fstat(fd).map_err(|e| {
        io::Error::other(format!(
            "stat {context} component {} for {}: {e}",
            component_path.display(),
            full_path.display()
        ))
    })?;
    let fd_type = SFlag::from_bits_truncate(stat.st_mode & SFlag::S_IFMT.bits());
    if fd_type != SFlag::S_IFDIR {
        return Err(permission_denied(format!(
            "{} is not a directory",
            full_path.display()
        )));
    }

    match mode {
        DirMode::Private if is_final => {
            if stat.st_uid != expected_uid {
                return Err(permission_denied(format!(
                    "{context} {} is owned by uid {}, but runner euid is {expected_uid}",
                    component_path.display(),
                    stat.st_uid
                )));
            }
            chmod_private_dir_fd(fd, component_path, context)?;
        }
        DirMode::TrustedParent if is_final => {
            validate_trusted_component_owner(stat.st_uid, expected_uid, context, component_path)?;
            let component_mode = (stat.st_mode as u32) & 0o7777;
            if component_mode & GROUP_OR_OTHER_WRITE_BITS != 0 {
                return Err(permission_denied(format!(
                    "{context} {} is group/other writable",
                    component_path.display()
                )));
            }
        }
        _ => {
            validate_trusted_component_owner(stat.st_uid, expected_uid, context, component_path)?;
            let component_mode = (stat.st_mode as u32) & 0o7777;
            if component_mode & GROUP_OR_OTHER_WRITE_BITS != 0 && component_mode & STICKY_BIT == 0 {
                return Err(permission_denied(format!(
                    "{context} component {} is group/other writable without the sticky bit",
                    component_path.display()
                )));
            }
        }
    }

    Ok(())
}

fn validate_trusted_component_owner(
    actual_uid: u32,
    expected_uid: u32,
    context: &str,
    path: &Path,
) -> io::Result<()> {
    if actual_uid != ROOT_UID && actual_uid != expected_uid {
        return Err(permission_denied(format!(
            "{context} component {} is owned by untrusted uid {actual_uid}",
            path.display()
        )));
    }
    Ok(())
}

fn component_path(parent_path: &Path, name: &OsStr) -> PathBuf {
    let mut path = parent_path.to_path_buf();
    path.push(Path::new(name));
    path
}

fn fstat_raw<Fd: AsRawFd>(file: &Fd, path: &Path, context: &str) -> io::Result<nix::libc::stat> {
    let mut stat = std::mem::MaybeUninit::<nix::libc::stat>::uninit();
    // SAFETY: `stat` points to writable memory and `file` owns a live fd.
    let result = unsafe { nix::libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(io::Error::other(format!(
            "stat {context} {}: {}",
            path.display(),
            io::Error::last_os_error()
        )));
    }
    // SAFETY: successful `fstat` initialized the full struct.
    Ok(unsafe { stat.assume_init() })
}

fn chmod_private_file_fd<Fd: AsRawFd>(file: &Fd, path: &Path, context: &str) -> io::Result<()> {
    // SAFETY: `fchmod` operates on the live fd and does not affect Rust aliasing.
    let result =
        unsafe { nix::libc::fchmod(file.as_raw_fd(), PRIVATE_FILE_MODE as nix::libc::mode_t) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "chmod {context} {}: {}",
            path.display(),
            io::Error::last_os_error()
        )))
    }
}

#[cfg(target_os = "linux")]
fn chmod_private_dir_fd<Fd: AsRawFd>(fd: &Fd, path: &Path, context: &str) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let fd_path = PathBuf::from(format!("/proc/self/fd/{}", fd.as_raw_fd()));
    std::fs::set_permissions(&fd_path, std::fs::Permissions::from_mode(PRIVATE_DIR_MODE))
        .map_err(|e| wrap_io(e, format!("chmod {context} {}", path.display())))
}

#[cfg(not(target_os = "linux"))]
fn chmod_private_dir_fd<Fd: AsFd>(fd: &Fd, path: &Path, context: &str) -> io::Result<()> {
    nix::sys::stat::fchmod(fd, Mode::from_bits_truncate(PRIVATE_DIR_MODE))
        .map_err(|e| io::Error::other(format!("chmod {context} {}: {e}", path.display())))
}

#[cfg(target_os = "linux")]
fn dir_open_flags() -> OFlag {
    OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC
}

#[cfg(not(target_os = "linux"))]
fn dir_open_flags() -> OFlag {
    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC
}

fn dir_component_error(
    operation: &str,
    name: &OsStr,
    full_path: &Path,
    context: &str,
    error: nix::errno::Errno,
) -> io::Error {
    match error {
        nix::errno::Errno::ELOOP => permission_denied(format!(
            "{} contains symlink component {}; refusing to use it as {context}",
            full_path.display(),
            name.to_string_lossy()
        )),
        nix::errno::Errno::ENOTDIR => permission_denied(format!(
            "{} is not a directory; refusing to use it as {context}",
            full_path.display()
        )),
        _ => io::Error::other(format!(
            "{operation} {context} component {} for {}: {error}",
            name.to_string_lossy(),
            full_path.display()
        )),
    }
}

fn permission_denied(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

fn wrap_io(error: io::Error, context: String) -> io::Error {
    io::Error::new(error.kind(), format!("{context}: {error}"))
}
