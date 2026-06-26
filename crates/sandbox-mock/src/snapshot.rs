use std::path::PathBuf;

use ::sandbox::*;
use async_trait::async_trait;

/// A mock [`SnapshotProvider`] that returns dummy paths.
pub struct MockSnapshotProvider;

struct MockPendingSnapshotPublish {
    output_dir: PathBuf,
}

#[async_trait]
impl PendingSnapshotPublish for MockPendingSnapshotPublish {
    async fn commit(&mut self) -> std::result::Result<SnapshotOutput, SnapshotError> {
        Ok(SnapshotOutput {
            snapshot_path: self.output_dir.join("snapshot.bin"),
            memory_path: self.output_dir.join("memory.bin"),
            cow_path: self.output_dir.join("cow.img"),
        })
    }

    async fn discard(&mut self) -> std::result::Result<(), SnapshotError> {
        Ok(())
    }
}

#[async_trait]
impl SnapshotProvider for MockSnapshotProvider {
    async fn create_uncommitted_snapshot(
        &self,
        config: SnapshotCreateConfig,
    ) -> std::result::Result<Box<dyn PendingSnapshotPublish>, SnapshotError> {
        Ok(Box::new(MockPendingSnapshotPublish {
            output_dir: config.output_dir,
        }))
    }

    fn config_hash(&self) -> String {
        "mock-snapshot-config-hash".into()
    }

    async fn is_complete(
        &self,
        _output_dir: &std::path::Path,
    ) -> std::result::Result<bool, SnapshotError> {
        Ok(false)
    }
}
