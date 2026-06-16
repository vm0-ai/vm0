use super::super::{
    R2Error, R2ImageCache,
    config::ENV_VARS,
    keys::{key_for_hash, key_for_template_hash},
};

#[test]
fn key_format() {
    assert_eq!(key_for_hash("abc123"), "runner-images/abc123.tar.zst");
    assert_eq!(
        key_for_template_hash("abc123"),
        "runner-templates/abc123.tar.zst"
    );
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
