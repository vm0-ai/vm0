use std::io::Write;
use std::path::{Path, PathBuf};

use crate::paths::SnapshotOutputPaths;

use super::SnapshotError;

pub const SNAPSHOT_COMPLETE_MARKER_CONTENT: &[u8] = b"snapshot-complete-v1\n";

pub(super) fn remove_file_if_exists_sync(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

pub(super) fn remove_dir_all_if_exists_sync(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

pub(super) fn cleanup_remove_file_result(
    result: std::io::Result<()>,
    path: &Path,
    warning: &'static str,
) -> bool {
    match result {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => {
            tracing::warn!(
                error = %e,
                path = %path.display(),
                "{warning}"
            );
            false
        }
    }
}

pub(super) fn cleanup_remove_dir_result(
    result: std::io::Result<()>,
    dir: &Path,
    warning: &'static str,
) -> bool {
    match result {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => {
            tracing::warn!(
                error = %e,
                dir = %dir.display(),
                "{warning}"
            );
            false
        }
    }
}

pub(super) async fn prepare_snapshot_output(
    output: &SnapshotOutputPaths,
) -> Result<PathBuf, SnapshotError> {
    // Paths inside work_dir get baked into the snapshot and are used as
    // bind-mount targets during restore, so they must be deterministic.
    //
    // Only remove snapshot-specific artifacts, not the entire output directory.
    //
    // Use synchronous filesystem calls for shared snapshot-hash paths while the
    // caller holds the snapshot lock. A cancelled Tokio fs operation can keep
    // running on the blocking pool after the lock is dropped.
    let work = output.work_dir();
    remove_file_if_exists_sync(&output.complete_marker())?;
    let _ = remove_dir_all_if_exists_sync(&work);
    for stale in [
        output.snapshot(),
        output.memory(),
        output.cow(),
        output.cow_bitmap(),
    ] {
        let _ = remove_file_if_exists_sync(&stale);
    }
    std::fs::create_dir_all(&work)?;
    Ok(work)
}

pub(super) fn sync_snapshot_output_dir(output: &SnapshotOutputPaths) -> Result<(), SnapshotError> {
    std::fs::File::open(output.dir())?.sync_all()?;
    Ok(())
}

pub(super) fn publish_snapshot_complete_marker(
    output: &SnapshotOutputPaths,
) -> Result<(), SnapshotError> {
    fn write_and_sync(output: &SnapshotOutputPaths) -> std::io::Result<()> {
        for artifact in [
            output.snapshot(),
            output.memory(),
            output.cow(),
            output.cow_bitmap(),
        ] {
            std::fs::metadata(artifact)?;
        }

        let marker = output.complete_marker();
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker)?;
        file.write_all(SNAPSHOT_COMPLETE_MARKER_CONTENT)?;
        file.sync_all()?;
        drop(file);

        std::fs::File::open(output.dir())?.sync_all()?;
        Ok(())
    }

    if let Err(e) = write_and_sync(output) {
        // If marker publication fails after creating the file, remove it so
        // future readers do not treat an uncommitted publish as complete.
        let _ = std::fs::remove_file(output.complete_marker());
        let _ = std::fs::File::open(output.dir()).and_then(|dir| dir.sync_all());
        return Err(SnapshotError::Io(e));
    }

    Ok(())
}

pub(super) async fn snapshot_complete_marker_present(
    output: &SnapshotOutputPaths,
) -> Result<bool, sandbox::SnapshotError> {
    match tokio::fs::read(output.complete_marker()).await {
        Ok(content) => Ok(content == SNAPSHOT_COMPLETE_MARKER_CONTENT),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}
