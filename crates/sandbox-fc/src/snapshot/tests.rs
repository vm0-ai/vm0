use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nbd_cow::KeptCow;
use nbd_cow::pool::DevicePoolHandle;
use sandbox::{PendingSnapshotPublish, SnapshotProvider};

use crate::api::ApiError;
use crate::config::SnapshotConfig;
use crate::paths::{SandboxPaths, SnapshotOutputPaths, SockPaths};

use super::attempt::*;
use super::cow::*;
use super::output::*;
use super::provider::FirecrackerSnapshotProvider;
use super::publish::*;
use super::runtime::*;
use super::{SNAPSHOT_COMPLETE_MARKER_CONTENT, SnapshotError};

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

async fn write_required_snapshot_artifacts(output: &SnapshotOutputPaths) {
    tokio::fs::create_dir_all(output.dir())
        .await
        .expect("create output dir");
    for artifact in [output.snapshot(), output.memory()] {
        tokio::fs::write(&artifact, b"snapshot artifact")
            .await
            .unwrap_or_else(|e| panic!("write {}: {e}", artifact.display()));
    }
}

async fn write_kept_cow_for_test(work: &Path, token: &str) -> KeptCow {
    let cow_file = snapshot_attempt_cow_file(work, token);
    let bitmap_file = cow_file.with_file_name("cow.img.bitmap");
    let attempt_dir = cow_file.parent().expect("attempt dir");
    tokio::fs::create_dir_all(attempt_dir)
        .await
        .expect("create attempt dir");
    tokio::fs::write(&cow_file, b"cow")
        .await
        .expect("write cow");
    tokio::fs::write(&bitmap_file, b"bitmap")
        .await
        .expect("write bitmap");
    KeptCow {
        cow_file,
        bitmap_file,
    }
}

#[tokio::test]
async fn snapshot_publish_commit_moves_cow_and_writes_complete_marker() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "publish-ok").await;
    let attempt_dir = kept_cow
        .cow_file
        .parent()
        .expect("attempt dir")
        .to_path_buf();

    commit_snapshot_cow_output(&kept_cow, &output).expect("commit snapshot cow output");

    assert!(
        tokio::fs::try_exists(output.cow()).await.unwrap(),
        "stable cow should be published"
    );
    assert!(
        tokio::fs::try_exists(output.cow_bitmap()).await.unwrap(),
        "stable bitmap should be published"
    );
    assert!(
        !tokio::fs::try_exists(attempt_dir).await.unwrap(),
        "empty attempt dir should be removed after publish"
    );
    let marker = tokio::fs::read(output.complete_marker())
        .await
        .expect("read marker");
    assert_eq!(marker, SNAPSHOT_COMPLETE_MARKER_CONTENT);

    let provider = FirecrackerSnapshotProvider;
    assert!(provider.is_complete(output.dir()).await.unwrap());
}

#[tokio::test]
async fn pending_snapshot_publish_commit_writes_complete_marker() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "pending-commit").await;

    let mut pending: Box<dyn PendingSnapshotPublish> =
        Box::new(FirecrackerPendingSnapshotPublish::new(
            output.snapshot_config("pending-commit"),
            SnapshotOutputPaths::new(output.dir().to_path_buf()),
            kept_cow,
        ));

    let published = pending.commit().await.expect("commit pending publish");

    assert_eq!(published.snapshot_path, output.snapshot());
    assert_eq!(published.memory_path, output.memory());
    assert_eq!(published.cow_path, output.cow());
    assert!(
        tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "commit should write complete marker"
    );

    let provider = FirecrackerSnapshotProvider;
    assert!(provider.is_complete(output.dir()).await.unwrap());
}

#[tokio::test]
async fn pending_snapshot_publish_commit_failure_does_not_publish_marker() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    tokio::fs::create_dir_all(output.dir())
        .await
        .expect("create output dir");
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "pending-commit-fail").await;

    let mut pending: Box<dyn PendingSnapshotPublish> =
        Box::new(FirecrackerPendingSnapshotPublish::new(
            output.snapshot_config("pending-commit-fail"),
            SnapshotOutputPaths::new(output.dir().to_path_buf()),
            kept_cow,
        ));

    let err = pending
        .commit()
        .await
        .expect_err("pending commit should fail without snapshot and memory artifacts");
    assert!(matches!(err, sandbox::SnapshotError::Io(_)), "got: {err:?}");
    pending
        .discard()
        .await
        .expect("failed pending commit should keep cleanup state for discard");
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "failed pending commit must not write complete marker"
    );

    let provider = FirecrackerSnapshotProvider;
    assert!(
        !provider.is_complete(output.dir()).await.unwrap(),
        "failed pending commit must remain incomplete"
    );
}

#[tokio::test]
async fn pending_snapshot_publish_discard_does_not_publish_marker_or_stable_cow() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "pending-discard").await;
    let attempt_dir = kept_cow
        .cow_file
        .parent()
        .expect("attempt dir")
        .to_path_buf();

    let mut pending: Box<dyn PendingSnapshotPublish> =
        Box::new(FirecrackerPendingSnapshotPublish::new(
            output.snapshot_config("pending-discard"),
            SnapshotOutputPaths::new(output.dir().to_path_buf()),
            kept_cow,
        ));

    pending.discard().await.expect("discard pending publish");

    assert!(
        !tokio::fs::try_exists(output.snapshot()).await.unwrap(),
        "discard should remove uncommitted snapshot file"
    );
    assert!(
        !tokio::fs::try_exists(output.memory()).await.unwrap(),
        "discard should remove uncommitted memory file"
    );
    assert!(
        !tokio::fs::try_exists(output.cow()).await.unwrap(),
        "discard should not publish stable cow"
    );
    assert!(
        !tokio::fs::try_exists(output.cow_bitmap()).await.unwrap(),
        "discard should not publish stable cow bitmap"
    );
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "discard should not write complete marker"
    );
    assert!(
        !tokio::fs::try_exists(attempt_dir).await.unwrap(),
        "discard should remove temporary attempt dir"
    );
    assert!(
        !tokio::fs::try_exists(output.work_dir()).await.unwrap(),
        "discard should remove uncommitted snapshot work dir"
    );

    let provider = FirecrackerSnapshotProvider;
    assert!(!provider.is_complete(output.dir()).await.unwrap());
}

#[tokio::test]
async fn pending_snapshot_publish_discard_failure_keeps_cleanup_state_for_retry() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    let cow_file = snapshot_attempt_cow_file(&output.work_dir(), "pending-discard-retry");
    let attempt_dir = cow_file.parent().expect("attempt dir").to_path_buf();
    tokio::fs::create_dir_all(&cow_file)
        .await
        .expect("create cow path as directory");
    let bitmap_file = attempt_dir.join("cow.img.bitmap");
    tokio::fs::write(&bitmap_file, b"bitmap")
        .await
        .expect("write bitmap");
    let mut pending = FirecrackerPendingSnapshotPublish::new(
        output.snapshot_config("pending-discard-retry"),
        SnapshotOutputPaths::new(output.dir().to_path_buf()),
        KeptCow {
            cow_file: cow_file.clone(),
            bitmap_file: bitmap_file.clone(),
        },
    );

    pending
        .discard_inner()
        .await
        .expect_err("discard should fail when a temp artifact cannot be removed");

    assert!(
        !tokio::fs::try_exists(&bitmap_file).await.unwrap(),
        "failed discard should still remove cleanup work that succeeded"
    );
    assert!(
        tokio::fs::try_exists(&cow_file).await.unwrap(),
        "failed discard should leave the failed temp artifact for retry"
    );
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "failed discard must not publish marker"
    );

    tokio::fs::remove_dir(&cow_file)
        .await
        .expect("remove blocking cow directory");
    tokio::fs::write(&cow_file, b"cow")
        .await
        .expect("write retryable cow file");

    pending
        .discard_inner()
        .await
        .expect("retry should clean retained pending publish state");

    assert!(
        !tokio::fs::try_exists(attempt_dir).await.unwrap(),
        "retry should remove temporary attempt dir"
    );
    assert!(
        !tokio::fs::try_exists(output.cow()).await.unwrap(),
        "discard retry must not publish stable cow"
    );
    assert!(
        !tokio::fs::try_exists(output.cow_bitmap()).await.unwrap(),
        "discard retry must not publish stable cow bitmap"
    );
}

#[tokio::test]
async fn pending_snapshot_publish_discard_output_cleanup_failure_keeps_state_for_retry() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    tokio::fs::remove_file(output.snapshot())
        .await
        .expect("remove snapshot file");
    tokio::fs::create_dir(output.snapshot())
        .await
        .expect("replace snapshot file with directory");
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "pending-output-retry").await;
    let cow_file = kept_cow.cow_file.clone();
    let bitmap_file = kept_cow.bitmap_file.clone();
    let mut pending = FirecrackerPendingSnapshotPublish::new(
        output.snapshot_config("pending-output-retry"),
        SnapshotOutputPaths::new(output.dir().to_path_buf()),
        kept_cow,
    );

    pending
        .discard_inner()
        .await
        .expect_err("discard should fail when an output artifact cannot be removed");

    assert!(
        tokio::fs::metadata(output.snapshot())
            .await
            .expect("snapshot directory should remain")
            .is_dir(),
        "failed output cleanup should leave the blocking artifact for retry"
    );
    assert!(
        !tokio::fs::try_exists(&cow_file).await.unwrap(),
        "failed output cleanup should still remove temporary cow"
    );
    assert!(
        !tokio::fs::try_exists(&bitmap_file).await.unwrap(),
        "failed output cleanup should still remove temporary bitmap"
    );

    tokio::fs::remove_dir(output.snapshot())
        .await
        .expect("remove blocking snapshot directory");
    pending
        .discard_inner()
        .await
        .expect("retry should clean retained pending publish state");

    assert!(
        !tokio::fs::try_exists(output.snapshot()).await.unwrap(),
        "retry should leave no snapshot output"
    );
    assert!(
        !tokio::fs::try_exists(output.memory()).await.unwrap(),
        "retry should leave no memory output"
    );
    assert!(
        !tokio::fs::try_exists(output.work_dir()).await.unwrap(),
        "retry should leave no snapshot work dir"
    );
}

#[tokio::test]
async fn pending_snapshot_publish_drop_cleans_temp_without_publishing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "pending-drop").await;
    let attempt_dir = kept_cow
        .cow_file
        .parent()
        .expect("attempt dir")
        .to_path_buf();
    let cow_file = kept_cow.cow_file.clone();
    let bitmap_file = kept_cow.bitmap_file.clone();

    let pending = FirecrackerPendingSnapshotPublish::new(
        output.snapshot_config("pending-drop"),
        SnapshotOutputPaths::new(output.dir().to_path_buf()),
        kept_cow,
    );

    drop(pending);

    assert!(
        !tokio::fs::try_exists(&cow_file).await.unwrap(),
        "drop should cleanup temporary cow"
    );
    assert!(
        !tokio::fs::try_exists(&bitmap_file).await.unwrap(),
        "drop should cleanup temporary bitmap"
    );
    assert!(
        !tokio::fs::try_exists(attempt_dir).await.unwrap(),
        "drop should cleanup temporary attempt dir"
    );
    assert!(
        tokio::fs::try_exists(output.snapshot()).await.unwrap(),
        "drop must not cleanup stable snapshot output without the caller's lock"
    );
    assert!(
        tokio::fs::try_exists(output.memory()).await.unwrap(),
        "drop must not cleanup stable memory output without the caller's lock"
    );
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "drop must not write complete marker"
    );
    assert!(
        !tokio::fs::try_exists(output.cow()).await.unwrap(),
        "drop must not publish stable cow"
    );
}

#[tokio::test]
async fn snapshot_publish_commit_failure_does_not_leave_complete_marker() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    tokio::fs::create_dir_all(output.dir())
        .await
        .expect("create output dir");
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "missing-core-artifacts").await;

    let err = commit_snapshot_cow_output(&kept_cow, &output).expect_err("commit should fail");
    assert!(matches!(err, SnapshotError::Io(_)), "got: {err:?}");
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "failed publish must not leave complete marker"
    );

    let provider = FirecrackerSnapshotProvider;
    assert!(
        !provider.is_complete(output.dir()).await.unwrap(),
        "partial stable output without marker must remain incomplete"
    );
}

#[tokio::test]
async fn snapshot_publish_commit_failure_keeps_cleanup_state_for_partial_output() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    tokio::fs::create_dir_all(output.dir())
        .await
        .expect("create output dir");
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "commit-cleanup").await;
    let mut pending = FirecrackerPendingSnapshotPublish::new(
        output.snapshot_config("commit-cleanup"),
        SnapshotOutputPaths::new(output.dir().to_path_buf()),
        kept_cow,
    );

    let err = pending
        .commit_config()
        .await
        .expect_err("commit should fail without snapshot and memory artifacts");
    assert!(matches!(err, SnapshotError::Io(_)), "got: {err:?}");
    assert!(
        tokio::fs::try_exists(output.cow()).await.unwrap(),
        "failed marker publication may leave partial stable cow"
    );
    assert!(
        tokio::fs::try_exists(output.cow_bitmap()).await.unwrap(),
        "failed marker publication may leave partial stable bitmap"
    );

    pending
        .discard_inner()
        .await
        .expect("failed commit should keep cleanup state for discard");
    assert!(
        !tokio::fs::try_exists(output.cow()).await.unwrap(),
        "cleanup should remove partial stable cow after failed commit"
    );
    assert!(
        !tokio::fs::try_exists(output.cow_bitmap()).await.unwrap(),
        "cleanup should remove partial stable bitmap after failed commit"
    );
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "cleanup must not write marker for failed commit"
    );

    let provider = FirecrackerSnapshotProvider;
    assert!(
        !provider.is_complete(output.dir()).await.unwrap(),
        "partial stable output must remain incomplete"
    );
}

#[tokio::test]
async fn pending_snapshot_publish_discard_recovers_after_partial_bitmap_publish() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    tokio::fs::create_dir(output.cow())
        .await
        .expect("block cow rename with directory");
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "partial-bitmap").await;
    let cow_file = kept_cow.cow_file.clone();
    let bitmap_file = kept_cow.bitmap_file.clone();
    let mut pending = FirecrackerPendingSnapshotPublish::new(
        output.snapshot_config("partial-bitmap"),
        SnapshotOutputPaths::new(output.dir().to_path_buf()),
        kept_cow,
    );

    let err = pending
        .commit_config()
        .await
        .expect_err("commit should fail after publishing bitmap but before cow");
    assert!(matches!(err, SnapshotError::Io(_)), "got: {err:?}");
    assert!(
        tokio::fs::try_exists(output.cow_bitmap()).await.unwrap(),
        "failed commit should expose the partial stable bitmap"
    );
    assert!(
        !tokio::fs::try_exists(&bitmap_file).await.unwrap(),
        "bitmap rename should move the temp bitmap before commit fails"
    );

    pending
        .discard_inner()
        .await
        .expect_err("discard should keep state when blocking output cow directory remains");
    assert!(
        !tokio::fs::try_exists(output.cow_bitmap()).await.unwrap(),
        "discard should remove the partial stable bitmap"
    );
    assert!(
        !tokio::fs::try_exists(&cow_file).await.unwrap(),
        "discard should remove the remaining temp cow"
    );

    tokio::fs::remove_dir(output.cow())
        .await
        .expect("remove blocking cow directory");
    pending
        .discard_inner()
        .await
        .expect("retry should finish cleanup after blocking output is fixed");
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "failed commit cleanup must not publish marker"
    );
    assert!(
        !FirecrackerSnapshotProvider
            .is_complete(output.dir())
            .await
            .unwrap(),
        "partial bitmap publish must remain incomplete"
    );
}

#[tokio::test]
async fn snapshot_publish_cleanup_kept_cow_does_not_publish_stable_output() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "cleanup-kept").await;
    let mut publish_attempt = SnapshotPublishAttempt::new_with_kept_cow_for_test(kept_cow);

    assert!(publish_attempt.cleanup_after_cancellation().await);

    assert!(
        !tokio::fs::try_exists(output.cow()).await.unwrap(),
        "cancellation cleanup must not publish stable cow"
    );
    assert!(
        !tokio::fs::try_exists(output.cow_bitmap()).await.unwrap(),
        "cancellation cleanup must not publish stable bitmap"
    );
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "cancellation cleanup must not write complete marker"
    );

    let provider = FirecrackerSnapshotProvider;
    assert!(!provider.is_complete(output.dir()).await.unwrap());
}

#[tokio::test]
async fn snapshot_publish_cleanup_keeps_retry_state_when_temp_cleanup_fails() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    let cow_file = snapshot_attempt_cow_file(&output.work_dir(), "cleanup-retry");
    let attempt_dir = cow_file.parent().expect("attempt dir");
    tokio::fs::create_dir_all(&cow_file)
        .await
        .expect("create cow path as directory");
    let bitmap_file = attempt_dir.join("cow.img.bitmap");
    tokio::fs::write(&bitmap_file, b"bitmap")
        .await
        .expect("write bitmap");
    let mut publish_attempt = SnapshotPublishAttempt::new_with_kept_cow_for_test(KeptCow {
        cow_file,
        bitmap_file,
    });

    assert!(
        !publish_attempt.cleanup_after_cancellation().await,
        "cleanup should report failure when a temp artifact cannot be removed"
    );
    assert!(
        publish_attempt.has_cleanup_work(),
        "failed temp cleanup must retain publish state for a later retry"
    );
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "failed cleanup must not publish marker"
    );
}

#[tokio::test]
async fn snapshot_publish_cleanup_keep_cow_error_does_not_publish() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    let mut publish_attempt = SnapshotPublishAttempt::new_with_keep_future_for_test(async move {
        Err(nbd_cow::error::NbdCowError::Io(std::io::Error::other(
            "keep cow failed",
        )))
    });

    assert!(
        !publish_attempt.cleanup_after_cancellation().await,
        "keep-COW failure should report cleanup failure"
    );
    assert!(
        !publish_attempt.has_cleanup_work(),
        "failed keep-COW finalizer has already resolved the NBD lease path"
    );
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "failed keep-COW cleanup must not write marker"
    );

    let provider = FirecrackerSnapshotProvider;
    assert!(!provider.is_complete(output.dir()).await.unwrap());
}

#[tokio::test]
async fn snapshot_publish_cleanup_waits_for_keep_cow_without_committing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    write_required_snapshot_artifacts(&output).await;
    let kept_cow = write_kept_cow_for_test(&output.work_dir(), "pending-keep").await;
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (kept_tx, kept_rx) = tokio::sync::oneshot::channel();
    let mut publish_attempt = SnapshotPublishAttempt::new_with_keep_future_for_test(async move {
        let _ = started_tx.send(());
        kept_rx.await.map_err(|_| {
            nbd_cow::error::NbdCowError::Io(std::io::Error::other("test sender dropped"))
        })
    });

    let cleanup_task =
        tokio::spawn(async move { publish_attempt.cleanup_after_cancellation().await });
    started_rx
        .await
        .expect("keep-COW finalizer should be polled");
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "pending publish cleanup must not write marker before keep-COW resolves"
    );

    kept_tx.send(kept_cow).expect("send kept cow");
    assert!(
        cleanup_task.await.expect("cleanup task should join"),
        "cleanup should succeed after keep-COW resolves"
    );
    assert!(
        !tokio::fs::try_exists(output.cow()).await.unwrap(),
        "cleanup must not publish stable cow after keep-COW resolves"
    );
    assert!(
        !tokio::fs::try_exists(output.cow_bitmap()).await.unwrap(),
        "cleanup must not publish stable bitmap after keep-COW resolves"
    );
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "cleanup must not write complete marker after keep-COW resolves"
    );
}

#[tokio::test]
async fn snapshot_cleanup_finalizer_resolves_publish_before_device_pool_cleanup() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut attempt, _sock_dir) = snapshot_attempt_for_test(&dir);
    let kept_cow =
        write_kept_cow_for_test(&attempt.output().work_dir(), "publish-before-device-pool").await;
    let (tx, rx) = tokio::sync::oneshot::channel();

    attempt.track_publish_attempt_for_test(SnapshotPublishAttempt::new_with_kept_cow_for_test(
        kept_cow,
    ));
    attempt.track_device_pool_for_test(DevicePoolHandle::new(
        nbd_cow::pool::DevicePoolConfig::default(),
    ));
    attempt.notify_cleanup_complete_for_test(tx);

    drop(attempt);
    let report = wait_for_snapshot_cleanup(rx).await;

    assert!(report.publish_cleaned);
    assert!(report.device_pool_cleaned);
    assert_eq!(
        report.cleanup_events,
        vec!["publish", "device_pool"],
        "publish cleanup must finish before device pool cleanup"
    );
}

#[tokio::test]
async fn snapshot_attempt_drop_handoff_cleans_publish_resolve_cancellation() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut attempt, _sock_dir) = snapshot_attempt_for_test(&dir);
    write_required_snapshot_artifacts(attempt.output()).await;
    let kept_cow = write_kept_cow_for_test(&attempt.output().work_dir(), "cancel-resolve").await;
    let cow_file = kept_cow.cow_file.clone();
    let bitmap_file = kept_cow.bitmap_file.clone();
    let output_dir = attempt.output().dir().to_path_buf();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (kept_tx, kept_rx) = tokio::sync::oneshot::channel();
    let (cleanup_tx, cleanup_rx) = tokio::sync::oneshot::channel();

    attempt.track_publish_attempt_for_test(SnapshotPublishAttempt::new_with_keep_future_for_test(
        async move {
            let _ = started_tx.send(());
            kept_rx.await.map_err(|_| {
                nbd_cow::error::NbdCowError::Io(std::io::Error::other("test sender dropped"))
            })
        },
    ));
    attempt.notify_cleanup_complete_for_test(cleanup_tx);

    let handle = tokio::spawn(async move { attempt.resolve_success_publish().await });
    started_rx
        .await
        .expect("keep-COW finalizer should be polled");
    handle.abort();
    let _ = handle.await;

    kept_tx.send(kept_cow).expect("send kept cow");
    let report = wait_for_snapshot_cleanup(cleanup_rx).await;
    let output = SnapshotOutputPaths::new(output_dir);

    assert!(report.publish_cleaned);
    assert!(
        !tokio::fs::try_exists(&cow_file).await.unwrap(),
        "cancellation cleanup should remove temporary cow"
    );
    assert!(
        !tokio::fs::try_exists(&bitmap_file).await.unwrap(),
        "cancellation cleanup should remove temporary bitmap"
    );
    assert!(
        !tokio::fs::try_exists(output.complete_marker())
            .await
            .unwrap(),
        "cancellation cleanup must not publish complete marker"
    );
}

#[test]
fn snapshot_attempt_cow_file_is_attempt_scoped() {
    let work = std::path::Path::new("/tmp/snapshot-work");

    assert_eq!(
        snapshot_attempt_cow_file(work, "abc123ef"),
        work.join("attempts").join("abc123ef").join("cow.img")
    );
    assert_ne!(
        snapshot_attempt_cow_file(work, "abc123ef"),
        work.join("cow.img")
    );
}

#[test]
fn snapshot_attempt_dir_guard_removes_unowned_attempt_dir() {
    let dir = tempfile::tempdir().expect("tempdir");
    let attempt_dir = dir.path().join("work").join("attempts").join("abc123ef");
    std::fs::create_dir_all(&attempt_dir).expect("create attempt dir");
    std::fs::write(attempt_dir.join("cow.img"), b"partial cow").expect("write cow");

    {
        let _guard = SnapshotAttemptDirGuard::new(attempt_dir.clone());
    }

    assert!(
        !attempt_dir.exists(),
        "unowned attempt dir should be removed on cancellation"
    );
}

#[test]
fn snapshot_attempt_dir_guard_disarm_preserves_owned_attempt_dir() {
    let dir = tempfile::tempdir().expect("tempdir");
    let attempt_dir = dir.path().join("work").join("attempts").join("abc123ef");
    std::fs::create_dir_all(&attempt_dir).expect("create attempt dir");

    {
        let mut guard = SnapshotAttemptDirGuard::new(attempt_dir.clone());
        guard.disarm();
    }

    assert!(
        attempt_dir.exists(),
        "disarmed attempt dir guard should leave the owned dir intact"
    );
}

#[tokio::test]
async fn snapshot_cow_cleanup_finalizer_continues_after_future_drop() {
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();

    let finalizer = SnapshotCowCleanupFinalizer::new(tokio::spawn(async move {
        let _ = started_tx.send(());
        finish_rx.await.map_err(|e| {
            nbd_cow::error::NbdCowError::Io(std::io::Error::other(format!(
                "test cleanup finalizer release dropped: {e}"
            )))
        })?;
        let _ = done_tx.send(());
        Ok(())
    }));

    started_rx
        .await
        .expect("cleanup finalizer task should start");
    drop(finalizer);
    finish_tx.send(()).expect("release cleanup finalizer");
    tokio::time::timeout(Duration::from_secs(1), done_rx)
        .await
        .expect("dropped cleanup finalizer should continue")
        .expect("cleanup finalizer should finish");
}

#[tokio::test]
async fn abort_on_drop_task_aborts_vsock_listener() {
    let dir = tempfile::tempdir().expect("tempdir");
    let base = dir.path().join("snapshot-vsock");
    let listener =
        std::path::PathBuf::from(format!("{}_{}", base.display(), vsock_proto::VSOCK_PORT));
    let base = base.display().to_string();

    let task = AbortOnDropTask::new(tokio::spawn(async move {
        vsock_host::VsockHost::wait_for_connection(&base, Duration::from_secs(30)).await
    }));

    tokio::time::timeout(Duration::from_secs(1), async {
        while !listener.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("vsock listener should bind");

    drop(task);

    tokio::time::timeout(Duration::from_secs(1), async {
        while listener.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("dropped task should abort and remove vsock listener");
}

#[tokio::test]
async fn abort_on_drop_task_explicit_abort_removes_vsock_listener() {
    let dir = tempfile::tempdir().expect("tempdir");
    let base = dir.path().join("snapshot-vsock-explicit-abort");
    let listener =
        std::path::PathBuf::from(format!("{}_{}", base.display(), vsock_proto::VSOCK_PORT));
    let base = base.display().to_string();

    let task = AbortOnDropTask::new(tokio::spawn(async move {
        vsock_host::VsockHost::wait_for_connection(&base, Duration::from_secs(30)).await
    }));

    tokio::time::timeout(Duration::from_secs(1), async {
        while !listener.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("vsock listener should bind");

    task.abort();
    let join = task.await;
    assert!(
        join.is_err_and(|e| e.is_cancelled()),
        "explicit abort should cancel the listener task"
    );

    assert!(
        !listener.exists(),
        "explicit abort should remove the vsock listener socket"
    );
}

#[tokio::test]
async fn cleanup_snapshot_attempt_dir_removes_empty_token_dir() {
    let dir = tempfile::tempdir().expect("tempdir");
    let work = dir.path().join("work");
    let cow = snapshot_attempt_cow_file(&work, "abc123ef");
    let attempt_dir = cow.parent().expect("attempt dir").to_path_buf();
    tokio::fs::create_dir_all(&attempt_dir)
        .await
        .expect("create attempt dir");
    tokio::fs::write(&cow, b"cow").await.expect("write cow");
    tokio::fs::remove_file(&cow).await.expect("remove cow");

    assert!(cleanup_snapshot_attempt_dir_for_cow(&cow).await);
    assert!(
        !tokio::fs::try_exists(&attempt_dir).await.unwrap(),
        "empty attempt token dir should be removed after cow cleanup"
    );
}

#[tokio::test]
async fn cleanup_snapshot_attempt_dir_treats_missing_dir_as_clean() {
    let dir = tempfile::tempdir().expect("tempdir");
    let cow = snapshot_attempt_cow_file(&dir.path().join("work"), "missing");

    assert!(cleanup_snapshot_attempt_dir_for_cow(&cow).await);
}

#[tokio::test]
async fn cleanup_snapshot_attempt_dir_reports_nonempty_dir() {
    let dir = tempfile::tempdir().expect("tempdir");
    let work = dir.path().join("work");
    let cow = snapshot_attempt_cow_file(&work, "abc123ef");
    let attempt_dir = cow.parent().expect("attempt dir").to_path_buf();
    tokio::fs::create_dir_all(&attempt_dir)
        .await
        .expect("create attempt dir");
    tokio::fs::write(attempt_dir.join("extra"), b"keep")
        .await
        .expect("write extra");

    assert!(!cleanup_snapshot_attempt_dir_for_cow(&cow).await);
    assert!(
        tokio::fs::try_exists(&attempt_dir).await.unwrap(),
        "nonempty attempt dir should not be force removed"
    );
}

#[tokio::test]
async fn cleanup_existing_snapshot_sock_dir_removes_existing_dir() {
    let dir = tempfile::tempdir().expect("tempdir");
    let sock_dir = dir.path().join("sock");
    let stale_socket = sock_dir.join("api.sock");

    tokio::fs::create_dir_all(&sock_dir)
        .await
        .expect("create sock dir");
    tokio::fs::write(&stale_socket, b"stale")
        .await
        .expect("write stale socket placeholder");

    cleanup_existing_snapshot_sock_dir(&sock_dir).await;

    assert!(
        !tokio::fs::try_exists(&sock_dir).await.unwrap(),
        "stale socket directory should be removed"
    );

    cleanup_existing_snapshot_sock_dir(&sock_dir).await;
}

#[tokio::test]
async fn snapshot_attempt_routes_socket_cleanup_through_owner() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    let paths = SandboxPaths::new(output.work_dir());
    let sock_dir = dir.path().join("sock");
    let sock_paths = SockPaths::new(sock_dir.clone());
    let stale_socket = sock_dir.join("api.sock");
    let mut attempt = SnapshotAttempt::new_without_cow_for_test(paths, sock_paths, output);

    tokio::fs::create_dir_all(&sock_dir)
        .await
        .expect("create sock dir");
    tokio::fs::write(&stale_socket, b"stale")
        .await
        .expect("write stale socket placeholder");

    attempt.cleanup_sock_dir().await;
    attempt.cleanup_netns_pool().await;

    assert!(
        !tokio::fs::try_exists(&sock_dir).await.unwrap(),
        "snapshot attempt should own runtime socket cleanup"
    );
}

fn snapshot_attempt_for_test(dir: &tempfile::TempDir) -> (SnapshotAttempt, std::path::PathBuf) {
    let output = SnapshotOutputPaths::new(dir.path().join("output"));
    let paths = SandboxPaths::new(output.work_dir());
    let sock_dir = dir.path().join("sock");
    let sock_paths = SockPaths::new(sock_dir.clone());
    (
        SnapshotAttempt::new_without_cow_for_test(paths, sock_paths, output),
        sock_dir,
    )
}

async fn wait_for_snapshot_cleanup(
    rx: tokio::sync::oneshot::Receiver<SnapshotCleanupReport>,
) -> SnapshotCleanupReport {
    tokio::time::timeout(Duration::from_secs(5), rx)
        .await
        .expect("snapshot cleanup finalizer should complete")
        .expect("snapshot cleanup finalizer should report completion")
}

fn long_running_child_for_test() -> tokio::process::Child {
    tokio::process::Command::new("sh")
        .arg("-c")
        .arg("while true; do sleep 60; done")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .expect("spawn long-running child")
}

#[tokio::test]
async fn snapshot_attempt_drop_handoff_releases_netns_without_unlocked_sock_cleanup() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut attempt, sock_dir) = snapshot_attempt_for_test(&dir);
    let (tx, rx) = tokio::sync::oneshot::channel();

    attempt.track_network_for_test("test-snapshot-netns");
    attempt.notify_cleanup_complete_for_test(tx);
    tokio::fs::create_dir_all(&sock_dir)
        .await
        .expect("create sock dir");

    drop(attempt);
    let report = wait_for_snapshot_cleanup(rx).await;

    assert!(report.network_released);
    assert!(report.netns_pool_cleaned);
    assert!(
        tokio::fs::try_exists(&sock_dir).await.unwrap(),
        "detached cleanup must not remove the stable snapshot socket directory without the outer snapshot lock"
    );
}

#[tokio::test]
async fn snapshot_attempt_drop_handoff_kills_child_before_netns_release() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut attempt, sock_dir) = snapshot_attempt_for_test(&dir);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let child = long_running_child_for_test();

    attempt.track_network_for_test("test-snapshot-netns-child");
    attempt.track_child_for_test(child);
    attempt.notify_cleanup_complete_for_test(tx);
    tokio::fs::create_dir_all(&sock_dir)
        .await
        .expect("create sock dir");

    drop(attempt);
    let report = wait_for_snapshot_cleanup(rx).await;

    assert!(report.child_reaped);
    assert!(report.network_released);
    assert!(
        tokio::fs::try_exists(&sock_dir).await.unwrap(),
        "detached cleanup must not remove the stable snapshot socket directory without the outer snapshot lock"
    );
}

#[tokio::test]
async fn snapshot_attempt_drop_handoff_aborts_unfinished_forwarders() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut attempt, sock_dir) = snapshot_attempt_for_test(&dir);
    let (tx, rx) = tokio::sync::oneshot::channel();

    attempt.track_stdout_handle_for_test(tokio::spawn(std::future::pending::<()>()));
    attempt.track_stderr_handle_for_test(tokio::spawn(std::future::pending::<()>()));
    attempt.notify_cleanup_complete_for_test(tx);
    tokio::fs::create_dir_all(&sock_dir)
        .await
        .expect("create sock dir");

    drop(attempt);
    let report = wait_for_snapshot_cleanup(rx).await;

    assert!(report.stdout_forwarder_finished);
    assert!(report.stderr_forwarder_finished);
    assert!(
        tokio::fs::try_exists(&sock_dir).await.unwrap(),
        "detached cleanup must not remove the stable snapshot socket directory without the outer snapshot lock"
    );
}

#[tokio::test]
async fn drain_stderr_forwarder_after_spawn_exit_waits_for_failed_status() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let drained = Arc::new(AtomicBool::new(false));
    let drained_for_task = Arc::clone(&drained);
    let handle = tokio::spawn(async move {
        drained_for_task.store(true, Ordering::SeqCst);
    });

    let returned =
        drain_stderr_forwarder_after_spawn_exit(&Ok(Some(exit_status_nonzero())), Some(handle))
            .await;

    assert!(returned.is_none());
    assert!(drained.load(Ordering::SeqCst));
}

#[tokio::test]
async fn drain_stderr_forwarder_after_spawn_exit_preserves_other_handles() {
    async fn assert_handle_preserved(
        child_status: std::io::Result<Option<std::process::ExitStatus>>,
    ) {
        let handle = tokio::spawn(std::future::pending::<()>());

        let returned = drain_stderr_forwarder_after_spawn_exit(&child_status, Some(handle))
            .await
            .expect("handle should be preserved");

        assert!(
            !returned.is_finished(),
            "helper should not join or abort the forwarder"
        );
        returned.abort();
        let _ = returned.await;
    }

    assert_handle_preserved(Ok(None)).await;
    assert_handle_preserved(Ok(Some(exit_status_zero()))).await;
    assert_handle_preserved(Err(std::io::Error::from(std::io::ErrorKind::Interrupted))).await;
}

/// Empty stderr buffer should produce a sentinel string rather than
/// an empty error body. Verifies the early-exit error path is
/// always informative even with no captured output.
#[test]
fn drain_stderr_buf_reports_empty_with_sentinel() {
    let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));
    let s = drain_stderr_buf(&buf);
    assert!(s.contains("no stderr"), "got: {s}");
}

/// Captured lines are joined with newlines in insertion order.
#[test]
fn drain_stderr_buf_joins_lines() {
    let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));
    {
        let mut g = buf.lock().expect("lock");
        g.push_back("mount: bind failed".into());
        g.push_back("exit code 32".into());
    }
    assert_eq!(drain_stderr_buf(&buf), "mount: bind failed\nexit code 32");
}

/// Boundary: exactly `STDERR_BUF_LINES` entries — no eviction should
/// have happened, and all lines (including `line 0`) must be present.
/// Guards against off-by-one in the `if len == N { pop_front }` check.
#[test]
fn drain_stderr_buf_handles_exact_capacity() {
    let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));
    {
        let mut g = buf.lock().expect("lock");
        for i in 0..STDERR_BUF_LINES {
            if g.len() == STDERR_BUF_LINES {
                g.pop_front();
            }
            g.push_back(format!("line {i}"));
        }
    }
    let joined = drain_stderr_buf(&buf);
    assert!(
        joined.contains("line 0"),
        "line 0 should survive at exact capacity: {joined}"
    );
    assert!(
        joined.contains(&format!("line {}", STDERR_BUF_LINES - 1)),
        "last line should be present: {joined}"
    );
}

/// Ring buffer drops oldest entries past the bound, keeping only the
/// most recent N lines — the relevant ones for diagnosing a recent crash.
#[test]
fn drain_stderr_buf_keeps_only_recent_lines_when_overflowing() {
    let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));
    {
        let mut g = buf.lock().expect("lock");
        // Simulate the same eviction policy used by the stderr forwarder.
        for i in 0..(STDERR_BUF_LINES + 5) {
            if g.len() == STDERR_BUF_LINES {
                g.pop_front();
            }
            g.push_back(format!("line {i}"));
        }
    }
    let joined = drain_stderr_buf(&buf);
    assert!(
        !joined.contains("line 0"),
        "oldest line should be evicted: {joined}"
    );
    assert!(
        joined.contains(&format!("line {}", STDERR_BUF_LINES + 4)),
        "newest line should be retained: {joined}"
    );
}

/// Build a placeholder `SnapshotConfig` for `Ok(_)` rewrap cases.
/// Values are irrelevant — the rewrap helper never inspects them.
fn placeholder_snapshot_config() -> SnapshotConfig {
    SnapshotConfig {
        snapshot_path: "/tmp/snapshot.bin".into(),
        memory_path: "/tmp/memory.bin".into(),
        cow_path: "/tmp/cow.img".into(),
        drive_bind_path: "/tmp/cow-device-bind".into(),
        vsock_bind_dir: "/tmp/vsock".into(),
    }
}

/// Build a `std::process::ExitStatus` with a given raw value. On Unix
/// this encodes: `raw = (exit_code << 8) | signal`. Using
/// `ExitStatus::from_raw(0x100)` yields exit code 1 / success=false.
fn exit_status_nonzero() -> std::process::ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(0x100)
}

fn exit_status_zero() -> std::process::ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(0)
}

fn stderr_buf_with_lines(lines: &[&str]) -> StderrBuf {
    let buf: StderrBuf = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUF_LINES)));
    {
        let mut g = buf.lock().expect("lock");
        for line in lines {
            g.push_back((*line).to_string());
        }
    }
    buf
}

/// The target case: API error + child already exited non-zero → rewrap
/// into a Process error that names the captured stderr.
#[test]
fn rewrap_replaces_api_error_when_child_exited_nonzero() {
    let api_err = ApiError::Other("timeout".into());
    let err = rewrap_spawn_chain_exit(
        Err(SnapshotError::Api(api_err)),
        Ok(Some(exit_status_nonzero())),
        &stderr_buf_with_lines(&["mount: bind failed", "exit 32"]),
    )
    .unwrap_err();
    match err {
        SnapshotError::Process(msg) => {
            assert!(msg.contains("mount: bind failed"), "got: {msg}");
            assert!(msg.contains("exit 32"), "got: {msg}");
            assert!(msg.contains("original API error"), "got: {msg}");
            // Exit status must appear in the message — operators need it
            // to distinguish `exit 1` (mount denied) from `signal 9`
            // (OOM kill) from `exit 32` (mount target missing).
            assert!(msg.contains("status="), "should include exit status: {msg}");
        }
        other => panic!("expected Process error, got {other:?}"),
    }
}

/// Even when the stderr buffer is empty, the rewrapped message should
/// still be informative — falling back to the `<no stderr captured>`
/// sentinel rather than a bare `status=...:  (original ...)` string.
#[test]
fn rewrap_uses_sentinel_when_stderr_empty() {
    let err = rewrap_spawn_chain_exit(
        Err(SnapshotError::Api(ApiError::Other("timeout".into()))),
        Ok(Some(exit_status_nonzero())),
        &stderr_buf_with_lines(&[]),
    )
    .unwrap_err();
    match err {
        SnapshotError::Process(msg) => {
            assert!(
                msg.contains("no stderr"),
                "should fall back to sentinel when buffer is empty: {msg}"
            );
            assert!(msg.contains("status="), "got: {msg}");
        }
        other => panic!("expected Process error, got {other:?}"),
    }
}

/// `try_wait` itself returning `Err` (EINTR or similar) must not be
/// mistaken for "spawn chain exited" — stay conservative and keep the
/// original error instead of asserting something we couldn't observe.
#[test]
fn rewrap_preserves_api_error_when_try_wait_fails() {
    let err = rewrap_spawn_chain_exit(
        Err(SnapshotError::Api(ApiError::Other("timeout".into()))),
        Err(std::io::Error::from(std::io::ErrorKind::Interrupted)),
        &stderr_buf_with_lines(&["would-be-rewrapped"]),
    )
    .unwrap_err();
    assert!(matches!(err, SnapshotError::Api(_)), "got: {err:?}");
}

/// FC is still running (try_wait → None) → API error is genuine, keep it.
#[test]
fn rewrap_preserves_api_error_when_child_still_running() {
    let api_err = ApiError::Other("misconfigured".into());
    let err = rewrap_spawn_chain_exit(
        Err(SnapshotError::Api(api_err)),
        Ok(None),
        &stderr_buf_with_lines(&[]),
    )
    .unwrap_err();
    assert!(matches!(err, SnapshotError::Api(_)), "got: {err:?}");
}

/// FC exited with code 0 (rare but possible) → not a mount-style crash.
#[test]
fn rewrap_preserves_api_error_when_child_exited_zero() {
    let api_err = ApiError::Other("timeout".into());
    let err = rewrap_spawn_chain_exit(
        Err(SnapshotError::Api(api_err)),
        Ok(Some(exit_status_zero())),
        &stderr_buf_with_lines(&["noise"]),
    )
    .unwrap_err();
    assert!(matches!(err, SnapshotError::Api(_)), "got: {err:?}");
}

/// Non-API errors already carry their specific cause and should not
/// be replaced by a generic "spawn chain exited" message.
#[test]
fn rewrap_preserves_non_api_errors() {
    let err = rewrap_spawn_chain_exit(
        Err(SnapshotError::Setup("pre-warm failed".into())),
        Ok(Some(exit_status_nonzero())),
        &stderr_buf_with_lines(&["stderr junk"]),
    )
    .unwrap_err();
    match err {
        SnapshotError::Setup(msg) => assert_eq!(msg, "pre-warm failed"),
        other => panic!("expected Setup error, got {other:?}"),
    }
}

/// `Ok(_)` passes through untouched.
#[test]
fn rewrap_passes_ok_through() {
    let result = rewrap_spawn_chain_exit(
        Ok(placeholder_snapshot_config()),
        Ok(Some(exit_status_nonzero())),
        &stderr_buf_with_lines(&["noise"]),
    );
    assert!(result.is_ok(), "ok should pass through");
}

/// Structural assertion that the unshare inner_cmd uses positional
/// parameters (no path interpolation that could shell-inject) and
/// performs the bind-then-exec sequence.
///
/// The bind mount must run inside `unshare --mount` so it auto-cleans
/// when the FC process dies — see issue #9494. This test guards against
/// refactor regressions before the kernel-interaction CI job runs.
#[test]
fn spawn_inner_cmd_uses_positional_args() {
    // Only positional args, no $0 or unquoted vars.
    assert!(!SPAWN_INNER_CMD.contains("$0"));
    for arg in ["$1", "$2", "$3", "$4", "$5"] {
        let quoted = format!(r#""{arg}""#);
        assert!(
            SPAWN_INNER_CMD.contains(&quoted),
            "expected quoted positional {arg} in inner_cmd: {SPAWN_INNER_CMD}"
        );
    }
    // Strictly 5 positional args — if someone adds a `$6`..`$9` without
    // updating the spawn site's `.arg(...)` count, the bash call
    // silently expands to empty strings and fails at runtime.
    for unexpected in ["$6", "$7", "$8", "$9"] {
        assert!(
            !SPAWN_INNER_CMD.contains(unexpected),
            "unexpected positional {unexpected} in inner_cmd: {SPAWN_INNER_CMD}"
        );
    }

    // Flow: bind the device, then exec into ip netns exec firecracker.
    // `exec` is critical so signals reach FC directly without an extra
    // bash layer holding a process slot.
    assert!(
        SPAWN_INNER_CMD.starts_with("mount --bind"),
        "inner_cmd must establish bind mount first: {SPAWN_INNER_CMD}"
    );
    assert!(
        SPAWN_INNER_CMD.contains("&& exec ip netns exec"),
        "inner_cmd must exec ip netns exec firecracker: {SPAWN_INNER_CMD}"
    );
}

#[test]
fn snapshot_create_unshare_uses_private_mount_propagation() {
    assert_eq!(UNSHARE_MOUNT_ARGS, ["--mount", "--propagation", "private"]);
}
