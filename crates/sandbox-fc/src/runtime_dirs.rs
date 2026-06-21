use std::fs::DirBuilder;
use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::Path;

use nix::unistd::{AccessFlags, eaccess, geteuid};

use crate::paths::SockPaths;

pub(crate) const PRIVATE_RUNTIME_DIR_MODE: u32 = 0o700;

pub(crate) fn ensure_private_runtime_dir(path: &Path) -> io::Result<()> {
    create_private_dir_if_missing(path)?;
    validate_private_runtime_dir(path)
}

pub(crate) fn prepare_private_socket_dir(sock_paths: &SockPaths) -> io::Result<()> {
    ensure_private_runtime_dir(sock_paths.dir())?;
    ensure_private_runtime_dir(&sock_paths.vsock_dir())
}

fn create_private_dir_if_missing(path: &Path) -> io::Result<()> {
    let mut builder = DirBuilder::new();
    builder.mode(PRIVATE_RUNTIME_DIR_MODE);
    match builder.create(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(io::Error::new(
            e.kind(),
            format!("create private runtime dir {}: {e}", path.display()),
        )),
    }
}

fn validate_private_runtime_dir(path: &Path) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("stat private runtime dir {}: {e}", path.display()),
        )
    })?;
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return Err(io::Error::other(format!(
            "private runtime dir is a symlink: {}",
            path.display()
        )));
    }
    if !file_type.is_dir() {
        return Err(io::Error::other(format!(
            "private runtime dir is not a directory: {}",
            path.display()
        )));
    }

    let euid = geteuid().as_raw();
    if !runtime_dir_owner_is_trusted(metadata.uid(), euid) {
        return Err(io::Error::other(format!(
            "private runtime dir has untrusted owner uid {}: {}",
            metadata.uid(),
            path.display()
        )));
    }

    let mode = metadata.permissions().mode() & 0o7777;
    if mode != PRIVATE_RUNTIME_DIR_MODE {
        std::fs::set_permissions(
            path,
            std::fs::Permissions::from_mode(PRIVATE_RUNTIME_DIR_MODE),
        )
        .map_err(|e| {
            io::Error::new(
                e.kind(),
                format!(
                    "chmod private runtime dir {} to {:04o}: {e}",
                    path.display(),
                    PRIVATE_RUNTIME_DIR_MODE
                ),
            )
        })?;
    }

    eaccess(path, AccessFlags::W_OK | AccessFlags::X_OK).map_err(|e| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "private runtime dir is not writable/traversable: {}: {e}",
                path.display()
            ),
        )
    })
}

fn runtime_dir_owner_is_trusted(owner_uid: u32, effective_uid: u32) -> bool {
    owner_uid == 0 || owner_uid == effective_uid
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::Path;

    use super::*;

    fn mode(path: &Path) -> u32 {
        std::fs::symlink_metadata(path)
            .unwrap()
            .permissions()
            .mode()
            & 0o7777
    }

    #[test]
    fn ensure_private_runtime_dir_creates_missing_dir_with_private_mode() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("runtime");

        ensure_private_runtime_dir(&path).unwrap();

        assert!(path.is_dir());
        assert_eq!(mode(&path), PRIVATE_RUNTIME_DIR_MODE);
    }

    #[test]
    fn ensure_private_runtime_dir_normalizes_existing_trusted_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("runtime");
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o777)).unwrap();

        ensure_private_runtime_dir(&path).unwrap();

        assert_eq!(mode(&path), PRIVATE_RUNTIME_DIR_MODE);
    }

    #[test]
    fn ensure_private_runtime_dir_rejects_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("target");
        let link = tmp.path().join("runtime");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &link).unwrap();

        let err = ensure_private_runtime_dir(&link).unwrap_err();

        assert!(err.to_string().contains("is a symlink"));
        assert!(target.is_dir());
    }

    #[test]
    fn ensure_private_runtime_dir_rejects_non_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("runtime");
        std::fs::write(&path, b"not a dir").unwrap();

        let err = ensure_private_runtime_dir(&path).unwrap_err();

        assert!(err.to_string().contains("is not a directory"));
    }

    #[test]
    fn prepare_private_socket_dir_creates_sock_and_vsock_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let sock_paths = SockPaths::new(tmp.path().join("sandbox"));

        prepare_private_socket_dir(&sock_paths).unwrap();

        assert_eq!(mode(sock_paths.dir()), PRIVATE_RUNTIME_DIR_MODE);
        assert_eq!(mode(&sock_paths.vsock_dir()), PRIVATE_RUNTIME_DIR_MODE);
    }

    #[test]
    fn prepare_private_socket_dir_normalizes_existing_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let sock_paths = SockPaths::new(tmp.path().join("sandbox"));
        std::fs::create_dir(sock_paths.dir()).unwrap();
        std::fs::create_dir(sock_paths.vsock_dir()).unwrap();
        std::fs::set_permissions(sock_paths.dir(), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(
            sock_paths.vsock_dir(),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();

        prepare_private_socket_dir(&sock_paths).unwrap();

        assert_eq!(mode(sock_paths.dir()), PRIVATE_RUNTIME_DIR_MODE);
        assert_eq!(mode(&sock_paths.vsock_dir()), PRIVATE_RUNTIME_DIR_MODE);
    }

    #[test]
    fn owner_trust_accepts_root_and_effective_uid() {
        assert!(runtime_dir_owner_is_trusted(0, 1000));
        assert!(runtime_dir_owner_is_trusted(1000, 1000));
    }

    #[test]
    fn owner_trust_rejects_unrelated_uid() {
        assert!(!runtime_dir_owner_is_trusted(1001, 1000));
    }
}
