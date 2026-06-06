use std::path::Path;

use crate::error::{RunnerError, RunnerResult};

const PRIVATE_DIR_MODE: u32 = 0o700;

/// Ensure `path` is private runtime state for the current runner process.
///
/// The runner normally runs as root. This intentionally keeps runtime state
/// owned by the effective uid instead of chowning it back to `SUDO_USER`.
#[cfg(unix)]
pub async fn ensure_private_dir(path: &Path) -> RunnerResult<()> {
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

    let metadata = tokio::fs::symlink_metadata(path)
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

    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(PRIVATE_DIR_MODE))
        .await
        .map_err(|e| RunnerError::Config(format!("chmod private dir {}: {e}", path.display())))?;
    Ok(())
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
