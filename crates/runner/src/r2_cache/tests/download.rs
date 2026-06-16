use std::path::{Path, PathBuf};

use super::super::{
    R2DownloadError, R2Error,
    download::{file_staging_dir, finalize_staging, finish_file_staging_error, staging_dir},
    io_other,
};
use super::fixtures::{
    build_empty_archive_bytes, build_nested_template_archive_bytes, build_template_archive_bytes,
    build_template_archive_bytes_with_extra, build_test_archive_bytes, craft_tar_with_path,
    get_object_body, get_object_body_for_key, mock_cache, zstd_bytes,
};
use aws_smithy_mocks::mock;

#[test]
fn staging_dir_is_sibling() {
    let final_dir = Path::new("/var/lib/vm0-runner/images/abc123");
    let staging = staging_dir(final_dir);
    assert_eq!(
        staging,
        PathBuf::from("/var/lib/vm0-runner/images/abc123.tmp")
    );
    // Same parent — required for atomic rename.
    assert_eq!(staging.parent(), final_dir.parent());
}

/// `finalize_staging` performs the atomic rename for a rootfs-only archive.
#[tokio::test]
async fn finalize_renames_rootfs_only_staging() {
    let dst_root = tempfile::tempdir().unwrap();
    let final_dir = dst_root.path().join("hash");
    let staging = staging_dir(&final_dir);
    tokio::fs::create_dir_all(&staging).await.unwrap();
    tokio::fs::write(staging.join("rootfs.ext4"), b"data")
        .await
        .unwrap();

    finalize_staging(&staging, &final_dir).await.unwrap();

    assert!(final_dir.exists());
    assert!(final_dir.join("rootfs.ext4").exists());
    assert!(!staging.exists(), "staging consumed by rename");
}

/// Defensive retry path: when `final_dir` already exists, `rename` fails
/// once, the function removes the destination, and retries.
#[tokio::test]
async fn finalize_overwrites_existing_final_dir() {
    let dst_root = tempfile::tempdir().unwrap();
    let final_dir = dst_root.path().join("hash");

    // Pre-populate `final_dir` with stale content the test will overwrite.
    tokio::fs::create_dir_all(&final_dir).await.unwrap();
    tokio::fs::write(final_dir.join("stale.txt"), b"old")
        .await
        .unwrap();

    // Build fresh staging.
    let staging = staging_dir(&final_dir);
    tokio::fs::create_dir_all(&staging).await.unwrap();
    tokio::fs::write(staging.join("fresh.txt"), b"new")
        .await
        .unwrap();

    finalize_staging(&staging, &final_dir).await.unwrap();

    assert!(final_dir.join("fresh.txt").exists(), "new content arrived");
    assert!(
        !final_dir.join("stale.txt").exists(),
        "old content was wiped before rename"
    );
}

// ---- S3 mock smoke test --------------------------------------------
//
// Proves that `R2ImageCache::with_client` + the `mock_client!` macro
// dispatch correctly through to a real `aws_sdk_s3::Client`. Detailed
// coverage of `exists`, `upload`, `try_download`, `gc_older_than` against
// mocked S3 responses lives in the test modules added by subsequent
// commits.

#[tokio::test]
async fn with_client_dispatches_through_mock() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::head_object::HeadObjectOutput;

    let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().build());
    let cache = mock_cache("test-bucket", &[&head]);
    assert!(cache.exists("any-hash").await.unwrap());
    assert_eq!(head.num_calls(), 1);
}

// ---- exists + try_download error mapping and staging cleanup -------

/// `exists()` MUST map `HeadObjectError::NotFound` to `Ok(false)` — that's
/// what distinguishes a genuine cache miss from an error the caller
/// should log and back off on. Flip the mapping and operators get silent
/// re-uploads on AccessDenied.
#[tokio::test]
async fn exists_returns_false_on_not_found() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::head_object::HeadObjectError;
    use aws_sdk_s3::types::error::NotFound;

    let head = mock!(Client::head_object)
        .then_error(|| HeadObjectError::NotFound(NotFound::builder().build()));
    let cache = mock_cache("test-bucket", &[&head]);
    assert!(!cache.exists("any").await.unwrap());
    assert_eq!(head.num_calls(), 1);
}

/// `try_download()` MUST map `GetObjectError::NoSuchKey` to `Ok(false)`
/// (symmetric to `exists_returns_false_on_not_found`). It also MUST NOT
/// create a staging directory for a miss — the caller falls back to
/// local build and expects `final_dir` absent.
#[tokio::test]
async fn try_download_returns_false_on_no_such_key() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectError;
    use aws_sdk_s3::types::error::NoSuchKey;

    let get = mock!(Client::get_object)
        .then_error(|| GetObjectError::NoSuchKey(NoSuchKey::builder().build()));
    let cache = mock_cache("test-bucket", &[&get]);

    let dst = tempfile::tempdir().unwrap();
    let final_dir = dst.path().join("hash");
    let result = cache.try_download("hash", &final_dir).await.unwrap();

    assert!(!result, "NoSuchKey → Ok(false)");
    assert!(!final_dir.exists(), "final_dir MUST remain absent on miss");
    assert!(
        !staging_dir(&final_dir).exists(),
        "no staging dir on miss (short-circuit before staging creation)"
    );
}

#[tokio::test]
async fn try_download_template_materializes_template_file() {
    let get = get_object_body_for_key(
        "test-bucket",
        "runner-templates/hash.tar.zst",
        build_template_archive_bytes().await,
    );
    let cache = mock_cache("test-bucket", &[&get]);

    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("rootfs.ext4.staging");

    let result = cache
        .try_download_template_to_file("hash", &destination)
        .await
        .unwrap();

    assert!(result, "valid template body → Ok(true)");
    assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"hello");
    assert!(
        !file_staging_dir(&destination).exists(),
        "download staging directory must be cleaned"
    );
}

#[tokio::test]
async fn try_download_template_replaces_existing_destination_on_valid_archive() {
    let get = get_object_body(build_template_archive_bytes().await);
    let cache = mock_cache("test-bucket", &[&get]);

    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("rootfs.ext4.staging");
    tokio::fs::write(&destination, b"old-rootfs").await.unwrap();

    let result = cache
        .try_download_template_to_file("hash", &destination)
        .await
        .unwrap();

    assert!(result, "valid template body -> Ok(true)");
    assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"hello");
    assert!(
        !file_staging_dir(&destination).exists(),
        "download staging directory must be cleaned"
    );
}

#[tokio::test]
async fn try_download_template_rejects_path_traversal_archive() {
    let get = get_object_body(zstd_bytes(craft_tar_with_path(b"../escaped.txt", b"bad")).await);
    let cache = mock_cache("test-bucket", &[&get]);

    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("rootfs.ext4.staging");

    let err = cache
        .try_download_template_to_file("hash", &destination)
        .await
        .unwrap_err();

    assert!(
        matches!(err, R2DownloadError::InvalidObject(_)),
        "path traversal archive must be classified as invalid cache object, got {err:?}"
    );
    assert!(!dst.path().join("escaped.txt").exists());
    assert!(!destination.exists());
    assert!(
        !file_staging_dir(&destination).exists(),
        "download staging directory must be cleaned"
    );
}

#[tokio::test]
async fn try_download_template_discards_extra_archive_members() {
    let get = get_object_body(build_template_archive_bytes_with_extra().await);
    let cache = mock_cache("test-bucket", &[&get]);

    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("rootfs.ext4.staging");

    let result = cache
        .try_download_template_to_file("hash", &destination)
        .await
        .unwrap();

    assert!(result, "valid template body -> Ok(true)");
    assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"hello");
    assert!(
        !dst.path().join("extra.txt").exists(),
        "extra archive members must be discarded with download staging"
    );
    assert!(
        !file_staging_dir(&destination).exists(),
        "download staging directory must be cleaned"
    );
}

#[tokio::test]
async fn try_download_template_rejects_nested_template_directory() {
    let get = get_object_body(build_nested_template_archive_bytes().await);
    let cache = mock_cache("test-bucket", &[&get]);

    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("rootfs.ext4.staging");

    let err = cache
        .try_download_template_to_file("hash", &destination)
        .await
        .unwrap_err();

    assert!(
        matches!(err, R2DownloadError::InvalidObject(_)),
        "nested template directory must be classified as invalid cache object, got {err:?}"
    );
    assert!(!destination.exists(), "destination must remain absent");
    assert!(
        !file_staging_dir(&destination).exists(),
        "download staging directory must be cleaned"
    );
}

#[tokio::test]
async fn try_download_template_preserves_existing_destination_when_template_path_is_directory() {
    let get = get_object_body(build_nested_template_archive_bytes().await);
    let cache = mock_cache("test-bucket", &[&get]);

    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("rootfs.ext4.staging");
    tokio::fs::write(&destination, b"existing-rootfs")
        .await
        .unwrap();

    let err = cache
        .try_download_template_to_file("hash", &destination)
        .await
        .unwrap_err();

    assert!(
        matches!(err, R2DownloadError::InvalidObject(_)),
        "nested template directory must be classified as invalid cache object, got {err:?}"
    );
    assert_eq!(
        tokio::fs::read(&destination).await.unwrap(),
        b"existing-rootfs"
    );
    assert!(
        !file_staging_dir(&destination).exists(),
        "download staging directory must be cleaned"
    );
}

#[tokio::test]
async fn try_download_template_rejects_archive_missing_template() {
    let get = get_object_body(build_empty_archive_bytes().await);
    let cache = mock_cache("test-bucket", &[&get]);

    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("rootfs.ext4.staging");

    let err = cache
        .try_download_template_to_file("hash", &destination)
        .await
        .unwrap_err();

    assert!(
        matches!(err, R2DownloadError::InvalidObject(_)),
        "archive missing template.ext4 must be treated as corrupt template cache, got {err:?}"
    );
    assert!(!destination.exists());
    assert!(
        !file_staging_dir(&destination).exists(),
        "download staging directory must be cleaned"
    );
}

#[tokio::test]
async fn try_download_template_preserves_destination_until_archive_validates() {
    let get = get_object_body(build_empty_archive_bytes().await);
    let cache = mock_cache("test-bucket", &[&get]);

    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("rootfs.ext4.staging");
    tokio::fs::write(&destination, b"existing-rootfs")
        .await
        .unwrap();

    let err = cache
        .try_download_template_to_file("hash", &destination)
        .await
        .unwrap_err();

    assert!(
        matches!(err, R2DownloadError::InvalidObject(_)),
        "archive missing template.ext4 must be treated as corrupt template cache, got {err:?}"
    );
    assert_eq!(
        tokio::fs::read(&destination).await.unwrap(),
        b"existing-rootfs"
    );
    assert!(
        !file_staging_dir(&destination).exists(),
        "download staging directory must be cleaned"
    );
}

#[tokio::test]
async fn try_download_template_classifies_destination_failure_as_local() {
    let get = get_object_body(build_template_archive_bytes().await);
    let cache = mock_cache("test-bucket", &[&get]);

    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("rootfs.ext4.staging");
    tokio::fs::create_dir_all(&destination).await.unwrap();

    let err = cache
        .try_download_template_to_file("hash", &destination)
        .await
        .unwrap_err();

    assert!(
        matches!(err, R2DownloadError::Local(R2Error::Io(_))),
        "local destination failure must not be treated as corrupt R2 cache, got {err:?}"
    );
    assert!(
        destination.is_dir(),
        "local destination directory should remain for operator inspection"
    );
    assert!(
        !file_staging_dir(&destination).exists(),
        "download staging directory must be cleaned after destination failures"
    );
}

#[tokio::test]
async fn finish_file_staging_error_preserves_original_error_when_cleanup_fails() {
    let dst = tempfile::tempdir().unwrap();
    let staging = dst.path().join("rootfs.ext4.download.tmp");
    tokio::fs::write(&staging, b"not a directory")
        .await
        .unwrap();

    let err = finish_file_staging_error(
        &staging,
        R2DownloadError::InvalidObject(R2Error::Io(io_other("bad archive"))),
    )
    .await;

    assert!(
        matches!(err, R2DownloadError::InvalidObject(_)),
        "cleanup failure must not mask invalid-object classification, got {err:?}"
    );
    assert!(
        staging.exists(),
        "test setup should leave the uncleanable staging path in place"
    );
}

#[tokio::test]
async fn try_download_template_wipes_download_staging_on_unpack_error() {
    let get = get_object_body(b"not a valid zstd stream".to_vec());
    let cache = mock_cache("test-bucket", &[&get]);

    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("rootfs.ext4.staging");

    let err = cache
        .try_download_template_to_file("hash", &destination)
        .await
        .unwrap_err();

    assert!(
        matches!(err, R2DownloadError::InvalidObject(_)),
        "bad body must be classified as invalid cache object, got {err:?}"
    );
    assert!(!destination.exists(), "destination MUST remain absent");
    assert!(
        !file_staging_dir(&destination).exists(),
        "download staging MUST be wiped on unpack errors"
    );
}

#[tokio::test]
async fn try_download_template_miss_cleans_prior_download_staging() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectError;
    use aws_sdk_s3::types::error::NoSuchKey;

    let get = mock!(Client::get_object)
        .then_error(|| GetObjectError::NoSuchKey(NoSuchKey::builder().build()));
    let cache = mock_cache("test-bucket", &[&get]);

    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("rootfs.ext4.staging");
    let stale_download = file_staging_dir(&destination);
    tokio::fs::create_dir_all(&stale_download).await.unwrap();
    tokio::fs::write(stale_download.join("partial"), b"crash residue")
        .await
        .unwrap();

    let result = cache
        .try_download_template_to_file("hash", &destination)
        .await
        .unwrap();

    assert!(!result, "NoSuchKey -> Ok(false)");
    assert!(
        !destination.exists(),
        "cache miss must not create destination"
    );
    assert!(
        !stale_download.exists(),
        "prior download staging must be removed even on cache miss"
    );
}

#[tokio::test]
async fn try_download_template_errors_when_prior_download_staging_cannot_be_cleaned() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectError;
    use aws_sdk_s3::types::error::NoSuchKey;

    let get = mock!(Client::get_object)
        .then_error(|| GetObjectError::NoSuchKey(NoSuchKey::builder().build()));
    let cache = mock_cache("test-bucket", &[&get]);

    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("rootfs.ext4.staging");
    let stale_download = file_staging_dir(&destination);
    tokio::fs::write(&stale_download, b"not a directory")
        .await
        .unwrap();

    let err = cache
        .try_download_template_to_file("hash", &destination)
        .await
        .unwrap_err();

    assert!(
        matches!(err, R2DownloadError::Local(R2Error::Io(_))),
        "uncleanable prior download staging must be surfaced, got {err:?}"
    );
    assert!(
        stale_download.exists(),
        "failed cleanup should leave evidence for operator inspection"
    );
}

/// Download body is not a valid zstd stream → unpack fails → the
/// cleanup-on-error branch wipes staging AND leaves `final_dir` absent.
/// Without cleanup, a failed download + local rebuild could fill the
/// disk with staging residue.
#[tokio::test]
async fn try_download_wipes_staging_on_unpack_error() {
    let get = get_object_body(b"not a valid zstd stream".to_vec());
    let cache = mock_cache("test-bucket", &[&get]);

    let dst = tempfile::tempdir().unwrap();
    let final_dir = dst.path().join("hash");
    let result = cache.try_download("hash", &final_dir).await;

    let err = result.unwrap_err();
    assert!(
        matches!(err, R2DownloadError::InvalidObject(_)),
        "bad body must be classified as invalid cache object, got {err:?}"
    );
    assert!(!final_dir.exists(), "final_dir MUST remain absent");
    assert!(
        !staging_dir(&final_dir).exists(),
        "staging MUST be wiped — this is the disk-leak guard"
    );
}

/// Local filesystem failures after a valid download must not be
/// classified as invalid R2 objects. The caller should not force-overwrite
/// a healthy cache key when the local target path is the problem.
#[tokio::test]
async fn try_download_classifies_finalize_failure_as_local() {
    let get = get_object_body(build_test_archive_bytes().await);
    let cache = mock_cache("test-bucket", &[&get]);

    let dst = tempfile::tempdir().unwrap();
    let final_dir = dst.path().join("hash");
    tokio::fs::write(&final_dir, b"not a directory")
        .await
        .unwrap();

    let err = cache.try_download("hash", &final_dir).await.unwrap_err();

    assert!(
        matches!(err, R2DownloadError::Local(_)),
        "target path failure must be local, got {err:?}"
    );
    assert!(final_dir.is_file(), "local target file should remain");
    assert!(
        !staging_dir(&final_dir).exists(),
        "staging MUST be wiped after finalize failure"
    );
}

/// A staging dir from a prior crashed run MUST be wiped before the next
/// `try_download` unpacks fresh content. Otherwise old junk would leak
/// into `final_dir` via the rename.
#[tokio::test]
async fn try_download_wipes_prior_crashed_staging_dir() {
    let get = get_object_body(build_test_archive_bytes().await);
    let cache = mock_cache("test-bucket", &[&get]);

    let dst = tempfile::tempdir().unwrap();
    let final_dir = dst.path().join("hash");
    let staging = staging_dir(&final_dir);

    // Simulate a prior crashed run: populate staging with junk the
    // fresh download must overwrite.
    tokio::fs::create_dir_all(&staging).await.unwrap();
    tokio::fs::write(staging.join("stale.txt"), b"old crash residue")
        .await
        .unwrap();

    let result = cache.try_download("hash", &final_dir).await.unwrap();

    assert!(result, "valid body → Ok(true)");
    assert!(final_dir.exists(), "final_dir populated");
    assert!(
        final_dir.join("rootfs.ext4").exists(),
        "fresh content arrived"
    );
    assert!(
        !final_dir.join("stale.txt").exists(),
        "stale staging content MUST NOT survive into final_dir"
    );
    assert!(!staging.exists(), "staging consumed by rename");
}
