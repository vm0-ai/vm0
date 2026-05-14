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
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt;
#[cfg(target_os = "linux")]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};

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
