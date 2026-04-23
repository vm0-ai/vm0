//! Runner-side content-addressed cache for small storage archives.
//!
//! Sits between `filter_unchanged_storages` and `download_storages` in
//! `run_in_sandbox`. For each eligible manifest entry, checks a host-local
//! cache keyed by `(vasStorageName, vasVersionId)`. On hit, reads the cached
//! tarball from disk and pushes it into the guest via vsock; on miss,
//! downloads the archive from R2 into the cache first. Either way, the
//! entry's `archive_url` is rewritten to `file:///tmp/vm0-storage-cache/<version>.tar.gz`
//! so `guest-download` reads from the local stage instead of re-fetching.
//!
//! Entries above [`CACHE_MAX_SIZE`], entries without a content key, and
//! entries already marked `cached = true` (reuse-in-place from
//! `filter_unchanged_storages`) pass through untouched.
//!
//! Merge-order contract: this module produces `file://` URLs, which only
//! `guest-download` understands after #10805. The PR adding this module
//! must not merge before #10805 is on `main`.

use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::stream::{self, StreamExt};
use reqwest::Client;
use sandbox::{ExecRequest, Sandbox};
use tokio::fs;
use tracing::{debug, warn};

use crate::error::{RunnerError, RunnerResult};
use crate::lock;
use crate::paths::{HomePaths, touch_mtime};
use crate::telemetry::JobTelemetry;
use crate::types::StorageManifest;

/// Archive sizes strictly larger than this are passthrough.
const CACHE_MAX_SIZE: u64 = 8 * 1024 * 1024;

/// Parallel (HEAD / GET / flock / vsock) operations per `populate_cache` call.
const CONCURRENCY: usize = 4;

/// Guest stage directory for `file://` archives.
const GUEST_STAGE_DIR: &str = "/tmp/vm0-storage-cache";

const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const MKDIR_TIMEOUT: Duration = Duration::from_secs(5);

/// One manifest entry that passed the eligibility filter.
#[derive(Clone)]
struct CacheTarget {
    kind: TargetKind,
    index: usize,
    name: String,
    version: String,
    archive_url: String,
}

#[derive(Clone, Copy)]
enum TargetKind {
    Storage,
    Artifact,
}

enum TargetOutcome {
    Hit,
    Miss {
        download_duration: Duration,
    },
    SkippedOverSize,
    /// HEAD probe could not determine archive size, so the entry falls back
    /// to the original R2 URL. `reason` carries either the upstream error
    /// string or a short tag describing the missing-header case so ops can
    /// separate transient network failures from permanent 4xx / missing
    /// `Content-Length` headers in the telemetry feed.
    SkippedHeadFailed {
        reason: String,
    },
}

/// Populate the runner-side cache for eligible entries in `manifest`.
///
/// Mutates `manifest.storages[i].archive_url` / `manifest.artifacts[i].archive_url`
/// in place, rewriting them to `file://` URLs pointing at host-staged tarballs
/// pushed into the guest over vsock.
///
/// Invariant: only touches entries where `cached == false`, `archive_url.is_some()`,
/// and both `vas_storage_name` and `vas_version_id` are set. Entries that
/// `filter_unchanged_storages` marked as reuse-in-place (`archive_url = None`)
/// are left untouched.
pub async fn populate_cache(
    manifest: &mut StorageManifest,
    sandbox: &dyn Sandbox,
    home: &HomePaths,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<()> {
    let targets = collect_targets(manifest);
    if targets.is_empty() {
        return Ok(());
    }

    // One-shot: ensure the guest stage directory exists so the first
    // `sandbox.write_file` has a parent to write into. If #10805 takes on
    // this responsibility in guest-download, this call becomes dead code and
    // is removed in a follow-up commit.
    ensure_guest_stage_dir(sandbox).await?;

    let http = Client::builder()
        .build()
        .map_err(|e| RunnerError::Internal(format!("build http client: {e}")))?;

    // `buffer_unordered` drives up to CONCURRENCY futures concurrently while
    // keeping their borrows alive on the caller's stack. Unlike
    // `tokio::task::JoinSet`, it does not require `'static` futures — which
    // matters because our `sandbox: &dyn Sandbox` is a borrow, not an Arc.
    let outcomes: Vec<(CacheTarget, RunnerResult<TargetOutcome>)> = stream::iter(targets)
        .map(|target| {
            let http = http.clone();
            async move {
                let res = process_one(&target, &http, home, sandbox).await;
                (target, res)
            }
        })
        .buffer_unordered(CONCURRENCY)
        .collect()
        .await;

    for (target, outcome) in outcomes {
        let outcome = outcome?;
        apply_outcome(manifest, &target, &outcome, telemetry);
    }
    Ok(())
}

fn collect_targets(manifest: &StorageManifest) -> Vec<CacheTarget> {
    let mut out = Vec::new();
    for (i, s) in manifest.storages.iter().enumerate() {
        if s.cached {
            continue;
        }
        let Some(url) = s.archive_url.as_deref() else {
            continue;
        };
        let Some(name) = s.vas_storage_name.as_deref() else {
            continue;
        };
        let Some(version) = s.vas_version_id.as_deref() else {
            continue;
        };
        out.push(CacheTarget {
            kind: TargetKind::Storage,
            index: i,
            name: name.to_string(),
            version: version.to_string(),
            archive_url: url.to_string(),
        });
    }
    for (i, a) in manifest.artifacts.iter().enumerate() {
        if a.cached {
            continue;
        }
        let Some(url) = a.archive_url.as_deref() else {
            continue;
        };
        out.push(CacheTarget {
            kind: TargetKind::Artifact,
            index: i,
            name: a.vas_storage_name.clone(),
            version: a.vas_version_id.clone(),
            archive_url: url.to_string(),
        });
    }
    out
}

async fn ensure_guest_stage_dir(sandbox: &dyn Sandbox) -> RunnerResult<()> {
    let cmd = format!("mkdir -p {GUEST_STAGE_DIR}");
    let req = ExecRequest {
        cmd: &cmd,
        timeout: MKDIR_TIMEOUT,
        env: &[],
        sudo: false,
    };
    let res = sandbox.exec(&req).await?;
    if res.exit_code != 0 {
        return Err(RunnerError::Internal(format!(
            "guest mkdir {GUEST_STAGE_DIR} exit={} stderr={}",
            res.exit_code,
            String::from_utf8_lossy(&res.stderr)
        )));
    }
    Ok(())
}

async fn process_one(
    target: &CacheTarget,
    http: &Client,
    home: &HomePaths,
    sandbox: &dyn Sandbox,
) -> RunnerResult<TargetOutcome> {
    // Acquire the per-version flock (blocking, cross-process dedup).
    // Disk-check happens under the lock so we never race with a writer.
    let lock_path = home.storage_lock(&target.name, &target.version);
    let _guard = lock::acquire(lock_path).await?;

    let cache_dir = home.storage_cache_dir(&target.name, &target.version);
    let archive_path = cache_dir.join("archive.tar.gz");

    // 1. Fast path: disk hit. Read the bytes directly and skip the network.
    //    This also makes the hit path resilient to transient HEAD failures.
    if fs::metadata(&archive_path).await.is_ok() {
        let bytes = fs::read(&archive_path).await.map_err(|e| {
            RunnerError::Internal(format!("read cached {}: {e}", archive_path.display()))
        })?;
        touch_mtime(&cache_dir);
        let guest_path = format!("{GUEST_STAGE_DIR}/{}.tar.gz", target.version);
        sandbox.write_file(&guest_path, &bytes).await?;
        return Ok(TargetOutcome::Hit);
    }

    // 2. Miss path: probe size via HEAD. A HEAD failure is treated as
    //    passthrough — the entry keeps its original R2 URL and the guest
    //    downloads it as today. The failure reason is threaded into the
    //    outcome so telemetry can distinguish transient 5xx from missing
    //    `Content-Length` headers.
    let size = match probe_size(http, &target.archive_url).await {
        Ok(Some(n)) => n,
        Ok(None) => {
            warn!(
                name = %target.name,
                version = %target.version,
                "storage_cache: HEAD returned no Content-Length, passthrough"
            );
            return Ok(TargetOutcome::SkippedHeadFailed {
                reason: "missing-content-length".to_string(),
            });
        }
        Err(e) => {
            let reason = e.to_string();
            warn!(
                name = %target.name,
                version = %target.version,
                error = %reason,
                "storage_cache: HEAD probe failed, passthrough"
            );
            return Ok(TargetOutcome::SkippedHeadFailed { reason });
        }
    };
    if size > CACHE_MAX_SIZE {
        debug!(
            name = %target.name,
            version = %target.version,
            size,
            "storage_cache: entry over size limit, passthrough"
        );
        return Ok(TargetOutcome::SkippedOverSize);
    }

    // 3. Download, stage, fsync, atomic rename, then push to guest.
    //    `Bytes` is Arc-backed, so passing `&bytes[..]` to both the disk
    //    writer and the sandbox `write_file` costs zero extra allocation
    //    over the single response body.
    let t = Instant::now();
    let bytes = download_tarball(http, &target.archive_url).await?;
    write_to_cache(&cache_dir, &bytes).await?;
    let guest_path = format!("{GUEST_STAGE_DIR}/{}.tar.gz", target.version);
    sandbox.write_file(&guest_path, &bytes).await?;

    Ok(TargetOutcome::Miss {
        download_duration: t.elapsed(),
    })
}

async fn probe_size(http: &Client, url: &str) -> RunnerResult<Option<u64>> {
    let resp = http
        .head(url)
        .timeout(HEAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| RunnerError::Internal(format!("HEAD {url}: {e}")))?
        .error_for_status()
        .map_err(|e| RunnerError::Internal(format!("HEAD status {url}: {e}")))?;
    Ok(resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok()))
}

async fn download_tarball(http: &Client, url: &str) -> RunnerResult<Bytes> {
    let resp = http
        .get(url)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| RunnerError::Internal(format!("GET {url}: {e}")))?
        .error_for_status()
        .map_err(|e| RunnerError::Internal(format!("GET status {url}: {e}")))?;
    resp.bytes()
        .await
        .map_err(|e| RunnerError::Internal(format!("read body {url}: {e}")))
}

async fn write_to_cache(cache_dir: &Path, bytes: &[u8]) -> RunnerResult<()> {
    let staging = staging_dir(cache_dir);

    // Best-effort cleanup of stale staging from a prior crashed run.
    let _ = fs::remove_dir_all(&staging).await;
    fs::create_dir_all(&staging)
        .await
        .map_err(|e| RunnerError::Internal(format!("create staging {}: {e}", staging.display())))?;

    let archive_staging = staging.join("archive.tar.gz");
    fs::write(&archive_staging, bytes)
        .await
        .map_err(|e| RunnerError::Internal(format!("write {}: {e}", archive_staging.display())))?;

    // fsync the archive so a crash between rename and next sync cannot
    // leave a zero-byte or torn file visible at the final path.
    let f = fs::File::open(&archive_staging).await.map_err(|e| {
        RunnerError::Internal(format!("open for fsync {}: {e}", archive_staging.display()))
    })?;
    f.sync_all()
        .await
        .map_err(|e| RunnerError::Internal(format!("fsync {}: {e}", archive_staging.display())))?;
    drop(f);

    // Ensure the `<name>/` parent exists so the rename below has a target.
    if let Some(parent) = cache_dir.parent() {
        fs::create_dir_all(parent).await.map_err(|e| {
            RunnerError::Internal(format!("create cache parent {}: {e}", parent.display()))
        })?;
    }

    if let Err(e) = fs::rename(&staging, cache_dir).await {
        // A sibling runner may have populated the final dir while we were
        // staging. Only swallow the error if (a) it looks like a "target
        // already exists" kind (EEXIST / ENOTEMPTY on Linux — the kernel
        // returns ENOTEMPTY for a non-empty target and EEXIST for some
        // filesystems) and (b) the expected final artifact is actually
        // there. Any other kernel error (EXDEV, ENOSPC, EACCES, ...) must
        // propagate so callers can surface the real failure.
        if is_rename_collision(&e) && fs::metadata(cache_dir.join("archive.tar.gz")).await.is_ok() {
            let _ = fs::remove_dir_all(&staging).await;
            return Ok(());
        }
        return Err(RunnerError::Internal(format!(
            "rename {} -> {}: {e}",
            staging.display(),
            cache_dir.display()
        )));
    }
    Ok(())
}

/// Whether a `fs::rename` error plausibly means "target already exists or is
/// non-empty" — the race branch where a sibling runner beat us to it.
fn is_rename_collision(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::AlreadyExists | io::ErrorKind::DirectoryNotEmpty
    )
}

/// `<dir>` -> `<dir>.tmp` sibling with the same parent (so rename is atomic).
fn staging_dir(final_dir: &Path) -> PathBuf {
    let mut name = final_dir
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".tmp");
    final_dir.with_file_name(name)
}

fn apply_outcome(
    manifest: &mut StorageManifest,
    target: &CacheTarget,
    outcome: &TargetOutcome,
    telemetry: &mut JobTelemetry,
) {
    match outcome {
        TargetOutcome::Hit => {
            rewrite_url(manifest, target);
            telemetry.record("storage_cache_hit", Duration::ZERO, true, None);
        }
        TargetOutcome::Miss { download_duration } => {
            rewrite_url(manifest, target);
            telemetry.record("storage_cache_miss", Duration::ZERO, true, None);
            telemetry.record("storage_cache_download", *download_duration, true, None);
        }
        TargetOutcome::SkippedOverSize => {
            telemetry.record(
                "storage_cache_skipped_over_size",
                Duration::ZERO,
                true,
                None,
            );
        }
        TargetOutcome::SkippedHeadFailed { reason } => {
            telemetry.record(
                "storage_cache_skipped_head_failed",
                Duration::ZERO,
                true,
                Some(reason.as_str()),
            );
        }
    }
}

/// Rewrite `archive_url` to the guest `file://` stage path.
///
/// Verifies the entry at `target.index` still has the expected
/// `(name, version)` before mutating — content-addressed safety against
/// any future parallel mutation at this pipeline stage. A mismatch is not
/// a hard error (the caller made the right conservative choice) but is
/// logged so a regression that breaks the invariant is visible.
fn rewrite_url(manifest: &mut StorageManifest, target: &CacheTarget) {
    let new_url = format!("file://{GUEST_STAGE_DIR}/{}.tar.gz", target.version);
    let mut applied = false;
    match target.kind {
        TargetKind::Storage => {
            if let Some(entry) = manifest.storages.get_mut(target.index)
                && entry.vas_storage_name.as_deref() == Some(target.name.as_str())
                && entry.vas_version_id.as_deref() == Some(target.version.as_str())
            {
                entry.archive_url = Some(new_url);
                applied = true;
            }
        }
        TargetKind::Artifact => {
            if let Some(entry) = manifest.artifacts.get_mut(target.index)
                && entry.vas_storage_name == target.name
                && entry.vas_version_id == target.version
            {
                entry.archive_url = Some(new_url);
                applied = true;
            }
        }
    }
    if !applied {
        warn!(
            name = %target.name,
            version = %target.version,
            index = target.index,
            "storage_cache: manifest identity mismatch at rewrite, skipping url swap"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use httpmock::Method::{GET, HEAD};
    use httpmock::prelude::*;
    use sandbox_mock::MockSandbox;

    use crate::http::HttpClient;
    use crate::ids::RunId;
    use crate::types::{ArtifactEntry, StorageEntry};

    fn new_telemetry() -> JobTelemetry {
        let http = HttpClient::new("http://localhost:0".to_string()).unwrap();
        JobTelemetry::new(http, RunId::nil(), "test-token".to_string())
    }

    fn home_at(temp: &tempfile::TempDir) -> HomePaths {
        HomePaths::with_root(temp.path().to_path_buf())
    }

    fn manifest_single_storage(url: String, name: &str, version: &str) -> StorageManifest {
        StorageManifest {
            storages: vec![StorageEntry {
                mount_path: format!("/mnt/{name}"),
                archive_url: Some(url),
                cached: false,
                vas_storage_name: Some(name.to_string()),
                vas_version_id: Some(version.to_string()),
            }],
            artifacts: Vec::new(),
            cleanup_paths: Vec::new(),
        }
    }

    fn tarball_bytes() -> Vec<u8> {
        // A small payload is enough — the cache treats it as opaque bytes.
        b"pretend-tar-gz-bytes".to_vec()
    }

    #[tokio::test]
    async fn hit_path_reads_from_disk_and_rewrites_url() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        // Pre-populate the cache to simulate a hit.
        let name = "seed-skill-foo";
        let version = "v1";
        let cache_dir = home.storage_cache_dir(name, version);
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::write(cache_dir.join("archive.tar.gz"), tarball_bytes()).unwrap();

        // Give populate_cache an R2-looking URL — it should never be called.
        let mut manifest = manifest_single_storage(
            "https://r2.example.com/never-called.tar.gz".to_string(),
            name,
            version,
        );

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(format!("file://{GUEST_STAGE_DIR}/{version}.tar.gz").as_str())
        );
        let ops = telemetry.pending_ops_snapshot();
        assert!(
            ops.iter().any(|(k, _, _)| k == "storage_cache_hit"),
            "expected storage_cache_hit in {ops:?}"
        );
    }

    #[tokio::test]
    async fn miss_path_downloads_and_populates_cache() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let head = server
            .mock_async(|when, then| {
                when.method(HEAD).path("/archive.tar.gz");
                then.status(200)
                    .header("content-length", body.len().to_string());
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET).path("/archive.tar.gz");
                then.status(200).body(body.clone());
            })
            .await;

        let url = server.url("/archive.tar.gz");
        let name = "seed-skill-bar";
        let version = "v2";
        let mut manifest = manifest_single_storage(url, name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        head.assert_async().await;
        get.assert_async().await;

        let final_path = home.storage_cache_dir(name, version).join("archive.tar.gz");
        assert!(final_path.exists(), "cache file must exist after miss");
        assert_eq!(std::fs::read(&final_path).unwrap(), body);

        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(format!("file://{GUEST_STAGE_DIR}/{version}.tar.gz").as_str())
        );

        let ops = telemetry.pending_ops_snapshot();
        assert!(ops.iter().any(|(k, _, _)| k == "storage_cache_miss"));
        assert!(ops.iter().any(|(k, _, _)| k == "storage_cache_download"));
    }

    #[tokio::test]
    async fn over_size_entry_is_passthrough() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;

        let too_big = CACHE_MAX_SIZE + 1;
        let head = server
            .mock_async(|when, then| {
                when.method(HEAD).path("/big.tar.gz");
                then.status(200)
                    .header("content-length", too_big.to_string());
            })
            .await;
        // GET must NOT be called for passthrough — no mock registered.

        let original = server.url("/big.tar.gz");
        let name = "user-volume";
        let version = "v9";
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        head.assert_async().await;

        // archive_url untouched.
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(original.as_str())
        );
        // Cache dir must not exist.
        assert!(!home.storage_cache_dir(name, version).exists());

        let ops = telemetry.pending_ops_snapshot();
        assert!(
            ops.iter()
                .any(|(k, _, _)| k == "storage_cache_skipped_over_size")
        );
    }

    #[tokio::test]
    async fn cached_true_entry_is_not_touched() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        // Entry the filter has already marked reuse-in-place: archive_url = None, cached = true.
        let mut manifest = StorageManifest {
            storages: vec![StorageEntry {
                mount_path: "/mnt/foo".into(),
                archive_url: None,
                cached: true,
                vas_storage_name: Some("foo".into()),
                vas_version_id: Some("v1".into()),
            }],
            artifacts: Vec::new(),
            cleanup_paths: Vec::new(),
        };

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        // Unchanged.
        assert!(manifest.storages[0].archive_url.is_none());
        assert!(manifest.storages[0].cached);
        // No telemetry emitted — no eligible targets.
        assert!(telemetry.pending_ops_snapshot().is_empty());
    }

    #[tokio::test]
    async fn missing_content_key_is_passthrough() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        // Entry without vas_storage_name / vas_version_id — pre-epic schema.
        let mut manifest = StorageManifest {
            storages: vec![StorageEntry {
                mount_path: "/mnt/legacy".into(),
                archive_url: Some("https://r2.example.com/legacy.tar.gz".into()),
                cached: false,
                vas_storage_name: None,
                vas_version_id: None,
            }],
            artifacts: Vec::new(),
            cleanup_paths: Vec::new(),
        };

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        // archive_url untouched.
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some("https://r2.example.com/legacy.tar.gz")
        );
    }

    #[tokio::test]
    async fn version_transition_cannot_serve_prev_bytes() {
        // Correctness claim: (name, v1) and (name, v2) live in different
        // directories. A warmed cache for v2 can never serve v1 bytes
        // regardless of reused sandbox state.
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        let name = "rolling-skill";
        let v2_bytes = tarball_bytes();
        let v2_dir = home.storage_cache_dir(name, "v2");
        std::fs::create_dir_all(&v2_dir).unwrap();
        std::fs::write(v2_dir.join("archive.tar.gz"), &v2_bytes).unwrap();

        // If a stale v1 tarball exists, it's under a different cache key and
        // is unreachable via (name, v2).
        let v1_dir = home.storage_cache_dir(name, "v1");
        std::fs::create_dir_all(&v1_dir).unwrap();
        std::fs::write(v1_dir.join("archive.tar.gz"), b"STALE-V1-BYTES").unwrap();

        let mut manifest =
            manifest_single_storage("https://r2.example.com/ignored.tar.gz".into(), name, "v2");

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(format!("file://{GUEST_STAGE_DIR}/v2.tar.gz").as_str())
        );
        // v2 cache retained; v1 cache untouched (only a GC branch would evict it).
        assert!(v2_dir.join("archive.tar.gz").exists());
        assert!(v1_dir.join("archive.tar.gz").exists());
    }

    #[tokio::test]
    async fn artifacts_are_cached_too() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        let name = "build-artifact";
        let version = "build-42";
        let cache_dir = home.storage_cache_dir(name, version);
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::write(cache_dir.join("archive.tar.gz"), tarball_bytes()).unwrap();

        let mut manifest = StorageManifest {
            storages: Vec::new(),
            artifacts: vec![ArtifactEntry {
                mount_path: "/mnt/artifact".into(),
                archive_url: Some("https://r2.example.com/ignored.tar.gz".into()),
                cached: false,
                vas_storage_name: name.to_string(),
                vas_version_id: version.to_string(),
            }],
            cleanup_paths: Vec::new(),
        };

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        assert_eq!(
            manifest.artifacts[0].archive_url.as_deref(),
            Some(format!("file://{GUEST_STAGE_DIR}/{version}.tar.gz").as_str())
        );
    }

    #[tokio::test]
    async fn head_failure_is_passthrough() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;

        let head = server
            .mock_async(|when, then| {
                when.method(HEAD).path("/broken.tar.gz");
                then.status(500);
            })
            .await;

        let original = server.url("/broken.tar.gz");
        let mut manifest = manifest_single_storage(original.clone(), "broken-skill", "v1");

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        head.assert_async().await;

        // archive_url untouched — guest-download will retry via the original URL.
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(original.as_str())
        );
        let ops = telemetry.pending_ops_snapshot();
        assert!(
            ops.iter()
                .any(|(k, _, _)| k == "storage_cache_skipped_head_failed")
        );
    }

    #[test]
    fn staging_dir_is_sibling() {
        let d = PathBuf::from("/var/lib/vm0-runner/storages/foo/v1");
        let s = staging_dir(&d);
        assert_eq!(s, PathBuf::from("/var/lib/vm0-runner/storages/foo/v1.tmp"));
        // Same parent → atomic rename.
        assert_eq!(s.parent(), d.parent());
    }
}
