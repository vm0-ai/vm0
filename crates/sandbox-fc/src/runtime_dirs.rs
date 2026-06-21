use std::fs::DirBuilder;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Component, Path};

use nix::unistd::{AccessFlags, eaccess, geteuid};

use crate::paths::{RuntimePaths, SockPaths};

pub(crate) const PRIVATE_RUNTIME_DIR_MODE: u32 = 0o700;
const MAX_UNIX_SOCKET_PATH_BYTES: usize = 107;

pub(crate) fn checked_runtime_sock_dir(
    runtime_paths: &RuntimePaths,
    sock_id: &str,
) -> io::Result<std::path::PathBuf> {
    validate_runtime_sock_id(sock_id)?;
    let sock_dir = runtime_paths.sock_dir(sock_id);
    let sock_paths = SockPaths::new(sock_dir.clone());
    validate_runtime_vsock_path_len(sock_id, &sock_paths.vsock())?;
    Ok(sock_dir)
}

pub(crate) fn ensure_private_runtime_dir(path: &Path) -> io::Result<()> {
    create_private_dir_if_missing(path)?;
    validate_private_runtime_dir(path)
}

pub(crate) fn prepare_private_socket_dir(sock_paths: &SockPaths) -> io::Result<()> {
    ensure_private_runtime_dir(sock_paths.dir())?;
    ensure_private_runtime_dir(&sock_paths.vsock_dir())
}

pub(crate) fn prepare_private_runtime_vsock_dir(vsock_bind_dir: &Path) -> io::Result<()> {
    prepare_private_vsock_dir_under(&RuntimePaths::new().sock_base(), vsock_bind_dir)
}

fn prepare_private_vsock_dir_under(sock_base: &Path, vsock_bind_dir: &Path) -> io::Result<()> {
    let relative = vsock_bind_dir.strip_prefix(sock_base).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "runtime vsock dir {} is outside socket base {}",
                vsock_bind_dir.display(),
                sock_base.display()
            ),
        )
    })?;

    let mut components = relative.components();
    let Some(Component::Normal(sock_id)) = components.next() else {
        return Err(invalid_vsock_dir_shape(sock_base, vsock_bind_dir));
    };
    let Some(Component::Normal(vsock_dir)) = components.next() else {
        return Err(invalid_vsock_dir_shape(sock_base, vsock_bind_dir));
    };
    if vsock_dir != "vsock" || components.next().is_some() {
        return Err(invalid_vsock_dir_shape(sock_base, vsock_bind_dir));
    }
    let sock_id = sock_id
        .to_str()
        .ok_or_else(|| invalid_runtime_sock_id(&sock_id.to_string_lossy()))?;
    validate_runtime_sock_id(sock_id)?;
    validate_runtime_vsock_path_len(sock_id, &vsock_bind_dir.join("vsock.sock"))?;

    ensure_private_runtime_dir(sock_base)?;
    let sock_dir = vsock_bind_dir.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "runtime vsock dir has no parent: {}",
                vsock_bind_dir.display()
            ),
        )
    })?;
    ensure_private_runtime_dir(sock_dir)?;
    ensure_private_runtime_dir(vsock_bind_dir)
}

fn invalid_vsock_dir_shape(sock_base: &Path, vsock_bind_dir: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!(
            "runtime vsock dir must be {}/<id>/vsock: {}",
            sock_base.display(),
            vsock_bind_dir.display()
        ),
    )
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

fn validate_runtime_sock_id(sock_id: &str) -> io::Result<()> {
    if sock_id.is_empty() {
        return Err(invalid_runtime_sock_id(sock_id));
    }
    if !sock_id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    {
        return Err(invalid_runtime_sock_id(sock_id));
    }

    let mut components = Path::new(sock_id).components();
    let Some(Component::Normal(_)) = components.next() else {
        return Err(invalid_runtime_sock_id(sock_id));
    };
    if components.next().is_some() {
        return Err(invalid_runtime_sock_id(sock_id));
    }
    Ok(())
}

fn validate_runtime_vsock_path_len(sock_id: &str, vsock_path: &Path) -> io::Result<()> {
    let vsock_path_len = vsock_path.as_os_str().as_bytes().len();
    if vsock_path_len > MAX_UNIX_SOCKET_PATH_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "runtime socket id {sock_id:?} makes vsock path too long: {} bytes (max {})",
                vsock_path_len, MAX_UNIX_SOCKET_PATH_BYTES
            ),
        ));
    }
    Ok(())
}

fn invalid_runtime_sock_id(sock_id: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!(
            "runtime socket id must be a single non-empty ASCII path segment using only letters, digits, '.', '-', and '_': {sock_id:?}"
        ),
    )
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
    fn checked_runtime_sock_dir_accepts_safe_id() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_paths = RuntimePaths::with_dir_for_test(tmp.path().to_path_buf());

        let sock_dir = checked_runtime_sock_dir(&runtime_paths, "snapshot-test_1.2").unwrap();

        assert_eq!(sock_dir, tmp.path().join("sock").join("snapshot-test_1.2"));
    }

    #[test]
    fn checked_runtime_sock_dir_rejects_parent_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_paths = RuntimePaths::with_dir_for_test(tmp.path().to_path_buf());

        let err = checked_runtime_sock_dir(&runtime_paths, "../snapshot").unwrap_err();

        assert!(err.to_string().contains("runtime socket id must be"));
    }

    #[test]
    fn checked_runtime_sock_dir_rejects_nested_id() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_paths = RuntimePaths::with_dir_for_test(tmp.path().to_path_buf());

        let err = checked_runtime_sock_dir(&runtime_paths, "root/snapshot").unwrap_err();

        assert!(err.to_string().contains("runtime socket id must be"));
    }

    #[test]
    fn checked_runtime_sock_dir_rejects_unsafe_character() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_paths = RuntimePaths::with_dir_for_test(tmp.path().to_path_buf());

        let err = checked_runtime_sock_dir(&runtime_paths, "snapshot test").unwrap_err();

        assert!(err.to_string().contains("runtime socket id must be"));
    }

    #[test]
    fn checked_runtime_sock_dir_rejects_overlong_vsock_path() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_paths = RuntimePaths::with_dir_for_test(tmp.path().to_path_buf());
        let sock_id = "a".repeat(200);

        let err = checked_runtime_sock_dir(&runtime_paths, &sock_id).unwrap_err();

        assert!(err.to_string().contains("vsock path too long"));
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
    fn prepare_private_vsock_dir_under_creates_private_runtime_vsock_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let sock_base = tmp.path().join("sock");
        let vsock_dir = sock_base.join("snapshot").join("vsock");

        prepare_private_vsock_dir_under(&sock_base, &vsock_dir).unwrap();

        assert_eq!(mode(&sock_base), PRIVATE_RUNTIME_DIR_MODE);
        assert_eq!(mode(&sock_base.join("snapshot")), PRIVATE_RUNTIME_DIR_MODE);
        assert_eq!(mode(&vsock_dir), PRIVATE_RUNTIME_DIR_MODE);
    }

    #[test]
    fn prepare_private_vsock_dir_under_rejects_symlinked_runtime_sock_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let sock_base = tmp.path().join("sock");
        let target = tmp.path().join("target");
        let snapshot_dir = sock_base.join("snapshot");
        let vsock_dir = snapshot_dir.join("vsock");
        std::fs::create_dir(&sock_base).unwrap();
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &snapshot_dir).unwrap();

        let err = prepare_private_vsock_dir_under(&sock_base, &vsock_dir).unwrap_err();

        assert!(err.to_string().contains("is a symlink"));
        assert!(target.is_dir());
    }

    #[test]
    fn prepare_private_vsock_dir_under_rejects_path_outside_sock_base() {
        let tmp = tempfile::tempdir().unwrap();
        let sock_base = tmp.path().join("sock");
        let vsock_dir = tmp.path().join("other").join("snapshot").join("vsock");

        let err = prepare_private_vsock_dir_under(&sock_base, &vsock_dir).unwrap_err();

        assert!(err.to_string().contains("is outside socket base"));
    }

    #[test]
    fn prepare_private_vsock_dir_under_rejects_unsafe_socket_id() {
        let tmp = tempfile::tempdir().unwrap();
        let sock_base = tmp.path().join("sock");
        let vsock_dir = sock_base.join("snapshot test").join("vsock");

        let err = prepare_private_vsock_dir_under(&sock_base, &vsock_dir).unwrap_err();

        assert!(err.to_string().contains("runtime socket id must be"));
    }

    #[test]
    fn prepare_private_vsock_dir_under_rejects_overlong_vsock_path() {
        let tmp = tempfile::tempdir().unwrap();
        let sock_base = tmp.path().join("sock");
        let vsock_dir = sock_base.join("a".repeat(200)).join("vsock");

        let err = prepare_private_vsock_dir_under(&sock_base, &vsock_dir).unwrap_err();

        assert!(err.to_string().contains("vsock path too long"));
    }

    #[test]
    fn prepare_private_vsock_dir_under_rejects_parent_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let sock_base = tmp.path().join("sock");
        let vsock_dir = sock_base.join("snapshot").join("..").join("vsock");

        let err = prepare_private_vsock_dir_under(&sock_base, &vsock_dir).unwrap_err();

        assert!(err.to_string().contains("must be"));
    }

    #[test]
    fn prepare_private_vsock_dir_under_rejects_wrong_leaf() {
        let tmp = tempfile::tempdir().unwrap();
        let sock_base = tmp.path().join("sock");
        let vsock_dir = sock_base.join("snapshot").join("api");

        let err = prepare_private_vsock_dir_under(&sock_base, &vsock_dir).unwrap_err();

        assert!(err.to_string().contains("must be"));
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
