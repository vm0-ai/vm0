use std::path::Path;

use tracing::info;
use uuid::Uuid;

use crate::error::{RunnerError, RunnerResult};

/// Load runner ID from `{base_dir}/runner_id`, or generate a new UUID and persist it.
pub(super) async fn load_or_generate_runner_id(base_dir: &Path) -> RunnerResult<String> {
    let path = base_dir.join("runner_id");
    match crate::private_fs::read_private_file_to_string(&path).await? {
        Some(contents) => {
            let id = contents.trim().to_string();
            Uuid::parse_str(&id).map_err(|e| {
                RunnerError::Config(format!("invalid runner_id in {}: {e}", path.display()))
            })?;
            Ok(id)
        }
        None => {
            let id = Uuid::new_v4().to_string();
            crate::private_fs::write_private_file(&path, id.as_bytes()).await?;
            info!(runner_id = %id, "generated new runner ID");
            Ok(id)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn runner_id_generate_and_persist() {
        let dir = tempfile::tempdir().unwrap();
        let id1 = load_or_generate_runner_id(dir.path()).await.unwrap();
        assert!(Uuid::parse_str(&id1).is_ok());

        // Second call reads the same ID
        let id2 = load_or_generate_runner_id(dir.path()).await.unwrap();
        assert_eq!(id1, id2);
    }

    #[tokio::test]
    async fn runner_id_reads_existing() {
        let dir = tempfile::tempdir().unwrap();
        let expected = Uuid::new_v4().to_string();
        tokio::fs::write(dir.path().join("runner_id"), &expected)
            .await
            .unwrap();
        let id = load_or_generate_runner_id(dir.path()).await.unwrap();
        assert_eq!(id, expected);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runner_id_rejects_symlink_without_reading_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("outside-runner-id");
        let link = dir.path().join("runner_id");
        let outside_id = Uuid::new_v4().to_string();
        tokio::fs::write(&target, &outside_id).await.unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let result = load_or_generate_runner_id(dir.path()).await;

        assert!(result.is_err());
        assert_eq!(
            tokio::fs::read_to_string(&target).await.unwrap(),
            outside_id
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runner_id_rejects_fifo_without_blocking() {
        use std::os::unix::ffi::OsStrExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runner_id");
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
        assert_eq!(
            result,
            0,
            "mkfifo failed: {}",
            std::io::Error::last_os_error()
        );

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            load_or_generate_runner_id(dir.path()),
        )
        .await
        .expect("runner_id FIFO should not block");

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn runner_id_rejects_invalid() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("runner_id"), "not-a-uuid")
            .await
            .unwrap();
        let result = load_or_generate_runner_id(dir.path()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn runner_id_trims_whitespace() {
        let dir = tempfile::tempdir().unwrap();
        let expected = Uuid::new_v4().to_string();
        // Write with trailing newline (common with echo/editors)
        tokio::fs::write(dir.path().join("runner_id"), format!("  {expected}\n"))
            .await
            .unwrap();
        let id = load_or_generate_runner_id(dir.path()).await.unwrap();
        assert_eq!(id, expected);
    }

    #[tokio::test]
    async fn runner_id_rejects_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("runner_id"), "")
            .await
            .unwrap();
        let result = load_or_generate_runner_id(dir.path()).await;
        assert!(result.is_err());
    }
}
