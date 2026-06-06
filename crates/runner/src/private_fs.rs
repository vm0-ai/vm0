use std::path::{Component, Path, PathBuf};

use crate::error::{RunnerError, RunnerResult};

const PRIVATE_DIR_MODE: u32 = 0o700;
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

/// Ensure `path` is private runtime state for the current runner process.
///
/// The runner normally runs as root. This intentionally keeps runtime state
/// owned by the effective uid instead of chowning it back to `SUDO_USER`.
#[cfg(unix)]
pub async fn ensure_private_dir(path: &Path) -> RunnerResult<()> {
    reject_reserved_private_dir_path(path)?;

    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true);
    builder.mode(PRIVATE_DIR_MODE);
    match builder.create(path).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => {
            return Err(RunnerError::Config(format!(
                "create private dir {}: {e}",
                path.display()
            )));
        }
    }

    ensure_private_dir_owned_by(path, nix::unistd::geteuid().as_raw()).await
}

#[cfg(not(unix))]
pub async fn ensure_private_dir(path: &Path) -> RunnerResult<()> {
    tokio::fs::create_dir_all(path)
        .await
        .map_err(|e| RunnerError::Config(format!("create private dir {}: {e}", path.display())))
}

#[cfg(unix)]
async fn ensure_private_dir_owned_by(path: &Path, expected_uid: u32) -> RunnerResult<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let lstat_path = path_for_final_component_lstat(path);
    let metadata = tokio::fs::symlink_metadata(&lstat_path)
        .await
        .map_err(|e| RunnerError::Config(format!("stat private dir {}: {e}", path.display())))?;
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return Err(RunnerError::Config(format!(
            "{} is a symlink; refusing to use it as private runner state",
            path.display()
        )));
    }
    if !file_type.is_dir() {
        return Err(RunnerError::Config(format!(
            "{} is not a directory; refusing to use it as private runner state",
            path.display()
        )));
    }

    let actual_uid = metadata.uid();
    if actual_uid != expected_uid {
        return Err(RunnerError::Config(format!(
            "{} is owned by uid {actual_uid}, but runner euid is {expected_uid}; fix ownership before starting the runner",
            path.display()
        )));
    }

    tokio::fs::set_permissions(
        &lstat_path,
        std::fs::Permissions::from_mode(PRIVATE_DIR_MODE),
    )
    .await
    .map_err(|e| RunnerError::Config(format!("chmod private dir {}: {e}", path.display())))?;
    Ok(())
}

#[cfg(unix)]
fn path_for_final_component_lstat(path: &Path) -> PathBuf {
    // Unix lstat follows a final symlink when the input has a trailing separator.
    let lstat_path: PathBuf = path.components().collect();
    if lstat_path.as_os_str().is_empty() {
        path.to_path_buf()
    } else {
        lstat_path
    }
}

#[cfg(unix)]
fn reject_reserved_private_dir_path(path: &Path) -> RunnerResult<()> {
    let normalized = normalize_path_lexically(path);
    if RESERVED_PRIVATE_DIR_PATHS
        .iter()
        .any(|reserved| normalized == Path::new(reserved))
    {
        return Err(RunnerError::Config(format!(
            "{} is a reserved system path; refusing to use it as private runner state",
            path.display()
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

        let error = ensure_private_dir_owned_by(&private_dir, mismatched_uid)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("owned by uid"),
            "unexpected error: {error}"
        );
    }
}
