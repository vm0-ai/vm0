use std::path::Path;

use crate::error::{RunnerError, RunnerResult};

pub(crate) const LOG_DIR_MODE: u32 = 0o700;
pub(crate) const LOG_FILE_MODE: u32 = 0o600;

#[cfg(unix)]
pub(crate) fn ensure_log_dir_sync(dir: &Path) -> RunnerResult<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(LOG_DIR_MODE)
        .create(dir)
        .map_err(|e| RunnerError::Internal(format!("create logs_dir {}: {e}", dir.display())))?;
    let metadata = std::fs::symlink_metadata(dir)
        .map_err(|e| RunnerError::Internal(format!("stat logs_dir {}: {e}", dir.display())))?;
    if !metadata.file_type().is_dir() {
        return Err(RunnerError::Internal(format!(
            "{} is not a directory",
            dir.display()
        )));
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(LOG_DIR_MODE))
        .map_err(|e| RunnerError::Internal(format!("chmod logs_dir {}: {e}", dir.display())))
}

#[cfg(not(unix))]
pub(crate) fn ensure_log_dir_sync(dir: &Path) -> RunnerResult<()> {
    std::fs::create_dir_all(dir)
        .map_err(|e| RunnerError::Internal(format!("create logs_dir {}: {e}", dir.display())))
}

#[cfg(unix)]
pub(crate) async fn ensure_log_dir(dir: &Path) -> RunnerResult<()> {
    use std::os::unix::fs::PermissionsExt;

    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true).mode(LOG_DIR_MODE);
    builder
        .create(dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create logs_dir {}: {e}", dir.display())))?;
    let metadata = tokio::fs::symlink_metadata(dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("stat logs_dir {}: {e}", dir.display())))?;
    if !metadata.file_type().is_dir() {
        return Err(RunnerError::Internal(format!(
            "{} is not a directory",
            dir.display()
        )));
    }
    tokio::fs::set_permissions(dir, std::fs::Permissions::from_mode(LOG_DIR_MODE))
        .await
        .map_err(|e| RunnerError::Internal(format!("chmod logs_dir {}: {e}", dir.display())))
}

#[cfg(not(unix))]
pub(crate) async fn ensure_log_dir(dir: &Path) -> RunnerResult<()> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| RunnerError::Internal(format!("create logs_dir {}: {e}", dir.display())))
}

#[cfg(unix)]
pub(crate) fn secure_open_log_file_sync(file: &std::fs::File, path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() {
        return Err(std::io::Error::other(format!(
            "{} is not a regular log file",
            path.display()
        )));
    }
    if metadata.permissions().mode() & 0o777 == LOG_FILE_MODE {
        return Ok(());
    }
    file.set_permissions(std::fs::Permissions::from_mode(LOG_FILE_MODE))
}

#[cfg(not(unix))]
pub(crate) fn secure_open_log_file_sync(
    _file: &std::fs::File,
    _path: &Path,
) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
pub(crate) async fn secure_log_file(path: &Path) -> RunnerResult<()> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|e| RunnerError::Internal(format!("stat log file {}: {e}", path.display())))?;
    if !metadata.file_type().is_file() {
        return Err(RunnerError::Internal(format!(
            "{} is not a regular log file",
            path.display()
        )));
    }
    if metadata.permissions().mode() & 0o777 == LOG_FILE_MODE {
        return Ok(());
    }
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(LOG_FILE_MODE))
        .await
        .map_err(|e| RunnerError::Internal(format!("chmod log file {}: {e}", path.display())))
}

#[cfg(not(unix))]
pub(crate) async fn secure_log_file(_path: &Path) -> RunnerResult<()> {
    Ok(())
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn ensure_log_dir_sync_creates_private_dir() {
        let dir = tempfile::tempdir().unwrap();
        let logs_dir = dir.path().join("logs");

        ensure_log_dir_sync(&logs_dir).unwrap();

        let mode = std::fs::metadata(&logs_dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, LOG_DIR_MODE);
    }

    #[tokio::test]
    async fn ensure_log_dir_tightens_existing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let logs_dir = dir.path().join("logs");
        std::fs::create_dir(&logs_dir).unwrap();
        std::fs::set_permissions(&logs_dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        ensure_log_dir(&logs_dir).await.unwrap();

        let mode = std::fs::metadata(&logs_dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, LOG_DIR_MODE);
    }
}
