use std::path::Path;

use async_trait::async_trait;

use sandbox::{SnapshotCreateConfig, SnapshotError, SnapshotOutput, SnapshotProvider};

use crate::factory::config_hash;
use crate::paths::SnapshotOutputPaths;
use crate::snapshot;

/// Firecracker-backed snapshot provider.
///
/// Stateless — can be created with zero cost and used immediately.
pub struct FirecrackerSnapshotProvider;

#[async_trait]
impl SnapshotProvider for FirecrackerSnapshotProvider {
    async fn create_snapshot(
        &self,
        config: SnapshotCreateConfig,
    ) -> Result<SnapshotOutput, SnapshotError> {
        let fc_config = snapshot::SnapshotCreateConfig {
            id: config.id,
            binary_path: config.binary_path,
            kernel_path: config.kernel_path,
            rootfs_path: config.rootfs_path,
            output_dir: config.output_dir,
            vcpu_count: config.vcpu_count,
            memory_mb: config.memory_mb,
        };
        let sc = snapshot::create_snapshot(fc_config)
            .await
            .map_err(|e| match e {
                snapshot::SnapshotError::Setup(msg) => SnapshotError::Setup(msg),
                snapshot::SnapshotError::Process(msg) => SnapshotError::Process(msg),
                snapshot::SnapshotError::Api(api_err) => SnapshotError::Api(api_err.to_string()),
                snapshot::SnapshotError::Vsock(msg) => SnapshotError::Vsock(msg),
                snapshot::SnapshotError::Io(io_err) => SnapshotError::Io(io_err),
            })?;
        Ok(SnapshotOutput {
            snapshot_path: sc.snapshot_path,
            memory_path: sc.memory_path,
            cow_path: sc.cow_path,
        })
    }

    fn config_hash(&self) -> String {
        config_hash()
    }

    async fn is_complete(&self, output_dir: &Path) -> Result<bool, SnapshotError> {
        let output = SnapshotOutputPaths::new(output_dir.to_path_buf());
        for path in [output.snapshot(), output.memory(), output.cow()] {
            let exists = tokio::fs::try_exists(&path).await?;
            if !exists {
                return Ok(false);
            }
        }
        Ok(true)
    }
}
