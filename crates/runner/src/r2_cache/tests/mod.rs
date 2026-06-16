use std::path::{Path, PathBuf};

use super::{
    R2DownloadError, R2Error, R2ImageCache,
    archive::{TEMPLATE_FILE, pack_to_writer, unpack_into_staging},
    config::ENV_VARS,
    download::{file_staging_dir, finalize_staging, finish_file_staging_error, staging_dir},
    gc::{cutoff_unix_secs, select_expired_in_page},
    io_other,
    keys::{key_for_hash, key_for_template_hash},
    multipart::MultipartUploadGuard,
};
use aws_smithy_mocks::{Rule, RuleMode, mock, mock_client};

/// Build a mock `R2ImageCache` from a set of rules. Use `RuleMode::MatchAny`
/// (the issue's operations don't rely on ordered rule exhaustion; per-rule
/// `match_requests` filters disambiguate overlap when present).
fn mock_cache(bucket: &str, rules: &[&Rule]) -> R2ImageCache {
    let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, rules);
    R2ImageCache::with_client(client, bucket.to_string())
}

async fn wait_for_rule_calls(rule: &Rule, expected: usize) {
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            if rule.num_calls() == expected {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {expected} mock call(s)"));
}

#[test]
fn key_format() {
    assert_eq!(key_for_hash("abc123"), "runner-images/abc123.tar.zst");
    assert_eq!(
        key_for_template_hash("abc123"),
        "runner-templates/abc123.tar.zst"
    );
}

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

/// `from_env` requires all-or-nothing on the four env vars.
/// Tests use a single var with each scenario via temporary process env;
/// concurrent execution is safe — `with_clean_r2_env` serializes via
/// `ENV_LOCK` so the snapshot/mutate/restore window is exclusive.
#[tokio::test]
async fn from_env_returns_none_when_all_missing() {
    with_clean_r2_env(|| async {
        let result = R2ImageCache::from_env().await.unwrap();
        assert!(result.is_none(), "all four missing → None");
    })
    .await;
}

#[tokio::test]
async fn from_env_returns_some_when_all_present() {
    with_clean_r2_env(|| async {
        // SAFETY: env mutation is serialized by ENV_LOCK in with_clean_r2_env.
        unsafe {
            std::env::set_var("R2_ACCOUNT_ID", "test-account");
            std::env::set_var("R2_ACCESS_KEY_ID", "test-key");
            std::env::set_var("R2_SECRET_ACCESS_KEY", "test-secret");
            std::env::set_var("R2_USER_STORAGES_BUCKET_NAME", "test-bucket");
        }
        let result = R2ImageCache::from_env().await.unwrap();
        assert!(result.is_some(), "all four set → Some");
        assert_eq!(result.unwrap().bucket, "test-bucket");
    })
    .await;
}

#[tokio::test]
async fn from_env_treats_empty_string_as_unset() {
    // Callers often substitute "" for missing secrets (e.g.
    // `${R2_ACCOUNT_ID:-}` in shell, `lookup('env', ...)` in Ansible).
    // Empty strings are never valid R2 credentials — treat as unset.
    with_clean_r2_env(|| async {
        unsafe {
            for v in &ENV_VARS {
                std::env::set_var(v, "");
            }
        }
        let result = R2ImageCache::from_env().await.unwrap();
        assert!(result.is_none(), "all four empty → None, not Some");
    })
    .await;
}

#[tokio::test]
async fn from_env_errors_on_partial_config() {
    // Set 2 of 4 — should return PartialConfig with the right partition.
    with_clean_r2_env(|| async {
        unsafe {
            std::env::set_var("R2_ACCOUNT_ID", "test");
            std::env::set_var("R2_USER_STORAGES_BUCKET_NAME", "test");
        }
        let err = R2ImageCache::from_env().await.unwrap_err();
        match err {
            R2Error::PartialConfig { present, missing } => {
                assert_eq!(present.len(), 2);
                assert_eq!(missing.len(), 2);
                assert!(present.contains(&"R2_ACCOUNT_ID".to_string()));
                assert!(present.contains(&"R2_USER_STORAGES_BUCKET_NAME".to_string()));
                assert!(missing.contains(&"R2_ACCESS_KEY_ID".to_string()));
                assert!(missing.contains(&"R2_SECRET_ACCESS_KEY".to_string()));
            }
            e => panic!("expected PartialConfig, got {e:?}"),
        }
    })
    .await;
}

/// Process-wide lock that serializes env-mutating tests in this module so
/// they're correct even when the test harness runs threads in parallel
/// (CI uses `cargo llvm-cov` without `--test-threads=1`). Held across the
/// inner `tokio::spawn(...).await` because env vars are process-global —
/// without the lock, two concurrent tests would clobber each other's
/// snapshot/restore. Async-aware so holding across await is sound.
static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Helper: snapshot and clear all R2 env vars before running, restore after.
/// Panic-safe: the closure runs in a `tokio::spawn` task so a panic doesn't
/// skip the restore. SAFETY of `set_var` / `remove_var`: serialized by
/// `ENV_LOCK` above, so no concurrent env mutation can occur.
async fn with_clean_r2_env<F, Fut>(f: F)
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let _guard = ENV_LOCK.lock().await;
    let saved: Vec<(&str, Option<String>)> = ENV_VARS
        .iter()
        .map(|v| (*v, std::env::var(v).ok()))
        .collect();
    unsafe {
        for v in &ENV_VARS {
            std::env::remove_var(v);
        }
    }
    let join = tokio::spawn(f()).await;
    unsafe {
        for (k, v) in saved {
            match v {
                Some(val) => std::env::set_var(k, val),
                None => std::env::remove_var(k),
            }
        }
    }
    // Now propagate any panic from the test body so the test fails properly.
    join.unwrap();
}

// ---- pack / unpack round-trip --------------------------------------

/// Write the rootfs file (the only file cached in R2) into `dir`.
async fn write_mock_image_files(dir: &Path) -> Vec<PathBuf> {
    let rootfs = dir.join("rootfs.ext4");
    tokio::fs::write(&rootfs, b"rootfs-content".repeat(1024))
        .await
        .unwrap();
    vec![rootfs]
}

/// Helper: full atomic unpack from an on-disk archive (test-only path).
/// Mirrors what `try_download` does after the S3 GET succeeds: open file,
/// stream into staging, finalize. Lets the round-trip tests exercise the
/// same code as production without an S3 mock.
async fn unpack_archive_for_test(archive: &Path, final_dir: &Path) -> Result<(), R2Error> {
    let staging = staging_dir(final_dir);
    let _ = tokio::fs::remove_dir_all(&staging).await;
    tokio::fs::create_dir_all(&staging).await?;
    let f = tokio::fs::File::open(archive).await?;
    unpack_into_staging(f, &staging).await?;
    finalize_staging(&staging, final_dir).await?;
    Ok(())
}

#[tokio::test]
async fn pack_then_unpack_round_trips_rootfs() {
    let src_dir = tempfile::tempdir().unwrap();
    let dst_root = tempfile::tempdir().unwrap();
    let final_dir = dst_root.path().join("hash-abc");

    let src_files = write_mock_image_files(src_dir.path()).await;

    let archive = tempfile::NamedTempFile::new().unwrap();
    let archive_path = archive.path().to_path_buf();
    let files_for_pack = src_files.clone();
    tokio::task::spawn_blocking(move || {
        let f = std::fs::File::create(&archive_path).unwrap();
        pack_to_writer(f, &files_for_pack)
    })
    .await
    .unwrap()
    .unwrap();

    unpack_archive_for_test(archive.path(), &final_dir)
        .await
        .unwrap();

    let dst = final_dir.join("rootfs.ext4");
    let src = src_dir.path().join("rootfs.ext4");
    assert!(dst.exists(), "rootfs.ext4 should exist after unpack");
    let dst_meta = std::fs::metadata(&dst).unwrap();
    let src_meta = std::fs::metadata(&src).unwrap();
    assert_eq!(dst_meta.len(), src_meta.len(), "rootfs size mismatch");

    // Staging directory should no longer exist after the rename.
    assert!(!staging_dir(&final_dir).exists());
}

#[tokio::test]
async fn unpack_atomic_no_partial_final_dir_on_failure() {
    // A truncated tar.zst (random bytes that aren't a valid zstd stream)
    // should fail mid-unpack and leave final_dir absent.
    let dst_root = tempfile::tempdir().unwrap();
    let final_dir = dst_root.path().join("hash-bad");

    let bad_archive = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(bad_archive.path(), b"not a valid zstd stream").unwrap();

    let result = unpack_archive_for_test(bad_archive.path(), &final_dir).await;
    assert!(result.is_err(), "unpack of garbage should fail");
    assert!(
        !final_dir.exists(),
        "final_dir must NOT exist after a failed unpack — \
         this is what prevents false-positive cache hits"
    );
}

#[tokio::test]
async fn pack_uses_basename_only() {
    // Files passed to pack_to_writer may have arbitrary parent paths;
    // they should be stored under their basename in the tar so unpack
    // produces a flat directory.
    let src_dir = tempfile::tempdir().unwrap();
    let nested = src_dir.path().join("deeply/nested/path");
    tokio::fs::create_dir_all(&nested).await.unwrap();
    let nested_file = nested.join("rootfs.ext4");
    tokio::fs::write(&nested_file, b"hello").await.unwrap();

    let archive = tempfile::NamedTempFile::new().unwrap();
    let archive_path = archive.path().to_path_buf();
    let files = vec![nested_file];
    tokio::task::spawn_blocking(move || {
        let f = std::fs::File::create(&archive_path).unwrap();
        pack_to_writer(f, &files)
    })
    .await
    .unwrap()
    .unwrap();

    let dst_root = tempfile::tempdir().unwrap();
    let final_dir = dst_root.path().join("out");
    unpack_archive_for_test(archive.path(), &final_dir)
        .await
        .unwrap();

    assert!(final_dir.join("rootfs.ext4").exists());
    // No nested directory in the unpacked output.
    assert!(!final_dir.join("deeply").exists());
}

#[tokio::test]
async fn from_env_errors_on_partial_with_some_empty_strings() {
    // Real-world misconfiguration: 2 secrets typo'd to empty, 2 set.
    // Empty counts as unset (per from_env_treats_empty_string_as_unset),
    // so this should be PartialConfig with present=2, missing=2 — NOT
    // silently disabled (which would happen if all four were empty).
    with_clean_r2_env(|| async {
        unsafe {
            std::env::set_var("R2_ACCOUNT_ID", "real-value");
            std::env::set_var("R2_ACCESS_KEY_ID", ""); // typo'd to empty
            std::env::set_var("R2_SECRET_ACCESS_KEY", ""); // typo'd to empty
            std::env::set_var("R2_USER_STORAGES_BUCKET_NAME", "real-value");
        }
        let err = R2ImageCache::from_env().await.unwrap_err();
        match err {
            R2Error::PartialConfig { present, missing } => {
                assert_eq!(present.len(), 2, "two non-empty present");
                assert_eq!(missing.len(), 2, "two empty treated as missing");
                assert!(missing.contains(&"R2_ACCESS_KEY_ID".to_string()));
                assert!(missing.contains(&"R2_SECRET_ACCESS_KEY".to_string()));
            }
            e => panic!("expected PartialConfig, got {e:?}"),
        }
    })
    .await;
}

// ---- defensive / security edge cases --------------------------------

/// Helper: pack a synchronous closure on a blocking thread.
async fn pack_blocking<F>(archive: &Path, f: F) -> Result<(), R2Error>
where
    F: FnOnce(std::fs::File) -> Result<(), R2Error> + Send + 'static,
{
    let p = archive.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let out = std::fs::File::create(&p).unwrap();
        f(out)
    })
    .await
    .unwrap()
}

/// Hand-write a 512-byte ustar header so we can put `..` in the path —
/// `tar::Builder` defends against this on the write side too.
fn craft_tar_with_path(name: &[u8], data: &[u8]) -> Vec<u8> {
    assert!(name.len() < 100);
    let mut header = [0u8; 512];
    header[..name.len()].copy_from_slice(name);
    header[100..108].copy_from_slice(b"0000644\0");
    header[108..116].copy_from_slice(b"0000000\0");
    header[116..124].copy_from_slice(b"0000000\0");
    let size_str = format!("{:011o}\0", data.len());
    header[124..136].copy_from_slice(size_str.as_bytes());
    header[136..148].copy_from_slice(b"00000000000\0");
    // cksum is computed with these 8 bytes counted as spaces.
    header[148..156].copy_from_slice(b"        ");
    header[156] = b'0'; // typeflag: regular file
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    let cksum: u32 = header.iter().map(|&b| u32::from(b)).sum();
    let cksum_str = format!("{cksum:06o}\0 ");
    header[148..156].copy_from_slice(cksum_str.as_bytes());

    let mut tar = Vec::with_capacity(512 + 512 + 1024);
    tar.extend_from_slice(&header);
    let mut data_block = [0u8; 512];
    data_block[..data.len()].copy_from_slice(data);
    tar.extend_from_slice(&data_block);
    // Two zero blocks mark end-of-archive.
    tar.extend_from_slice(&[0u8; 1024]);
    tar
}

/// Hand-write a ustar header with a specific typeflag byte. Used to test
/// that `unpack_from_reader` rejects non-regular entries.
/// `typeflag`: `b'2'` = symlink, `b'1'` = hardlink, etc.
/// `link_target`: written into the linkname field (bytes 157..257).
fn craft_tar_with_typeflag(name: &[u8], typeflag: u8, link_target: &[u8]) -> Vec<u8> {
    assert!(name.len() < 100);
    assert!(link_target.len() < 100);
    let mut header = [0u8; 512];
    header[..name.len()].copy_from_slice(name);
    header[100..108].copy_from_slice(b"0000644\0");
    header[108..116].copy_from_slice(b"0000000\0");
    header[116..124].copy_from_slice(b"0000000\0");
    // size = 0 for symlinks/hardlinks
    header[124..136].copy_from_slice(b"00000000000\0");
    header[136..148].copy_from_slice(b"00000000000\0");
    header[148..156].copy_from_slice(b"        ");
    header[156] = typeflag;
    header[157..157 + link_target.len()].copy_from_slice(link_target);
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    let cksum: u32 = header.iter().map(|&b| u32::from(b)).sum();
    let cksum_str = format!("{cksum:06o}\0 ");
    header[148..156].copy_from_slice(cksum_str.as_bytes());

    let mut tar = Vec::with_capacity(512 + 1024);
    tar.extend_from_slice(&header);
    // No data blocks for symlinks/hardlinks. Two zero blocks = end-of-archive.
    tar.extend_from_slice(&[0u8; 1024]);
    tar
}

/// `tar::Archive::unpack` must reject entries whose path escapes via `..` so
/// attacker-controlled artifacts can't write outside the staging directory
/// (defense-in-depth — R2 bucket is private, but if an IAM key leaked, this
/// would prevent escalation).
#[tokio::test]
async fn unpack_rejects_path_traversal() {
    let raw_tar = craft_tar_with_path(b"../escaped.txt", b"hello");
    let archive = tempfile::NamedTempFile::new().unwrap();
    let archive_path = archive.path().to_path_buf();
    tokio::task::spawn_blocking(move || {
        let out = std::fs::File::create(&archive_path).unwrap();
        let mut zw = zstd::stream::write::Encoder::new(out, 1).unwrap();
        std::io::Write::write_all(&mut zw, &raw_tar).unwrap();
        zw.finish().unwrap();
    })
    .await
    .unwrap();

    let dst_root = tempfile::tempdir().unwrap();
    let final_dir = dst_root.path().join("hash");
    // tar 0.4 silently SKIPS entries with `..` components (returns Ok(false)
    // from Entry::unpack_in) and Archive::unpack happily continues. So the
    // unpack succeeds with an empty staging dir → finalize_staging renames
    // it to final_dir which exists but is empty. The security invariant is
    // not "must error" — it is "must not write outside dst".
    unpack_archive_for_test(archive.path(), &final_dir)
        .await
        .unwrap();

    // Critical: nothing escaped to the parent of staging/final_dir.
    assert!(
        !dst_root.path().join("escaped.txt").exists(),
        "escaped.txt MUST NOT appear at the dst_root level"
    );
    // The malicious entry was dropped, so final_dir is empty.
    let entries: Vec<_> = std::fs::read_dir(&final_dir).unwrap().collect();
    assert!(
        entries.is_empty(),
        "malicious entry should be dropped, final_dir empty, got {entries:?}"
    );
}

/// Helper: assert that a tar with the given typeflag is rejected by
/// `unpack_from_reader`. Covers symlink, hardlink, and any other
/// non-regular entry type.
async fn assert_unpack_rejects_typeflag(typeflag: u8, link_target: &[u8]) {
    let raw_tar = craft_tar_with_typeflag(b"rootfs.ext4", typeflag, link_target);
    let archive = tempfile::NamedTempFile::new().unwrap();
    let archive_path = archive.path().to_path_buf();
    tokio::task::spawn_blocking(move || {
        let out = std::fs::File::create(&archive_path).unwrap();
        let mut zw = zstd::stream::write::Encoder::new(out, 1).unwrap();
        std::io::Write::write_all(&mut zw, &raw_tar).unwrap();
        zw.finish().unwrap();
    })
    .await
    .unwrap();

    let dst_root = tempfile::tempdir().unwrap();
    let final_dir = dst_root.path().join("hash");
    let err = unpack_archive_for_test(archive.path(), &final_dir)
        .await
        .unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("rejected non-regular tar entry"),
        "expected rejection error, got: {msg}"
    );
    assert!(
        !final_dir.exists(),
        "final_dir must not be created on error"
    );
}

/// Symlink entries must be rejected — an attacker could point
/// `rootfs.ext4` at `/etc/shadow` to leak host file contents.
#[tokio::test]
async fn unpack_rejects_symlink_entries() {
    assert_unpack_rejects_typeflag(b'2', b"/etc/shadow").await;
}

/// Hardlink entries must be rejected — could alias existing host files.
#[tokio::test]
async fn unpack_rejects_hardlink_entries() {
    assert_unpack_rejects_typeflag(b'1', b"/etc/passwd").await;
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

/// `pack_to_writer` propagates I/O errors from `append_path_with_name` —
/// e.g., source file removed between `expected_files()` enumeration and pack.
#[tokio::test]
async fn pack_errors_on_missing_source_file() {
    let archive = tempfile::NamedTempFile::new().unwrap();
    let nonexistent = PathBuf::from("/definitely/does/not/exist/rootfs.ext4");
    let result = pack_blocking(archive.path(), move |out| {
        pack_to_writer(out, std::slice::from_ref(&nonexistent))
    })
    .await;
    match result {
        Err(R2Error::Io(_)) => {} // expected
        other => panic!("expected R2Error::Io for missing source, got {other:?}"),
    }
}

/// `R2ImageCache::Debug` must not leak credentials — if logs ever capture
/// `{:?}` on a cache (e.g. via `tracing` instrumentation), only the
/// bucket name should appear, not account_id / access_key / secret.
#[tokio::test]
async fn debug_format_does_not_leak_credentials() {
    with_clean_r2_env(|| async {
        // SAFETY: env mutation is serialized by ENV_LOCK in with_clean_r2_env.
        unsafe {
            std::env::set_var("R2_ACCOUNT_ID", "secret-account-id-do-not-leak");
            std::env::set_var("R2_ACCESS_KEY_ID", "AKIAEXAMPLEDONOTLEAK");
            std::env::set_var("R2_SECRET_ACCESS_KEY", "secret-key-MUST-NOT-appear-in-logs");
            std::env::set_var("R2_USER_STORAGES_BUCKET_NAME", "test-bucket");
        }
        let cache = R2ImageCache::from_env().await.unwrap().unwrap();
        let dbg = format!("{cache:?}");
        assert!(
            !dbg.contains("secret-account-id-do-not-leak"),
            "Debug leaked account_id: {dbg}"
        );
        assert!(
            !dbg.contains("AKIAEXAMPLEDONOTLEAK"),
            "Debug leaked access_key_id: {dbg}"
        );
        assert!(
            !dbg.contains("secret-key-MUST-NOT-appear-in-logs"),
            "Debug leaked secret_key: {dbg}"
        );
        assert!(
            dbg.contains("test-bucket"),
            "Debug should still expose bucket for diagnostic value: {dbg}"
        );
    })
    .await;
}

/// Empty file list: pack succeeds and produces a valid (empty) tar.zst.
/// Round-trip unpack gives an empty `final_dir`. This is degenerate but
/// must not panic — it's the canary for the caller's post-download
/// completeness check (currently: rootfs.ext4 presence) to catch.
#[tokio::test]
async fn pack_unpack_empty_files_list() {
    let archive = tempfile::NamedTempFile::new().unwrap();
    pack_blocking(archive.path(), |out| pack_to_writer(out, &[]))
        .await
        .unwrap();

    let dst_root = tempfile::tempdir().unwrap();
    let final_dir = dst_root.path().join("hash");
    unpack_archive_for_test(archive.path(), &final_dir)
        .await
        .unwrap();

    assert!(final_dir.exists());
    let entries: Vec<_> = std::fs::read_dir(&final_dir).unwrap().collect();
    assert!(
        entries.is_empty(),
        "empty pack → empty unpack, got {entries:?}"
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

// ---- upload: force + dedup + multipart lifecycle -------------------
//
// Size the payload below `PART_SIZE` (16 MiB) so the happy path issues
// exactly one `upload_part` — keeps mock setup compact. Multi-part
// correctness is already exercised structurally by the pack/unpack
// round-trip test.

/// Write one small file (1 KiB) that `upload()` will pack into a tar.zst.
async fn small_src_file() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rootfs.ext4");
    tokio::fs::write(&path, vec![0u8; 1024]).await.unwrap();
    (dir, path)
}

/// Mock-rule factory for the happy-path multipart triad.
/// Returns (create, upload_part, complete) rules. Caller wires them with
/// any head_object rule needed by the specific test.
fn multipart_success_rules() -> (Rule, Rule, Rule) {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::complete_multipart_upload::CompleteMultipartUploadOutput;
    use aws_sdk_s3::operation::create_multipart_upload::CreateMultipartUploadOutput;
    use aws_sdk_s3::operation::upload_part::UploadPartOutput;

    let create = mock!(Client::create_multipart_upload).then_output(|| {
        CreateMultipartUploadOutput::builder()
            .upload_id("test-upload-id")
            .build()
    });
    let upload_part = mock!(Client::upload_part)
        .then_output(|| UploadPartOutput::builder().e_tag("\"etag-123\"").build());
    let complete = mock!(Client::complete_multipart_upload)
        .then_output(|| CompleteMultipartUploadOutput::builder().build());
    (create, upload_part, complete)
}

/// `force = true` MUST NOT call `head_object` — the corrupt-eviction
/// contract: after detecting a bad object (download succeeded but
/// rootfs.ext4 missing), the caller relies on `upload(_, _, true)` to
/// force-overwrite without re-checking existence (which would still
/// say "exists, skip").
#[tokio::test]
async fn upload_force_true_bypasses_exists_check() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::head_object::HeadObjectOutput;

    let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().build());
    let (create, upload_part, complete) = multipart_success_rules();
    let cache = mock_cache("test-bucket", &[&head, &create, &upload_part, &complete]);

    let (_dir, path) = small_src_file().await;
    cache.upload("abc", &[path], true).await.unwrap();

    assert_eq!(head.num_calls(), 0, "force=true must skip head_object");
    assert_eq!(create.num_calls(), 1);
    assert_eq!(upload_part.num_calls(), 1);
    assert_eq!(complete.num_calls(), 1);
}

/// `force = false` + object exists → dedup-skip; multipart triad never
/// runs. Saves bandwidth across peer hosts.
#[tokio::test]
async fn upload_force_false_dedup_skips_when_exists() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::head_object::HeadObjectOutput;

    let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().build());
    let (create, upload_part, complete) = multipart_success_rules();
    let cache = mock_cache("test-bucket", &[&head, &create, &upload_part, &complete]);

    let (_dir, path) = small_src_file().await;
    cache.upload("abc", &[path], false).await.unwrap();

    assert_eq!(head.num_calls(), 1, "head_object consulted exactly once");
    assert_eq!(
        create.num_calls(),
        0,
        "dedup short-circuits before multipart"
    );
    assert_eq!(upload_part.num_calls(), 0);
    assert_eq!(complete.num_calls(), 0);
}

/// `force = false` + `head_object` returns `NotFound` → proceed through
/// the full multipart pipeline. Distinct from force=true (which skips
/// head entirely) because here head IS consulted, it just returns miss.
#[tokio::test]
async fn upload_force_false_proceeds_when_not_found() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::head_object::HeadObjectError;
    use aws_sdk_s3::types::error::NotFound;

    let head = mock!(Client::head_object)
        .then_error(|| HeadObjectError::NotFound(NotFound::builder().build()));
    let (create, upload_part, complete) = multipart_success_rules();
    let cache = mock_cache("test-bucket", &[&head, &create, &upload_part, &complete]);

    let (_dir, path) = small_src_file().await;
    cache.upload("abc", &[path], false).await.unwrap();

    assert_eq!(head.num_calls(), 1);
    assert_eq!(create.num_calls(), 1);
    assert_eq!(complete.num_calls(), 1);
}

#[tokio::test]
async fn upload_template_uses_template_prefix() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::complete_multipart_upload::CompleteMultipartUploadOutput;
    use aws_sdk_s3::operation::create_multipart_upload::CreateMultipartUploadOutput;
    use aws_sdk_s3::operation::upload_part::UploadPartOutput;

    let create = mock!(Client::create_multipart_upload)
        .match_requests(|req| {
            req.bucket() == Some("test-bucket") && req.key() == Some("runner-templates/abc.tar.zst")
        })
        .then_output(|| {
            CreateMultipartUploadOutput::builder()
                .upload_id("test-upload-id")
                .build()
        });
    let upload_part = mock!(Client::upload_part)
        .then_output(|| UploadPartOutput::builder().e_tag("\"etag-123\"").build());
    let complete = mock!(Client::complete_multipart_upload)
        .then_output(|| CompleteMultipartUploadOutput::builder().build());
    let cache = mock_cache("test-bucket", &[&create, &upload_part, &complete]);

    let (_dir, path) = small_src_file().await;
    cache.upload_template("abc", &path, true).await.unwrap();

    assert_eq!(create.num_calls(), 1);
    assert_eq!(upload_part.num_calls(), 1);
    assert_eq!(complete.num_calls(), 1);
}

/// `complete_multipart_upload` failure (server-side validation after all
/// parts uploaded) MUST trigger `abort_multipart_upload`. Without this,
/// the abandoned upload_id lingers until R2's 7-day lifecycle sweeps it.
#[tokio::test]
async fn upload_aborts_multipart_when_complete_fails() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::abort_multipart_upload::AbortMultipartUploadOutput;
    use aws_sdk_s3::operation::create_multipart_upload::CreateMultipartUploadOutput;
    use aws_sdk_s3::operation::upload_part::UploadPartOutput;

    let create = mock!(Client::create_multipart_upload).then_output(|| {
        CreateMultipartUploadOutput::builder()
            .upload_id("test-upload-id")
            .build()
    });
    let upload_part = mock!(Client::upload_part)
        .then_output(|| UploadPartOutput::builder().e_tag("\"etag-123\"").build());
    // CompleteMultipartUpload returns a 500 so the SDK surfaces it as an
    // SdkError — r2_cache converts that to R2Error::S3 via the From impl.
    // Using `http_status` (provided by `aws-smithy-mocks`) avoids
    // pulling `aws-smithy-types` / `aws-smithy-runtime-api` in as
    // explicit dev-deps.
    let complete = mock!(Client::complete_multipart_upload)
        .sequence()
        .http_status(
            500,
            Some("<Error><Code>InternalError</Code></Error>".into()),
        )
        .build();
    let abort = mock!(Client::abort_multipart_upload)
        .then_output(|| AbortMultipartUploadOutput::builder().build());

    let cache = mock_cache("test-bucket", &[&create, &upload_part, &complete, &abort]);

    let (_dir, path) = small_src_file().await;
    let result = cache.upload("abc", &[path], true).await;

    assert!(matches!(result, Err(R2Error::S3(_))), "got {result:?}");
    assert!(complete.num_calls() >= 1, "complete was dispatched");
    // abort is the contract under test; exactly one abort is expected
    // even if the SDK retried `complete` internally — r2_cache issues
    // one best-effort abort per failed upload (not per retry).
    assert_eq!(abort.num_calls(), 1, "abort MUST run on Complete failure");
}

/// Dropping the upload future after `CreateMultipartUpload` must not leave
/// server-side multipart state behind until R2 lifecycle cleanup. The guard
/// schedules a detached abort on drop, which is the cancellation path that
/// normal error-return tests do not exercise.
#[tokio::test]
async fn multipart_upload_guard_aborts_on_drop() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::abort_multipart_upload::AbortMultipartUploadOutput;

    let abort = mock!(Client::abort_multipart_upload)
        .match_requests(|req| {
            req.bucket() == Some("test-bucket")
                && req.key() == Some("runner-templates/abc.tar.zst")
                && req.upload_id() == Some("test-upload-id")
        })
        .then_output(|| AbortMultipartUploadOutput::builder().build());
    let cache = mock_cache("test-bucket", &[&abort]);

    drop(MultipartUploadGuard::new(
        cache.client.clone(),
        cache.bucket.clone(),
        key_for_template_hash("abc"),
        "test-upload-id".to_string(),
    ));

    wait_for_rule_calls(&abort, 1).await;
}

/// Missing `e_tag` on `upload_part` response → `R2Error::S3` with the
/// part_number interpolated, so operators can pin a `Complete`-time
/// "InvalidPart" to the specific failed upload without log archaeology.
#[tokio::test]
async fn upload_part_missing_etag_errors_with_part_number() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::abort_multipart_upload::AbortMultipartUploadOutput;
    use aws_sdk_s3::operation::create_multipart_upload::CreateMultipartUploadOutput;
    use aws_sdk_s3::operation::upload_part::UploadPartOutput;

    let create = mock!(Client::create_multipart_upload).then_output(|| {
        CreateMultipartUploadOutput::builder()
            .upload_id("test-upload-id")
            .build()
    });
    // Response with no `e_tag`: surfaces as pinned error, Complete never
    // runs (pack→stream→complete pipeline short-circuits on upload error).
    let upload_part =
        mock!(Client::upload_part).then_output(|| UploadPartOutput::builder().build());
    // Abort is best-effort on any error path — include a mock so the SDK
    // dispatch doesn't panic on unmatched.
    let abort = mock!(Client::abort_multipart_upload)
        .then_output(|| AbortMultipartUploadOutput::builder().build());

    let cache = mock_cache("test-bucket", &[&create, &upload_part, &abort]);

    let (_dir, path) = small_src_file().await;
    let err = cache.upload("abc", &[path], true).await.unwrap_err();

    match err {
        R2Error::S3(msg) => {
            assert!(
                msg.contains("upload_part 1"),
                "want pinned part_number: {msg}"
            );
            assert!(msg.contains("missing e_tag"), "want missing e_tag: {msg}");
        }
        other => panic!("expected R2Error::S3 with pinned part_number, got {other:?}"),
    }
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

/// Pack a tar.zst archive from a test file in-memory. Used to synthesize
/// a valid body for a mocked `get_object` response.
async fn build_test_archive_bytes() -> Vec<u8> {
    let src = tempfile::tempdir().unwrap();
    let name = src.path().join("rootfs.ext4");
    tokio::fs::write(&name, b"hello").await.unwrap();
    let files = vec![name];
    // `src` lives until this fn returns, which happens after the await
    // resolves — by which point `pack_to_writer` has finished reading
    // the file. Natural drop at end-of-scope is sufficient.
    tokio::task::spawn_blocking(move || {
        let mut buf: Vec<u8> = Vec::new();
        pack_to_writer(&mut buf, &files).unwrap();
        buf
    })
    .await
    .unwrap()
}

async fn build_template_archive_bytes() -> Vec<u8> {
    let src = tempfile::tempdir().unwrap();
    let name = src.path().join(TEMPLATE_FILE);
    tokio::fs::write(&name, b"hello").await.unwrap();
    let files = vec![name];
    tokio::task::spawn_blocking(move || {
        let mut buf: Vec<u8> = Vec::new();
        pack_to_writer(&mut buf, &files).unwrap();
        buf
    })
    .await
    .unwrap()
}

async fn build_template_archive_bytes_with_extra() -> Vec<u8> {
    let src = tempfile::tempdir().unwrap();
    let template = src.path().join(TEMPLATE_FILE);
    let extra = src.path().join("extra.txt");
    tokio::fs::write(&template, b"hello").await.unwrap();
    tokio::fs::write(&extra, b"discard me").await.unwrap();
    let files = vec![template, extra];
    tokio::task::spawn_blocking(move || {
        let mut buf: Vec<u8> = Vec::new();
        pack_to_writer(&mut buf, &files).unwrap();
        buf
    })
    .await
    .unwrap()
}

async fn build_nested_template_archive_bytes() -> Vec<u8> {
    zstd_bytes(craft_tar_with_path(b"template.ext4/payload", b"bad")).await
}

async fn build_empty_archive_bytes() -> Vec<u8> {
    tokio::task::spawn_blocking(move || {
        let mut buf: Vec<u8> = Vec::new();
        pack_to_writer(&mut buf, &[]).unwrap();
        buf
    })
    .await
    .unwrap()
}

async fn zstd_bytes(raw_tar: Vec<u8>) -> Vec<u8> {
    tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        let mut encoder = zstd::stream::write::Encoder::new(&mut out, 1).unwrap();
        std::io::Write::write_all(&mut encoder, &raw_tar).unwrap();
        encoder.finish().unwrap();
        out
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn try_download_template_materializes_template_file() {
    use std::sync::Arc;

    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::primitives::ByteStream;

    let archive = Arc::new(build_template_archive_bytes().await);
    let archive_for_closure = Arc::clone(&archive);
    let get = mock!(Client::get_object)
        .match_requests(|req| {
            req.bucket() == Some("test-bucket")
                && req.key() == Some("runner-templates/hash.tar.zst")
        })
        .then_output(move || {
            GetObjectOutput::builder()
                .body(ByteStream::from((*archive_for_closure).clone()))
                .build()
        });
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
    use std::sync::Arc;

    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::primitives::ByteStream;

    let archive = Arc::new(build_template_archive_bytes().await);
    let archive_for_closure = Arc::clone(&archive);
    let get = mock!(Client::get_object).then_output(move || {
        GetObjectOutput::builder()
            .body(ByteStream::from((*archive_for_closure).clone()))
            .build()
    });
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
    use std::sync::Arc;

    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::primitives::ByteStream;

    let archive = Arc::new(zstd_bytes(craft_tar_with_path(b"../escaped.txt", b"bad")).await);
    let archive_for_closure = Arc::clone(&archive);
    let get = mock!(Client::get_object).then_output(move || {
        GetObjectOutput::builder()
            .body(ByteStream::from((*archive_for_closure).clone()))
            .build()
    });
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
    use std::sync::Arc;

    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::primitives::ByteStream;

    let archive = Arc::new(build_template_archive_bytes_with_extra().await);
    let archive_for_closure = Arc::clone(&archive);
    let get = mock!(Client::get_object).then_output(move || {
        GetObjectOutput::builder()
            .body(ByteStream::from((*archive_for_closure).clone()))
            .build()
    });
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
    use std::sync::Arc;

    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::primitives::ByteStream;

    let archive = Arc::new(build_nested_template_archive_bytes().await);
    let archive_for_closure = Arc::clone(&archive);
    let get = mock!(Client::get_object).then_output(move || {
        GetObjectOutput::builder()
            .body(ByteStream::from((*archive_for_closure).clone()))
            .build()
    });
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
    use std::sync::Arc;

    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::primitives::ByteStream;

    let archive = Arc::new(build_nested_template_archive_bytes().await);
    let archive_for_closure = Arc::clone(&archive);
    let get = mock!(Client::get_object).then_output(move || {
        GetObjectOutput::builder()
            .body(ByteStream::from((*archive_for_closure).clone()))
            .build()
    });
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
    use std::sync::Arc;

    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::primitives::ByteStream;

    let archive = Arc::new(build_empty_archive_bytes().await);
    let archive_for_closure = Arc::clone(&archive);
    let get = mock!(Client::get_object).then_output(move || {
        GetObjectOutput::builder()
            .body(ByteStream::from((*archive_for_closure).clone()))
            .build()
    });
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
    use std::sync::Arc;

    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::primitives::ByteStream;

    let archive = Arc::new(build_empty_archive_bytes().await);
    let archive_for_closure = Arc::clone(&archive);
    let get = mock!(Client::get_object).then_output(move || {
        GetObjectOutput::builder()
            .body(ByteStream::from((*archive_for_closure).clone()))
            .build()
    });
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
    use std::sync::Arc;

    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::primitives::ByteStream;

    let archive = Arc::new(build_template_archive_bytes().await);
    let archive_for_closure = Arc::clone(&archive);
    let get = mock!(Client::get_object).then_output(move || {
        GetObjectOutput::builder()
            .body(ByteStream::from((*archive_for_closure).clone()))
            .build()
    });
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
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::primitives::ByteStream;

    let get = mock!(Client::get_object).then_output(|| {
        GetObjectOutput::builder()
            .body(ByteStream::from_static(b"not a valid zstd stream"))
            .build()
    });
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
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::primitives::ByteStream;

    let get = mock!(Client::get_object).then_output(|| {
        GetObjectOutput::builder()
            .body(ByteStream::from_static(b"not a valid zstd stream"))
            .build()
    });
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
    use std::sync::Arc;

    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::primitives::ByteStream;

    let archive = Arc::new(build_test_archive_bytes().await);
    let archive_for_closure = Arc::clone(&archive);
    let get = mock!(Client::get_object).then_output(move || {
        GetObjectOutput::builder()
            .body(ByteStream::from((*archive_for_closure).clone()))
            .build()
    });
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
    use std::sync::Arc;

    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::primitives::ByteStream;

    let archive = Arc::new(build_test_archive_bytes().await);
    let archive_for_closure = Arc::clone(&archive);
    let get = mock!(Client::get_object).then_output(move || {
        GetObjectOutput::builder()
            .body(ByteStream::from((*archive_for_closure).clone()))
            .build()
    });
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
