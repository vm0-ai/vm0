use std::path::Path;

use async_trait::async_trait;
use sandbox::{PendingSnapshotPublish, SnapshotCreateConfig, SnapshotProvider};

use crate::factory::config_hash;
use crate::paths::SnapshotOutputPaths;

use super::output::snapshot_complete_marker_present;
use super::{SnapshotError, create_uncommitted_snapshot};

/// Firecracker-backed snapshot provider.
///
/// Stateless — can be created with zero cost and used immediately.
pub struct FirecrackerSnapshotProvider;

#[async_trait]
impl SnapshotProvider for FirecrackerSnapshotProvider {
    async fn create_uncommitted_snapshot(
        &self,
        config: SnapshotCreateConfig,
    ) -> Result<Box<dyn PendingSnapshotPublish>, sandbox::SnapshotError> {
        let publish = create_uncommitted_snapshot(config)
            .await
            .map_err(SnapshotError::into_sandbox_error)?;
        Ok(Box::new(publish))
    }

    fn config_hash(&self) -> String {
        config_hash()
    }

    async fn is_complete(&self, output_dir: &Path) -> Result<bool, sandbox::SnapshotError> {
        let output = SnapshotOutputPaths::new(output_dir.to_path_buf());
        if !snapshot_complete_marker_present(&output).await? {
            return Ok(false);
        }
        for path in [
            output.snapshot(),
            output.memory(),
            output.cow(),
            output.cow_bitmap(),
        ] {
            let exists = tokio::fs::try_exists(&path).await?;
            if !exists {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use sandbox::SnapshotProvider;

    use crate::paths::SnapshotOutputPaths;
    use crate::snapshot::output::publish_snapshot_complete_marker;

    use super::*;

    #[tokio::test]
    async fn snapshot_provider_requires_cow_bitmap_for_complete_snapshot() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
        tokio::fs::create_dir_all(output.dir())
            .await
            .expect("create output dir");

        for artifact in [output.snapshot(), output.memory(), output.cow()] {
            tokio::fs::write(&artifact, b"snapshot artifact")
                .await
                .unwrap_or_else(|e| panic!("write {}: {e}", artifact.display()));
        }

        let provider = FirecrackerSnapshotProvider;
        assert!(
            !provider.is_complete(output.dir()).await.unwrap(),
            "snapshot without dirty bitmap sidecar must be incomplete"
        );
        assert!(
            publish_snapshot_complete_marker(&output).is_err(),
            "complete marker publication must fail before all artifacts exist"
        );
        assert!(
            !tokio::fs::try_exists(output.complete_marker())
                .await
                .unwrap(),
            "failed marker publication must not leave a marker behind"
        );

        tokio::fs::write(output.cow_bitmap(), b"bitmap")
            .await
            .expect("write cow bitmap");
        publish_snapshot_complete_marker(&output).expect("publish complete marker");
        assert!(provider.is_complete(output.dir()).await.unwrap());
    }

    #[tokio::test]
    async fn snapshot_provider_requires_complete_marker_for_complete_snapshot() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
        tokio::fs::create_dir_all(output.dir())
            .await
            .expect("create output dir");

        for artifact in [
            output.snapshot(),
            output.memory(),
            output.cow(),
            output.cow_bitmap(),
        ] {
            tokio::fs::write(&artifact, b"snapshot artifact")
                .await
                .unwrap_or_else(|e| panic!("write {}: {e}", artifact.display()));
        }

        let provider = FirecrackerSnapshotProvider;
        assert!(
            !provider.is_complete(output.dir()).await.unwrap(),
            "snapshot artifacts without complete marker must be incomplete"
        );

        tokio::fs::write(output.complete_marker(), b"wrong marker")
            .await
            .expect("write malformed marker");
        assert!(
            !provider.is_complete(output.dir()).await.unwrap(),
            "malformed complete marker must not commit the snapshot"
        );

        tokio::fs::remove_file(output.complete_marker())
            .await
            .expect("remove malformed marker");
        publish_snapshot_complete_marker(&output).expect("publish complete marker");
        assert!(provider.is_complete(output.dir()).await.unwrap());
    }

    #[tokio::test]
    async fn snapshot_provider_rejects_valid_marker_with_missing_artifact() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
        tokio::fs::create_dir_all(output.dir())
            .await
            .expect("create output dir");

        for artifact in [
            output.snapshot(),
            output.memory(),
            output.cow(),
            output.cow_bitmap(),
        ] {
            tokio::fs::write(&artifact, b"snapshot artifact")
                .await
                .unwrap_or_else(|e| panic!("write {}: {e}", artifact.display()));
        }
        publish_snapshot_complete_marker(&output).expect("publish complete marker");
        tokio::fs::remove_file(output.cow_bitmap())
            .await
            .expect("remove cow bitmap");

        let provider = FirecrackerSnapshotProvider;
        assert!(
            !provider.is_complete(output.dir()).await.unwrap(),
            "valid marker must not hide a missing snapshot artifact"
        );
    }
}
