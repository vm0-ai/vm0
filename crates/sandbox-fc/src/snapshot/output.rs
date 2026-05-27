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
    let marker = output.complete_marker();
    let mut marker_created = false;

    let result = (|| -> std::io::Result<()> {
        for artifact in [
            output.snapshot(),
            output.memory(),
            output.cow(),
            output.cow_bitmap(),
        ] {
            std::fs::metadata(artifact)?;
        }

        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker)?;
        marker_created = true;
        file.write_all(SNAPSHOT_COMPLETE_MARKER_CONTENT)?;
        file.sync_all()?;
        drop(file);

        std::fs::File::open(output.dir())?.sync_all()?;
        Ok(())
    })();

    if let Err(e) = result {
        if marker_created {
            // If marker publication fails after creating the file, remove it so
            // future readers do not treat an uncommitted publish as complete.
            let _ = std::fs::remove_file(&marker);
            let _ = std::fs::File::open(output.dir()).and_then(|dir| dir.sync_all());
        }
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

#[cfg(test)]
mod tests {
    use crate::paths::SnapshotOutputPaths;

    use super::*;

    async fn write_required_snapshot_artifacts(output: &SnapshotOutputPaths) {
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
    }

    #[tokio::test]
    async fn prepare_snapshot_output_removes_snapshot_artifacts_only() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
        let stale_work_file = output.work_dir().join("nested").join("stale.txt");
        let unrelated = dir.path().join("keep.txt");

        tokio::fs::create_dir_all(stale_work_file.parent().expect("parent"))
            .await
            .expect("create stale work dir");
        tokio::fs::write(&stale_work_file, b"stale")
            .await
            .expect("write stale work file");
        tokio::fs::write(&unrelated, b"keep")
            .await
            .expect("write unrelated file");
        for artifact in [
            output.snapshot(),
            output.memory(),
            output.cow(),
            output.cow_bitmap(),
            output.complete_marker(),
        ] {
            tokio::fs::write(&artifact, b"stale")
                .await
                .unwrap_or_else(|e| panic!("write {}: {e}", artifact.display()));
        }

        let work = prepare_snapshot_output(&output)
            .await
            .expect("prepare output");

        assert_eq!(work, output.work_dir());
        assert!(
            tokio::fs::try_exists(output.work_dir()).await.unwrap(),
            "work dir should be recreated"
        );
        assert!(
            !tokio::fs::try_exists(stale_work_file).await.unwrap(),
            "stale work contents should be removed"
        );
        for artifact in [
            output.snapshot(),
            output.memory(),
            output.cow(),
            output.cow_bitmap(),
            output.complete_marker(),
        ] {
            assert!(
                !tokio::fs::try_exists(&artifact).await.unwrap(),
                "stale artifact should be removed: {}",
                artifact.display()
            );
        }
        assert!(
            tokio::fs::try_exists(unrelated).await.unwrap(),
            "non-snapshot output-dir contents should be preserved"
        );
    }

    #[tokio::test]
    async fn publish_snapshot_complete_marker_writes_expected_content() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
        write_required_snapshot_artifacts(&output).await;

        publish_snapshot_complete_marker(&output).expect("publish complete marker");

        let marker = tokio::fs::read(output.complete_marker())
            .await
            .expect("read complete marker");
        assert_eq!(marker, SNAPSHOT_COMPLETE_MARKER_CONTENT);
    }

    #[tokio::test]
    async fn publish_snapshot_complete_marker_rejects_missing_artifact_without_marker() {
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

        let err = publish_snapshot_complete_marker(&output)
            .expect_err("publish should fail before marker");

        assert!(matches!(err, SnapshotError::Io(_)), "got: {err:?}");
        assert!(
            !tokio::fs::try_exists(output.complete_marker())
                .await
                .unwrap(),
            "missing artifact must not publish complete marker"
        );
    }

    #[tokio::test]
    async fn publish_snapshot_complete_marker_preserves_existing_marker_on_validation_failure() {
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
        tokio::fs::write(output.complete_marker(), SNAPSHOT_COMPLETE_MARKER_CONTENT)
            .await
            .expect("write existing marker");

        let err = publish_snapshot_complete_marker(&output)
            .expect_err("publish should fail before marker creation");

        assert!(matches!(err, SnapshotError::Io(_)), "got: {err:?}");
        let marker = tokio::fs::read(output.complete_marker())
            .await
            .expect("read existing marker");
        assert_eq!(marker, SNAPSHOT_COMPLETE_MARKER_CONTENT);
    }

    #[tokio::test]
    async fn publish_snapshot_complete_marker_preserves_existing_marker_on_create_failure() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
        write_required_snapshot_artifacts(&output).await;
        tokio::fs::write(output.complete_marker(), SNAPSHOT_COMPLETE_MARKER_CONTENT)
            .await
            .expect("write existing marker");

        let err =
            publish_snapshot_complete_marker(&output).expect_err("publish should fail on marker");

        assert!(matches!(err, SnapshotError::Io(_)), "got: {err:?}");
        let marker = tokio::fs::read(output.complete_marker())
            .await
            .expect("read existing marker");
        assert_eq!(marker, SNAPSHOT_COMPLETE_MARKER_CONTENT);
    }

    #[tokio::test]
    async fn snapshot_complete_marker_present_checks_exact_marker_content() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
        tokio::fs::create_dir_all(output.dir())
            .await
            .expect("create output dir");

        assert!(
            !snapshot_complete_marker_present(&output)
                .await
                .expect("check missing marker")
        );

        tokio::fs::write(output.complete_marker(), b"wrong marker")
            .await
            .expect("write malformed marker");
        assert!(
            !snapshot_complete_marker_present(&output)
                .await
                .expect("check malformed marker")
        );

        tokio::fs::write(output.complete_marker(), SNAPSHOT_COMPLETE_MARKER_CONTENT)
            .await
            .expect("write valid marker");
        assert!(
            snapshot_complete_marker_present(&output)
                .await
                .expect("check valid marker")
        );
    }

    #[tokio::test]
    async fn snapshot_complete_marker_present_propagates_read_errors() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output = SnapshotOutputPaths::new(dir.path().to_path_buf());
        tokio::fs::create_dir_all(output.complete_marker())
            .await
            .expect("create marker directory");

        let _err = snapshot_complete_marker_present(&output)
            .await
            .expect_err("marker directory should fail to read as marker content");
    }
}
