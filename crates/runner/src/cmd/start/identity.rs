use std::path::Path;

use tracing::info;
use uuid::Uuid;

use crate::error::{RunnerError, RunnerResult};

const MAX_HEARTBEAT_ORDER_VALUE: u64 = 9_007_199_254_740_991;

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

/// Increment and persist the process generation used to order heartbeat snapshots.
///
/// The caller holds the exclusive runner base-directory lock, so generation
/// allocation has one writer for the lifetime of this runner identity.
pub(super) async fn next_heartbeat_generation(base_dir: &Path) -> RunnerResult<u64> {
    let path = base_dir.join("heartbeat_generation");
    let previous = match crate::private_fs::read_private_file_to_string(&path).await? {
        Some(contents) => contents.trim().parse::<u64>().map_err(|error| {
            RunnerError::Config(format!(
                "invalid heartbeat generation in {}: {error}",
                path.display()
            ))
        })?,
        None => 0,
    };
    let generation = previous
        .checked_add(1)
        .filter(|generation| *generation <= MAX_HEARTBEAT_ORDER_VALUE)
        .ok_or_else(|| {
            RunnerError::Config(format!(
                "heartbeat generation in {} exceeds the wire safe-integer range",
                path.display()
            ))
        })?;
    crate::private_fs::write_private_file(&path, generation.to_string().as_bytes()).await?;
    Ok(generation)
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

    #[tokio::test]
    async fn heartbeat_generation_increments_across_starts() {
        let dir = tempfile::tempdir().unwrap();

        assert_eq!(next_heartbeat_generation(dir.path()).await.unwrap(), 1);
        assert_eq!(next_heartbeat_generation(dir.path()).await.unwrap(), 2);
        assert_eq!(
            tokio::fs::read_to_string(dir.path().join("heartbeat_generation"))
                .await
                .unwrap(),
            "2"
        );
    }

    #[tokio::test]
    async fn heartbeat_generation_rejects_invalid_or_exhausted_state() {
        for value in [
            "not-a-number",
            "-1",
            "9007199254740991",
            "9007199254740992",
            "18446744073709551615",
        ] {
            let dir = tempfile::tempdir().unwrap();
            tokio::fs::write(dir.path().join("heartbeat_generation"), value)
                .await
                .unwrap();

            let result = next_heartbeat_generation(dir.path()).await;

            assert!(result.is_err(), "generation state {value:?} must fail");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn heartbeat_generation_rejects_symlink_without_replacing_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("outside-heartbeat-generation");
        let link = dir.path().join("heartbeat_generation");
        tokio::fs::write(&target, "41").await.unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let result = next_heartbeat_generation(dir.path()).await;

        assert!(result.is_err());
        assert_eq!(tokio::fs::read_to_string(&target).await.unwrap(), "41");
    }
}
