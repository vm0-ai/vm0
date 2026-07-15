use super::super::{
    R2DownloadError, R2Error,
    download::{file_staging_dir, finish_file_staging_error},
    io_other,
};
use super::fixtures::{
    archive_limits, archive_with_type, deterministic_bytes, empty_template_archive,
    excessive_sparse_metadata_archive, get_object_body, get_object_body_for_key,
    get_object_body_with_content_length, mock_cache, nested_template_archive,
    production_template_archive, regular_template_archive, sparse_template_archive,
    template_archive_with_extra, zstd_bytes,
};
use aws_smithy_mocks::mock;

const SMALL_TEMPLATE_BYTES: u64 = 5;

#[tokio::test]
async fn downloads_exact_regular_template_from_template_key() {
    let get = get_object_body_for_key(
        "test-bucket",
        "runner-templates/hash.tar.zst",
        regular_template_archive(b"hello"),
    );
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("rootfs.ext4.staging");

    let downloaded = cache
        .try_download_template_to_file("hash", &destination, SMALL_TEMPLATE_BYTES)
        .await
        .unwrap();

    assert!(downloaded);
    assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"hello");
    assert!(!file_staging_dir(&destination).exists());
    assert_eq!(get.num_calls(), 1);
}

#[tokio::test]
async fn valid_template_replaces_existing_destination_only_after_validation() {
    let get = get_object_body(regular_template_archive(b"hello"));
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("rootfs.ext4.staging");
    tokio::fs::write(&destination, b"old-rootfs").await.unwrap();

    cache
        .try_download_template_to_file("hash", &destination, SMALL_TEMPLATE_BYTES)
        .await
        .unwrap();

    assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"hello");
    assert!(!file_staging_dir(&destination).exists());
}

#[tokio::test]
async fn production_writer_round_trips_incompressible_template_within_limit() {
    const TEMPLATE_BYTES: usize = 2 * 1024 * 1024;

    let source_dir = tempfile::tempdir().unwrap();
    let source = source_dir.path().join("arbitrary-source-name");
    let expected = deterministic_bytes(TEMPLATE_BYTES);
    tokio::fs::write(&source, &expected).await.unwrap();
    let archive = production_template_archive(&source).await;
    assert!(
        archive.len() as u64 <= archive_limits(TEMPLATE_BYTES as u64).max_compressed_bytes(),
        "controlled streaming writer must fit the downloader's compressed limit"
    );

    let get = get_object_body(archive);
    let cache = mock_cache("test-bucket", &[&get]);
    let destination_dir = tempfile::tempdir().unwrap();
    let destination = destination_dir.path().join("template.ext4");

    cache
        .try_download_template_to_file("hash", &destination, TEMPLATE_BYTES as u64)
        .await
        .unwrap();

    assert_eq!(tokio::fs::read(destination).await.unwrap(), expected);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn downloads_gnu_sparse_template_and_preserves_holes() {
    use std::os::unix::fs::MetadataExt;

    let (archive, expected) = sparse_template_archive();
    let get = get_object_body(archive);
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("template.ext4");

    cache
        .try_download_template_to_file("hash", &destination, expected.len() as u64)
        .await
        .unwrap();

    assert_eq!(tokio::fs::read(&destination).await.unwrap(), expected);
    let metadata = std::fs::metadata(&destination).unwrap();
    assert_eq!(metadata.len(), expected.len() as u64);
    assert!(
        metadata.blocks() * 512 < metadata.len(),
        "GNU sparse extraction must not materialize every hole"
    );
}

#[tokio::test]
async fn cache_miss_cleans_stale_staging_without_touching_destination() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectError;
    use aws_sdk_s3::types::error::NoSuchKey;

    let get = mock!(Client::get_object)
        .then_error(|| GetObjectError::NoSuchKey(NoSuchKey::builder().build()));
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("template.ext4");
    tokio::fs::write(&destination, b"existing").await.unwrap();
    let staging = file_staging_dir(&destination);
    tokio::fs::create_dir_all(&staging).await.unwrap();
    tokio::fs::write(staging.join("partial"), b"residue")
        .await
        .unwrap();

    let downloaded = cache
        .try_download_template_to_file("hash", &destination, SMALL_TEMPLATE_BYTES)
        .await
        .unwrap();

    assert!(!downloaded);
    assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"existing");
    assert!(!staging.exists());
}

#[tokio::test]
async fn request_failure_remains_distinct_from_invalid_object() {
    use aws_sdk_s3::Client;

    let get = mock!(Client::get_object)
        .sequence()
        .http_status(
            500,
            Some("<Error><Code>InternalError</Code></Error>".into()),
        )
        .build();
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("template.ext4");

    let error = cache
        .try_download_template_to_file("hash", &destination, SMALL_TEMPLATE_BYTES)
        .await
        .unwrap_err();

    assert!(matches!(error, R2DownloadError::Request(_)));
    assert!(!destination.exists());
    assert!(!file_staging_dir(&destination).exists());
}

#[tokio::test]
async fn oversized_declared_content_length_is_rejected_before_staging() {
    let limit = archive_limits(SMALL_TEMPLATE_BYTES).max_compressed_bytes();
    let get = get_object_body_with_content_length(
        regular_template_archive(b"hello"),
        Some(i64::try_from(limit + 1).unwrap()),
    );
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("template.ext4");
    tokio::fs::write(&destination, b"existing").await.unwrap();

    let error = cache
        .try_download_template_to_file("hash", &destination, SMALL_TEMPLATE_BYTES)
        .await
        .unwrap_err();

    assert!(matches!(error, R2DownloadError::InvalidObject(_)));
    assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"existing");
    assert!(!file_staging_dir(&destination).exists());
}

#[tokio::test]
async fn negative_declared_content_length_is_invalid() {
    let get = get_object_body_with_content_length(regular_template_archive(b"hello"), Some(-1));
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("template.ext4");

    let error = cache
        .try_download_template_to_file("hash", &destination, SMALL_TEMPLATE_BYTES)
        .await
        .unwrap_err();

    assert!(matches!(error, R2DownloadError::InvalidObject(_)));
    assert!(!file_staging_dir(&destination).exists());
}

#[tokio::test]
async fn trailing_actual_body_is_rejected_without_content_length() {
    let mut archive = regular_template_archive(b"hello");
    archive.extend_from_slice(&zstd_bytes(b"second zstd frame"));
    assert_invalid_preserves_destination(get_object_body(archive), SMALL_TEMPLATE_BYTES).await;
}

#[tokio::test]
async fn misleading_content_length_cannot_hide_trailing_actual_body() {
    let mut archive = regular_template_archive(b"hello");
    let declared = archive.len() as i64;
    archive.extend_from_slice(b"trailing bytes after zstd frame");
    assert_invalid_preserves_destination(
        get_object_body_with_content_length(archive, Some(declared)),
        SMALL_TEMPLATE_BYTES,
    )
    .await;
}

#[tokio::test]
async fn oversized_logical_template_is_rejected() {
    assert_invalid_preserves_destination(
        get_object_body(regular_template_archive(b"too-long")),
        SMALL_TEMPLATE_BYTES,
    )
    .await;
}

#[tokio::test]
async fn undersized_logical_template_is_rejected() {
    assert_invalid_preserves_destination(
        get_object_body(regular_template_archive(b"tiny")),
        SMALL_TEMPLATE_BYTES,
    )
    .await;
}

#[tokio::test]
async fn extra_member_is_rejected_without_publication() {
    assert_invalid_preserves_destination(
        get_object_body(template_archive_with_extra(b"hello")),
        SMALL_TEMPLATE_BYTES,
    )
    .await;
}

#[tokio::test]
async fn nested_template_path_is_rejected() {
    assert_invalid_preserves_destination(
        get_object_body(nested_template_archive()),
        SMALL_TEMPLATE_BYTES,
    )
    .await;
}

#[tokio::test]
async fn unsupported_member_and_extension_types_are_rejected() {
    for entry_type in [
        tar::EntryType::Symlink,
        tar::EntryType::Continuous,
        tar::EntryType::XHeader,
        tar::EntryType::GNULongName,
    ] {
        assert_invalid_preserves_destination(get_object_body(archive_with_type(entry_type)), 0)
            .await;
    }
}

#[tokio::test]
async fn empty_archive_is_rejected() {
    assert_invalid_preserves_destination(get_object_body(empty_template_archive()), 0).await;
}

#[tokio::test]
async fn corrupt_zstd_is_rejected_and_staging_is_removed() {
    assert_invalid_preserves_destination(
        get_object_body(b"not a valid zstd stream".to_vec()),
        SMALL_TEMPLATE_BYTES,
    )
    .await;
}

#[tokio::test]
async fn excessive_sparse_metadata_is_rejected_within_budget() {
    let (archive, expected_bytes) = excessive_sparse_metadata_archive();
    assert_invalid_preserves_destination(get_object_body(archive), expected_bytes).await;
}

#[tokio::test]
async fn destination_failure_is_classified_as_local() {
    let get = get_object_body(regular_template_archive(b"hello"));
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("template.ext4");
    tokio::fs::create_dir_all(&destination).await.unwrap();

    let error = cache
        .try_download_template_to_file("hash", &destination, SMALL_TEMPLATE_BYTES)
        .await
        .unwrap_err();

    assert!(matches!(error, R2DownloadError::Local(R2Error::Io(_))));
    assert!(destination.is_dir());
    assert!(!file_staging_dir(&destination).exists());
}

#[tokio::test]
async fn stale_staging_cleanup_failure_is_local() {
    let get = get_object_body(regular_template_archive(b"hello"));
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("template.ext4");
    let staging = file_staging_dir(&destination);
    tokio::fs::write(&staging, b"not a directory")
        .await
        .unwrap();

    let error = cache
        .try_download_template_to_file("hash", &destination, SMALL_TEMPLATE_BYTES)
        .await
        .unwrap_err();

    assert!(matches!(error, R2DownloadError::Local(R2Error::Io(_))));
    assert!(staging.exists());
}

#[tokio::test]
async fn cleanup_failure_does_not_mask_original_invalid_object() {
    let dst = tempfile::tempdir().unwrap();
    let staging = dst.path().join("template.ext4.download.tmp");
    tokio::fs::write(&staging, b"not a directory")
        .await
        .unwrap();

    let error = finish_file_staging_error(
        &staging,
        R2DownloadError::InvalidObject(R2Error::Io(io_other("bad archive"))),
    )
    .await;

    assert!(matches!(error, R2DownloadError::InvalidObject(_)));
    assert!(staging.exists());
}

async fn assert_invalid_preserves_destination(get: aws_smithy_mocks::Rule, expected_bytes: u64) {
    let cache = mock_cache("test-bucket", &[&get]);
    let dst = tempfile::tempdir().unwrap();
    let destination = dst.path().join("template.ext4");
    tokio::fs::write(&destination, b"existing-rootfs")
        .await
        .unwrap();

    let error = cache
        .try_download_template_to_file("hash", &destination, expected_bytes)
        .await
        .unwrap_err();

    assert!(
        matches!(error, R2DownloadError::InvalidObject(_)),
        "expected invalid cache object, got {error:?}"
    );
    assert_eq!(
        tokio::fs::read(&destination).await.unwrap(),
        b"existing-rootfs"
    );
    assert!(!file_staging_dir(&destination).exists());
}
