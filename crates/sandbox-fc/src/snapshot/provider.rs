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
