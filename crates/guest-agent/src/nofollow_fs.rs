//! Linux fd-based no-follow filesystem primitives.
//!
//! This module owns the low-level invariant for opening directory trees
//! without following symlinks: root directories are opened with
//! `O_NOFOLLOW`, children are opened relative to their parent fd with
//! `openat`, and directory iteration goes through `/proc/self/fd/{fd}`.
//!
//! Callers still own recursive traversal policy and business error
//! handling. This module should only expose the primitive operations needed
//! to safely open directories and regular-file candidates.

#[cfg(target_os = "linux")]
use std::ffi::{CString, OsStr};
#[cfg(target_os = "linux")]
use std::fs::{self, File, OpenOptions};
#[cfg(target_os = "linux")]
use std::io;
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt;
#[cfg(target_os = "linux")]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FileIdentity {
    device: libc::dev_t,
    inode: libc::ino_t,
    mount_id: u64,
}

#[cfg(target_os = "linux")]
impl FileIdentity {
    pub(crate) fn device(self) -> libc::dev_t {
        self.device
    }

    pub(crate) fn mount_id(self) -> u64 {
        self.mount_id
    }
}

#[cfg(target_os = "linux")]
pub(crate) struct Dir(File);

#[cfg(target_os = "linux")]
impl Dir {
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map(Self)
    }

    pub(crate) fn read_dir(&self) -> io::Result<fs::ReadDir> {
        fs::read_dir(PathBuf::from(format!(
            "/proc/self/fd/{}",
            self.0.as_raw_fd()
        )))
    }

    pub(crate) fn open_absolute(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "directory path must be absolute",
            ));
        }

        let mut current = Self::open(Path::new("/"))?;
        for component in path.components() {
            match component {
                std::path::Component::RootDir => {}
                std::path::Component::Normal(name) => {
                    current = current.open_child_dir(name)?;
                }
                std::path::Component::CurDir
                | std::path::Component::ParentDir
                | std::path::Component::Prefix(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "directory path must contain only normal components",
                    ));
                }
            }
        }
        Ok(current)
    }

    pub(crate) fn identity(&self) -> io::Result<FileIdentity> {
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: `stat` points to writable memory and the directory owns a
        // live descriptor for the duration of the call.
        let result = unsafe { libc::fstat(self.0.as_raw_fd(), stat.as_mut_ptr()) };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful `fstat` initialized the full structure.
        let stat = unsafe { stat.assume_init() };
        let mount_id = mount_id_for_fd(self.0.as_raw_fd())?;
        Ok(FileIdentity {
            device: stat.st_dev,
            inode: stat.st_ino,
            mount_id,
        })
    }

    pub(crate) fn open_child_dir(&self, name: &OsStr) -> io::Result<Self> {
        open_child(
            &self.0,
            name,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map(Self)
    }

    pub(crate) fn open_child_file(&self, name: &OsStr) -> io::Result<File> {
        open_child(
            &self.0,
            name,
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    }

    pub(crate) fn remove_child_tree(
        &self,
        name: &OsStr,
        filesystem: FileIdentity,
        protected: &[FileIdentity],
    ) -> io::Result<()> {
        match self.open_child_dir(name) {
            Ok(child) => {
                let identity = child.identity()?;
                if identity.device != filesystem.device || identity.mount_id != filesystem.mount_id
                {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "refusing to cross a mount or filesystem boundary during cleanup",
                    ));
                }
                if protected.contains(&identity) {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "refusing to remove a protected runtime directory",
                    ));
                }
                let entries = child
                    .read_dir()?
                    .map(|entry| entry.map(|entry| entry.file_name()))
                    .collect::<io::Result<Vec<_>>>()?;
                for child_name in entries {
                    child.remove_child_tree(&child_name, filesystem, protected)?;
                }
                unlink_child(&self.0, name, libc::AT_REMOVEDIR)
            }
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(libc::ENOTDIR) | Some(libc::ELOOP)
                ) =>
            {
                unlink_child(&self.0, name, 0)
            }
            Err(error) => Err(error),
        }
    }
}

#[cfg(target_os = "linux")]
fn mount_id_for_fd(fd: RawFd) -> io::Result<u64> {
    let fdinfo = fs::read_to_string(format!("/proc/self/fdinfo/{fd}"))?;
    let value = fdinfo
        .lines()
        .find_map(|line| line.strip_prefix("mnt_id:"))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::Unsupported,
                "filesystem mount identity is unavailable",
            )
        })?;
    value.trim().parse().map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid filesystem mount identity: {error}"),
        )
    })
}

#[cfg(target_os = "linux")]
fn open_child(parent: &File, name: &OsStr, flags: i32) -> io::Result<File> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes == b"." || bytes == b".." || bytes.contains(&b'/') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "child name must be a non-empty basename",
        ));
    }
    let name = CString::new(bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    // SAFETY: `parent.as_raw_fd()` is an open directory fd owned by `Dir`,
    // `name` is a NUL-terminated child basename produced by `CString`, and
    // the flags do not request a mode argument.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a non-negative `openat` result is a newly owned fd. Converting
    // it into `File` transfers close responsibility to Rust.
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(target_os = "linux")]
fn unlink_child(parent: &File, name: &OsStr, flags: i32) -> io::Result<()> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes == b"." || bytes == b".." || bytes.contains(&b'/') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "child name must be a non-empty basename",
        ));
    }
    let name = CString::new(bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    // SAFETY: the parent is a live directory descriptor, `name` is a
    // NUL-terminated basename, and `flags` is either zero or AT_REMOVEDIR.
    let result = unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn open_rejects_symlinked_root() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        let link = dir.path().join("link");
        fs::create_dir(&real).unwrap();
        symlink(&real, &link).unwrap();

        assert!(Dir::open(&link).is_err());
    }

    #[test]
    fn open_child_dir_rejects_symlinked_child() {
        let dir = tempfile::tempdir().unwrap();
        let root_path = dir.path().join("root");
        let outside = dir.path().join("outside");
        fs::create_dir(&root_path).unwrap();
        fs::create_dir(&outside).unwrap();
        symlink(&outside, root_path.join("linked")).unwrap();

        let root = Dir::open(&root_path).unwrap();

        assert!(root.open_child_dir(OsStr::new("linked")).is_err());
    }

    #[test]
    fn open_child_file_rejects_symlinked_child() {
        let dir = tempfile::tempdir().unwrap();
        let root_path = dir.path().join("root");
        let outside = dir.path().join("outside.txt");
        fs::create_dir(&root_path).unwrap();
        fs::write(&outside, "outside").unwrap();
        symlink(&outside, root_path.join("linked.txt")).unwrap();

        let root = Dir::open(&root_path).unwrap();

        assert!(root.open_child_file(OsStr::new("linked.txt")).is_err());
    }

    #[test]
    fn open_child_rejects_nul_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = Dir::open(dir.path()).unwrap();

        let err = root
            .open_child_file(OsStr::from_bytes(b"bad\0name"))
            .unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn open_child_rejects_invalid_child_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = Dir::open(dir.path()).unwrap();

        for name in [b"".as_slice(), b".", b"..", b"nested/file"] {
            let err = root.open_child_file(OsStr::from_bytes(name)).unwrap_err();

            assert_eq!(
                err.kind(),
                io::ErrorKind::InvalidInput,
                "name {name:?} should be rejected"
            );
        }
    }
}
