use std::path::PathBuf;

use ::sandbox::*;
use async_trait::async_trait;

/// A minimal `SnapshotProvider` for tests that need snapshot output wiring.
///
/// This mock intentionally does not create a reusable snapshot:
///
/// - It retains only `config.output_dir` from the snapshot configuration.
/// - Its default `SnapshotProvider::create_snapshot` implementation returns
///   `snapshot.bin`, `memory.bin`, and `cow.img` paths below `output_dir`, but
///   does not create those files.
/// - `PendingSnapshotPublish::commit` and `PendingSnapshotPublish::discard`
///   have no filesystem side effects.
/// - `SnapshotProvider::config_hash` always returns
///   `mock-snapshot-config-hash`.
/// - `SnapshotProvider::is_complete` always returns `false`, regardless of
///   the supplied output directory.
///
/// Use it for output wiring and default publish-flow tests. It does not model
/// reusable snapshots or cache-hit state.
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
