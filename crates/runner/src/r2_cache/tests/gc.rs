use super::super::{
    R2Error,
    gc::{cutoff_unix_secs, select_expired_in_page},
};
use super::fixtures::mock_cache;
use aws_smithy_mocks::mock;

// ---- cutoff math (gc_older_than helper) -----------------------------

#[test]
fn cutoff_subtracts_max_age_from_now() {
    let now = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
    let max_age = std::time::Duration::from_secs(1_000);
    assert_eq!(cutoff_unix_secs(now, max_age).unwrap(), 999_000);
}

#[test]
fn cutoff_saturates_to_zero_when_age_exceeds_now() {
    // Defensive: a dev/test clock near epoch shouldn't underflow.
    let now = std::time::UNIX_EPOCH + std::time::Duration::from_secs(100);
    let max_age = std::time::Duration::from_secs(1_000);
    assert_eq!(cutoff_unix_secs(now, max_age).unwrap(), 0);
}

#[test]
fn cutoff_zero_max_age_equals_now() {
    // `--r2-keep-days 0` is rejected at the CLI layer; this test exists
    // so a future caller can't silently regress that contract here.
    let now = std::time::UNIX_EPOCH + std::time::Duration::from_secs(42);
    let zero = std::time::Duration::from_secs(0);
    assert_eq!(cutoff_unix_secs(now, zero).unwrap(), 42);
}

#[test]
fn cutoff_with_duration_max_saturates_to_zero() {
    // Pathological input shouldn't underflow into a huge positive cutoff.
    let now = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
    assert_eq!(cutoff_unix_secs(now, std::time::Duration::MAX).unwrap(), 0);
}

// ---- select_expired_in_page (gc_older_than filter) ------------------

fn obj(key: &str, last_modified_secs: i64, size: i64) -> aws_sdk_s3::types::Object {
    aws_sdk_s3::types::Object::builder()
        .key(key)
        .last_modified(aws_sdk_s3::primitives::DateTime::from_secs(
            last_modified_secs,
        ))
        .size(size)
        .build()
}

#[test]
fn select_expired_filters_by_cutoff() {
    let objects = [
        obj("old1", 100, 10),
        obj("fresh", 200, 20),
        obj("old2", 50, 30),
    ];
    let (selected, freed) = select_expired_in_page(&objects, 150).unwrap();
    let keys: Vec<&str> = selected.iter().map(|o| o.key.as_str()).collect();
    assert_eq!(keys.len(), 2);
    assert!(keys.contains(&"old1"));
    assert!(keys.contains(&"old2"));
    assert!(!keys.contains(&"fresh"));
    assert_eq!(freed, 40); // 10 + 30
}

#[test]
fn select_expired_keeps_object_at_exact_cutoff() {
    // `>=` is the skip predicate, so equality biases toward retention.
    // Important contract: an upload that just happened "right at" the
    // GC cycle's cutoff isn't aggressively swept.
    let objects = [obj("boundary", 100, 1)];
    let (selected, freed) = select_expired_in_page(&objects, 100).unwrap();
    assert_eq!(selected.len(), 0);
    assert_eq!(freed, 0);
}

#[test]
fn select_expired_skips_object_without_last_modified() {
    // ListObjectsV2 always sets last_modified for real R2 responses,
    // but the SDK type is Option — guard the None branch.
    let objects = [aws_sdk_s3::types::Object::builder()
        .key("orphan")
        .size(10)
        .build()];
    let (selected, freed) = select_expired_in_page(&objects, 100).unwrap();
    assert_eq!(selected.len(), 0);
    assert_eq!(freed, 0);
}

#[test]
fn select_expired_skips_object_without_key() {
    let objects = [aws_sdk_s3::types::Object::builder()
        .last_modified(aws_sdk_s3::primitives::DateTime::from_secs(50))
        .size(10)
        .build()];
    let (selected, freed) = select_expired_in_page(&objects, 100).unwrap();
    assert_eq!(selected.len(), 0);
    assert_eq!(freed, 0);
}

#[test]
fn select_expired_clamps_negative_size_to_zero() {
    // Defensive against a pathological SDK / R2 response.
    let objects = [obj("weird", 50, -1)];
    let (selected, freed) = select_expired_in_page(&objects, 100).unwrap();
    assert_eq!(selected.len(), 1);
    assert_eq!(freed, 0);
}

#[test]
fn select_expired_empty_page_returns_empty() {
    let (selected, freed) = select_expired_in_page(&[], 100).unwrap();
    assert!(selected.is_empty());
    assert_eq!(freed, 0);
}

// ---- gc_older_than: pagination + per-key delete errors -------------

/// `gc_older_than` MUST follow `continuation_token` across multiple
/// `list_objects_v2` pages. Regression here would silently under-delete
/// (first page processed, subsequent pages dropped) — fleet cache grows
/// unbounded with orphaned image objects.
#[tokio::test]
async fn gc_paginates_across_two_pages() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::delete_objects::DeleteObjectsOutput;
    use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output;
    use aws_sdk_s3::primitives::DateTime;
    use aws_sdk_s3::types::Object;

    // All objects timestamped at unix epoch (last_modified = 0); any
    // non-trivial `max_age` puts the cutoff well after 0 → all expired.
    let page1 = ListObjectsV2Output::builder()
        .is_truncated(true)
        .next_continuation_token("tok1")
        .contents(
            Object::builder()
                .key("runner-images/a.tar.zst")
                .last_modified(DateTime::from_secs(0))
                .size(100)
                .build(),
        )
        .contents(
            Object::builder()
                .key("runner-images/b.tar.zst")
                .last_modified(DateTime::from_secs(0))
                .size(200)
                .build(),
        )
        .build();
    let page2 = ListObjectsV2Output::builder()
        .is_truncated(false)
        .contents(
            Object::builder()
                .key("runner-images/c.tar.zst")
                .last_modified(DateTime::from_secs(0))
                .size(300)
                .build(),
        )
        .build();
    let empty_template_page = ListObjectsV2Output::builder().is_truncated(false).build();

    let list = mock!(Client::list_objects_v2)
        .sequence()
        .output(move || page1.clone())
        .output(move || page2.clone())
        .output(move || empty_template_page.clone())
        .build();
    // Quiet-mode delete responses don't echo successes; no `errors`.
    let delete =
        mock!(Client::delete_objects).then_output(|| DeleteObjectsOutput::builder().build());

    let cache = mock_cache("test-bucket", &[&list, &delete]);

    let (deleted, freed) = cache
        .gc_older_than(std::time::Duration::from_secs(1))
        .await
        .unwrap();

    assert_eq!(deleted, 3, "2 objects from page1 + 1 from page2");
    assert_eq!(freed, 600, "100 + 200 + 300");
    assert_eq!(
        list.num_calls(),
        3,
        "pagination followed next_token and template prefix was scanned"
    );
    assert_eq!(delete.num_calls(), 2, "one delete per non-empty page");
}

/// `gc_older_than` must also clean the shared template prefix. A
/// regression here would leave the new cache family unbounded even though
/// legacy `runner-images/` objects continue to be swept.
#[tokio::test]
async fn gc_deletes_shared_template_objects() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::delete_objects::DeleteObjectsOutput;
    use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output;
    use aws_sdk_s3::primitives::DateTime;
    use aws_sdk_s3::types::Object;

    let empty_legacy_page = ListObjectsV2Output::builder().is_truncated(false).build();
    let template_page = ListObjectsV2Output::builder()
        .is_truncated(false)
        .contents(
            Object::builder()
                .key("runner-templates/template.tar.zst")
                .last_modified(DateTime::from_secs(0))
                .size(123)
                .build(),
        )
        .build();

    let list = mock!(Client::list_objects_v2)
        .sequence()
        .output(move || empty_legacy_page.clone())
        .output(move || template_page.clone())
        .build();
    let delete =
        mock!(Client::delete_objects).then_output(|| DeleteObjectsOutput::builder().build());

    let cache = mock_cache("test-bucket", &[&list, &delete]);

    let (deleted, freed) = cache
        .gc_older_than(std::time::Duration::from_secs(1))
        .await
        .unwrap();

    assert_eq!(deleted, 1);
    assert_eq!(freed, 123);
    assert_eq!(list.num_calls(), 2, "legacy and template prefixes scanned");
    assert_eq!(delete.num_calls(), 1, "template object delete issued");
}

/// `gc_older_than` MUST exclude per-key failures from `deleted_count` so
/// operators don't over-report cleanup progress. `freed_bytes` uses
/// proportional attribution — `60 * 2 / 3 = 40` — since the function
/// can't know which specific key in the batch failed.
#[tokio::test]
async fn gc_excludes_per_key_failures_from_count() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::delete_objects::DeleteObjectsOutput;
    use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output;
    use aws_sdk_s3::primitives::DateTime;
    use aws_sdk_s3::types::{Error as S3Error, Object};

    let page = ListObjectsV2Output::builder()
        .is_truncated(false)
        .contents(
            Object::builder()
                .key("runner-images/a.tar.zst")
                .last_modified(DateTime::from_secs(0))
                .size(10)
                .build(),
        )
        .contents(
            Object::builder()
                .key("runner-images/b.tar.zst")
                .last_modified(DateTime::from_secs(0))
                .size(20)
                .build(),
        )
        .contents(
            Object::builder()
                .key("runner-images/c.tar.zst")
                .last_modified(DateTime::from_secs(0))
                .size(30)
                .build(),
        )
        .build();
    let empty_template_page = ListObjectsV2Output::builder().is_truncated(false).build();
    let delete_resp = DeleteObjectsOutput::builder()
        .errors(
            S3Error::builder()
                .key("runner-images/b.tar.zst")
                .code("AccessDenied")
                .message("denied")
                .build(),
        )
        .build();

    let list = mock!(Client::list_objects_v2)
        .sequence()
        .output(move || page.clone())
        .output(move || empty_template_page.clone())
        .build();
    let delete = mock!(Client::delete_objects).then_output(move || delete_resp.clone());

    let cache = mock_cache("test-bucket", &[&list, &delete]);

    let (deleted, freed) = cache
        .gc_older_than(std::time::Duration::from_secs(1))
        .await
        .unwrap();

    assert_eq!(deleted, 2, "1 of 3 failed → 2 counted as deleted");
    assert_eq!(
        freed, 40,
        "proportional attribution: batch_freed=60, actual/count=2/3 → 40"
    );
}

/// `gc_older_than` MUST surface (not silently break) when S3 returns
/// `is_truncated=true` with no `next_continuation_token` — a spec
/// violation that, if silently accepted, would silently under-delete.
/// Returning `Err` lets `runner gc` log a clear cause instead of a
/// quietly skipped page tail.
#[tokio::test]
async fn gc_errors_on_truncated_with_no_token() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output;

    // is_truncated=true but next_continuation_token absent.
    let page = ListObjectsV2Output::builder().is_truncated(true).build();
    let list = mock!(Client::list_objects_v2).then_output(move || page.clone());

    let cache = mock_cache("test-bucket", &[&list]);
    let err = cache
        .gc_older_than(std::time::Duration::from_secs(1))
        .await
        .unwrap_err();

    match err {
        R2Error::S3(msg) => {
            assert!(
                msg.contains("no next_continuation_token"),
                "want descriptive message: {msg}"
            );
        }
        other => panic!("expected R2Error::S3 for missing token, got {other:?}"),
    }
}

/// `gc_older_than` MUST surface (not silently break) when S3 returns
/// the same `next_continuation_token` twice. Without this guard, the
/// loop would re-issue list_objects_v2 with the repeated token forever.
#[tokio::test]
async fn gc_errors_on_repeated_continuation_token() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output;

    // Both calls return is_truncated=true with the same token "stuck-tok".
    let page = ListObjectsV2Output::builder()
        .is_truncated(true)
        .next_continuation_token("stuck-tok")
        .build();
    let list = mock!(Client::list_objects_v2).then_output(move || page.clone());

    let cache = mock_cache("test-bucket", &[&list]);
    let err = cache
        .gc_older_than(std::time::Duration::from_secs(1))
        .await
        .unwrap_err();

    match err {
        R2Error::S3(msg) => {
            assert!(
                msg.contains("identical continuation_token"),
                "want descriptive message: {msg}"
            );
            assert!(
                msg.contains("stuck-tok"),
                "want offending token in message: {msg}"
            );
        }
        other => panic!("expected R2Error::S3 for repeated token, got {other:?}"),
    }
    // Sanity: list was called at least twice — first sets
    // `continuation_token`, second triggers the equality check.
    // Use `>= 2` rather than strict equality to stay robust against
    // any future SDK retry behavior on the list operation.
    assert!(list.num_calls() >= 2, "got {}", list.num_calls());
}
