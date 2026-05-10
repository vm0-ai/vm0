//! Runner-side content-addressed cache for small storage archives.
//!
//! Sits between `filter_unchanged_storages` and `download_storages` in
//! `run_in_sandbox`. For each eligible manifest entry, checks a host-local
//! cache keyed by `(vasStorageName, vasVersionId)`. On hit, stages the cached
//! tarball into the guest with a batched `write_files` vsock stream; on miss,
//! downloads the archive from R2 into the cache first and then stages it with
//! the same path. Either way, the entry's `archive_url` is rewritten to
//! `file:///tmp/vm0-storage-cache/<hash(name)>-<hash(version)>.tar.gz`
//! so `guest-download` reads from the local stage instead of re-fetching.
//! Keying on both name and version keeps the guest file injective in the
//! `(vasStorageName, vasVersionId)` pair — two entries that only differ in
//! storage name cannot clobber each other on the guest tmpfs.
//!
//! Entries above [`CACHE_MAX_SIZE`], entries without a content key, and
//! entries already marked `cached = true` (reuse-in-place from
//! `filter_unchanged_storages`) pass through untouched.
//! If the probe says an entry is cache-eligible but the full response exceeds
//! [`CACHE_MAX_SIZE`], the cache fails closed instead of handing the same
//! inconsistent URL to the guest.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::stream::{self, StreamExt};
use reqwest::Client;
use sandbox::{
    BoundedExecCapturePolicy, BoundedExecOutput, BoundedExecOutputRequest, BoundedExecRequest,
    BoundedExecTermination, Sandbox, WriteFileRequest, WriteFileSource,
};
use tokio::fs;
use tracing::{debug, warn};

use crate::error::{RunnerError, RunnerResult};
use crate::lock;
use crate::paths::{HomePaths, short_digest, touch_mtime};
use crate::telemetry::JobTelemetry;
use crate::types::GuestDownloadManifest;

/// Archive sizes strictly larger than this are passthrough.
const CACHE_MAX_SIZE: u64 = 8 * 1024 * 1024;

/// Parallel (probe GET / full GET / flock) operations per `populate_cache` call.
const CONCURRENCY: usize = 4;

/// Guest stage directory for `file://` archives.
const GUEST_STAGE_DIR: &str = "/tmp/vm0-storage-cache";

const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

/// Guest-side filename for a cached archive.
///
/// Must be injective in `(name, version)`: two manifest entries that differ
/// only in `vas_storage_name` but share `vas_version_id` end up at distinct
/// `file://` URLs so one staged archive cannot clobber another. Uses the
/// same `short_digest` helper that `HomePaths` uses for
/// the host cache dir, so the two keys always map 1:1.
fn guest_archive_path(name: &str, version: &str) -> String {
    let name_hash = short_digest(name);
    let version_hash = short_digest(version);
    format!("{GUEST_STAGE_DIR}/{name_hash}-{version_hash}.tar.gz")
}

/// One manifest entry that passed the eligibility filter.
#[derive(Clone)]
struct CacheTarget {
    kind: TargetKind,
    index: usize,
    name: String,
    version: String,
    archive_url: String,
}

struct TargetGroup {
    representative: CacheTarget,
    members: Vec<CacheTarget>,
}

#[derive(Clone, Copy)]
enum TargetKind {
    Storage,
    Artifact,
}

#[derive(Clone)]
struct StageArchive {
    name: String,
    version: String,
    guest_path: String,
    archive_path: PathBuf,
    len: u64,
}

struct ProcessedTarget {
    outcome: TargetOutcome,
}

enum TargetOutcome {
    Hit {
        stage: StageArchive,
    },
    Miss {
        download_duration: Duration,
        stage: StageArchive,
    },
    SkippedOverSize,
    /// Size probe (`GET` + `Range: bytes=0-0`) could not determine the
    /// archive size, so the entry falls back to the original R2 URL.
    /// `reason` carries either the upstream error string or a short tag
    /// describing the missing-header case so ops can separate transient
    /// network failures from permanent 4xx / missing size-header responses
    /// in the telemetry feed.
    SkippedHeadFailed {
        reason: String,
    },
    /// The local archive was ready after cache processing, but became
    /// unavailable before guest staging. Cache is an optimization, so keep the
    /// manifest pointed at the original URL instead of failing the run.
    SkippedStageUnavailable {
        reason: String,
    },
}

impl TargetOutcome {
    fn stage(&self) -> Option<&StageArchive> {
        match self {
            Self::Hit { stage } | Self::Miss { stage, .. } => Some(stage),
            Self::SkippedOverSize
            | Self::SkippedHeadFailed { .. }
            | Self::SkippedStageUnavailable { .. } => None,
        }
    }
}

struct LockedStageArchives {
    stages: Vec<StageArchive>,
    skipped: Vec<SkippedStageArchive>,
    guards: Vec<nix::fcntl::Flock<std::fs::File>>,
}

struct SkippedStageArchive {
    name: String,
    version: String,
    reason: String,
}

enum DownloadBody {
    Complete(Bytes),
    OverSize { observed_size: u64 },
}

/// Populate the runner-side cache for eligible entries in `manifest`.
///
/// Mutates `manifest.storages[i].archive_url` / `manifest.artifacts[i].archive_url`
/// in place, rewriting them to `file://` URLs pointing at host-staged tarballs
/// pushed into the guest over vsock.
///
/// Invariant: only touches entries where `cached == false`, `archive_url.is_some()`,
/// and both `vas_storage_name` and `vas_version_id` are non-empty. Entries that
/// `filter_unchanged_storages` marked as reuse-in-place (`archive_url = None`)
/// are left untouched.
pub async fn populate_cache(
    manifest: &mut GuestDownloadManifest,
    sandbox: &dyn Sandbox,
    home: &HomePaths,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<()> {
    let groups = group_targets(collect_targets(manifest));
    if groups.is_empty() {
        return Ok(());
    }

    let http = Client::builder()
        .build()
        .map_err(|e| RunnerError::Internal(format!("build http client: {e}")))?;

    // `buffer_unordered` drives up to CONCURRENCY futures concurrently while
    // keeping their borrows alive on the caller's stack. Unlike
    // `tokio::task::JoinSet`, it does not require `'static` futures — which
    // matters because our `sandbox: &dyn Sandbox` is a borrow, not an Arc.
    let representatives = groups
        .iter()
        .map(|group| group.representative.clone())
        .collect::<Vec<_>>();
    let outcomes: Vec<(CacheTarget, RunnerResult<ProcessedTarget>)> = stream::iter(representatives)
        .map(|target| {
            let http = http.clone();
            async move {
                let res = process_one(&target, &http, home).await;
                (target, res)
            }
        })
        .buffer_unordered(CONCURRENCY)
        .collect()
        .await;

    let mut resolved = HashMap::new();
    let mut staged = Vec::new();
    let mut staged_by_guest_path = HashSet::new();
    for (target, processed) in outcomes {
        let processed = processed?;
        if let Some(stage) = processed.outcome.stage()
            && staged_by_guest_path.insert(stage.guest_path.clone())
        {
            staged.push(stage.clone());
        }
        resolved.insert(cache_key(&target.name, &target.version), processed);
    }

    let LockedStageArchives {
        stages: locked_stages,
        skipped: skipped_stages,
        guards: stage_guards,
    } = lock_stage_archives(staged, home).await?;
    for skipped in skipped_stages {
        let key = cache_key(&skipped.name, &skipped.version);
        let processed = resolved.get_mut(&key).ok_or_else(|| {
            RunnerError::Internal(format!(
                "storage cache missing skipped stage outcome for {}@{}",
                skipped.name, skipped.version
            ))
        })?;
        processed.outcome = TargetOutcome::SkippedStageUnavailable {
            reason: skipped.reason,
        };
    }

    if !locked_stages.is_empty() {
        let requests = locked_stages
            .iter()
            .map(|stage| WriteFileRequest {
                path: stage.guest_path.as_str(),
                source: WriteFileSource::File {
                    path: &stage.archive_path,
                    len: stage.len,
                },
            })
            .collect::<Vec<_>>();
        let started = Instant::now();
        let result = async {
            prepare_guest_stage_dir(sandbox).await?;
            sandbox.write_files(&requests).await?;
            Ok::<(), RunnerError>(())
        }
        .await;
        let error = result.as_ref().err().map(ToString::to_string);
        telemetry.record(
            "storage_cache_guest_stage",
            started.elapsed(),
            result.is_ok(),
            error.as_deref(),
        );
        result?;
    }
    drop(stage_guards);

    for group in groups {
        let key = cache_key(&group.representative.name, &group.representative.version);
        let processed = resolved.get(&key).ok_or_else(|| {
            RunnerError::Internal(format!(
                "storage cache missing outcome for {}@{}",
                group.representative.name, group.representative.version
            ))
        })?;
        for target in &group.members {
            apply_outcome(manifest, target, &processed.outcome, telemetry);
        }
    }
    Ok(())
}

async fn prepare_guest_stage_dir(sandbox: &dyn Sandbox) -> RunnerResult<()> {
    let cmd = format!("rm -rf -- {GUEST_STAGE_DIR} && mkdir -p -- {GUEST_STAGE_DIR}");
    let result = sandbox
        .bounded_exec(&BoundedExecRequest {
            cmd: &cmd,
            timeout: Duration::from_secs(10),
            env: &[],
            sudo: false,
            stdin: None,
            stdout: capture_bounded_output(4 * 1024),
            stderr: capture_bounded_output(16 * 1024),
        })
        .await?;

    match result.termination {
        BoundedExecTermination::Exited { exit_code: 0 } => Ok(()),
        BoundedExecTermination::Exited { exit_code } => Err(RunnerError::Internal(format!(
            "prepare guest storage cache stage dir failed: exit_code={exit_code} stderr={}",
            bounded_output_preview(&result.stderr)
        ))),
        termination => Err(RunnerError::Internal(format!(
            "prepare guest storage cache stage dir failed: termination={termination:?} stderr={}",
            bounded_output_preview(&result.stderr)
        ))),
    }
}

fn capture_bounded_output(limit_bytes: u32) -> BoundedExecOutputRequest {
    BoundedExecOutputRequest {
        capture: BoundedExecCapturePolicy::Capture { limit_bytes },
        stream: None,
    }
}

fn bounded_output_preview(output: &BoundedExecOutput) -> String {
    match output {
        BoundedExecOutput::Discarded => String::new(),
        BoundedExecOutput::Captured { bytes, truncated } => {
            let text = String::from_utf8_lossy(bytes).trim().to_string();
            if *truncated && text.is_empty() {
                "[truncated]".to_string()
            } else if *truncated {
                format!("{text} [truncated]")
            } else {
                text
            }
        }
    }
}

fn collect_targets(manifest: &GuestDownloadManifest) -> Vec<CacheTarget> {
    let mut out = Vec::new();
    for (i, s) in manifest.storages.iter().enumerate() {
        if s.cached {
            continue;
        }
        let Some(url) = s.archive_url.as_deref() else {
            continue;
        };
        let name = s.vas_storage_name.as_str();
        let version = s.vas_version_id.as_str();
        // Empty components would hash to the same fixed digest as every
        // other empty component, collapsing distinct manifest entries into
        // a shared cache slot. Treat them like missing keys: passthrough.
        if name.is_empty() || version.is_empty() {
            continue;
        }
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
        // `ArtifactEntry` keys are non-optional `String`, so an empty value
        // is representable and must be skipped for the same reason as the
        // storage branch above.
        if a.vas_storage_name.is_empty() || a.vas_version_id.is_empty() {
            continue;
        }
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

fn cache_key(name: &str, version: &str) -> (String, String) {
    (name.to_string(), version.to_string())
}

fn group_targets(targets: Vec<CacheTarget>) -> Vec<TargetGroup> {
    let mut groups = Vec::<TargetGroup>::new();
    let mut by_key = HashMap::<(String, String), usize>::new();

    for target in targets {
        let key = cache_key(&target.name, &target.version);
        if let Some(group) = by_key.get(&key).and_then(|index| groups.get_mut(*index)) {
            group.members.push(target);
            continue;
        }
        let index = groups.len();
        by_key.insert(key, index);
        groups.push(TargetGroup {
            representative: target.clone(),
            members: vec![target],
        });
    }

    groups
}

async fn process_one(
    target: &CacheTarget,
    http: &Client,
    home: &HomePaths,
) -> RunnerResult<ProcessedTarget> {
    // Acquire the per-version flock (blocking, cross-process dedup).
    // Disk-check happens under the lock so we never race with a writer.
    let lock_path = home.storage_lock(&target.name, &target.version);
    let _guard = lock::acquire(lock_path).await?;

    let cache_dir = home.storage_cache_dir(&target.name, &target.version);
    let archive_path = cache_dir.join("archive.tar.gz");

    // 1. Fast path: disk hit. Stage the local archive path and skip the
    //    network, so hits stay resilient to transient probe failures.
    match fs::metadata(&archive_path).await {
        Ok(metadata) if metadata.len() <= CACHE_MAX_SIZE => {
            touch_mtime(&cache_dir);
            return Ok(ProcessedTarget {
                outcome: TargetOutcome::Hit {
                    stage: StageArchive {
                        name: target.name.clone(),
                        version: target.version.clone(),
                        guest_path: guest_archive_path(&target.name, &target.version),
                        archive_path,
                        len: metadata.len(),
                    },
                },
            });
        }
        Ok(metadata) => {
            evict_oversized_cache(target, &cache_dir, metadata.len()).await?;
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "stat cached {}: {e}",
                archive_path.display()
            )));
        }
    }

    // 2. Miss path: probe size via `GET` + `Range: bytes=0-0`. A probe
    //    failure is treated as passthrough — the entry keeps its original
    //    R2 URL and the guest downloads it as today. The failure reason is
    //    threaded into the outcome so telemetry can distinguish transient
    //    5xx from missing / malformed size headers.
    let size = match probe_size(http, &target.archive_url).await {
        Ok(Some(n)) => n,
        Ok(None) => {
            warn!(
                name = %target.name,
                version = %target.version,
                "storage_cache: probe returned no size header, passthrough"
            );
            return Ok(ProcessedTarget {
                outcome: TargetOutcome::SkippedHeadFailed {
                    reason: "missing-size-header".to_string(),
                },
            });
        }
        Err(e) => {
            let reason = e.to_string();
            warn!(
                name = %target.name,
                version = %target.version,
                error = %reason,
                "storage_cache: probe failed, passthrough"
            );
            return Ok(ProcessedTarget {
                outcome: TargetOutcome::SkippedHeadFailed { reason },
            });
        }
    };
    if size > CACHE_MAX_SIZE {
        debug!(
            name = %target.name,
            version = %target.version,
            size,
            "storage_cache: entry over size limit, passthrough"
        );
        return Ok(ProcessedTarget {
            outcome: TargetOutcome::SkippedOverSize,
        });
    }

    // 3. Download, stage, fsync, and atomic rename. Guest staging happens
    //    later in one write_files batch, after every cacheable target has a
    //    durable local archive.
    let t = Instant::now();
    let bytes = match download_tarball(http, &target.archive_url, CACHE_MAX_SIZE).await? {
        DownloadBody::Complete(bytes) => bytes,
        DownloadBody::OverSize { observed_size } => {
            warn!(
                name = %target.name,
                version = %target.version,
                probe_size = size,
                observed_size,
                limit = CACHE_MAX_SIZE,
                "storage_cache: full download exceeded probed size limit, failing closed"
            );
            return Err(RunnerError::Internal(format!(
                "storage cache download size mismatch for {}@{}: probe reported {size} bytes within {CACHE_MAX_SIZE} byte limit, but full GET reached {observed_size} bytes",
                target.name, target.version
            )));
        }
    };
    let len = bytes.len() as u64;
    write_to_cache(&cache_dir, &bytes).await?;

    Ok(ProcessedTarget {
        outcome: TargetOutcome::Miss {
            download_duration: t.elapsed(),
            stage: StageArchive {
                name: target.name.clone(),
                version: target.version.clone(),
                guest_path: guest_archive_path(&target.name, &target.version),
                archive_path,
                len,
            },
        },
    })
}

async fn lock_stage_archives(
    mut stages: Vec<StageArchive>,
    home: &HomePaths,
) -> RunnerResult<LockedStageArchives> {
    sort_stage_archives(&mut stages);

    let mut locked_stages = Vec::with_capacity(stages.len());
    let mut skipped = Vec::new();
    let mut guards = Vec::with_capacity(stages.len());
    for stage in stages {
        let guard = lock::acquire_shared(home.storage_lock(&stage.name, &stage.version)).await?;
        match validate_stage_archive(&stage).await {
            Ok(()) => {
                guards.push(guard);
                locked_stages.push(stage);
            }
            Err(reason) => {
                warn!(
                    name = %stage.name,
                    version = %stage.version,
                    reason = %reason,
                    "storage_cache: staged archive unavailable, passthrough"
                );
                skipped.push(SkippedStageArchive {
                    name: stage.name,
                    version: stage.version,
                    reason,
                });
            }
        }
    }

    Ok(LockedStageArchives {
        stages: locked_stages,
        skipped,
        guards,
    })
}

fn sort_stage_archives(stages: &mut [StageArchive]) {
    stages.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| a.version.cmp(&b.version))
            .then_with(|| a.guest_path.cmp(&b.guest_path))
    });
}

async fn validate_stage_archive(stage: &StageArchive) -> Result<(), String> {
    let metadata = fs::metadata(&stage.archive_path)
        .await
        .map_err(|e| format!("stat {}: {e}", stage.archive_path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a file", stage.archive_path.display()));
    }
    if metadata.len() != stage.len {
        return Err(format!(
            "size changed from {} to {} bytes",
            stage.len,
            metadata.len()
        ));
    }
    Ok(())
}

async fn probe_size(http: &Client, url: &str) -> RunnerResult<Option<u64>> {
    use reqwest::{StatusCode, header};
    let resp = http
        .get(url)
        .header(header::RANGE, "bytes=0-0")
        .timeout(HEAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| RunnerError::Internal(format!("probe GET: {}", reqwest_error(e))))?;

    let status = resp.status();
    if status == StatusCode::PARTIAL_CONTENT {
        // 206: parse total from `Content-Range: bytes 0-0/<total>`.
        let total = resp
            .headers()
            .get(header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_content_range_total);
        // Do not drain the body here. Some origins ignore Range while still
        // returning large bodies, and probe safety matters more than reusing
        // this connection.
        return Ok(total);
    }
    if status.is_success() {
        // 200: server ignored Range. Fall back to Content-Length.
        let total = resp
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok());
        // Drop the response after headers instead of buffering an ignored
        // Range response into memory.
        return Ok(total);
    }
    // 4xx / 5xx / 416 / anything else — treat as probe failure.
    let err = resp
        .error_for_status()
        .err()
        .map(reqwest_error)
        .unwrap_or_else(|| format!("unexpected status {status}"));
    Err(RunnerError::Internal(format!("probe GET: {err}")))
}

fn reqwest_error(e: reqwest::Error) -> String {
    e.without_url().to_string()
}

/// Parse the total size out of a `Content-Range` header value such as
/// `bytes 0-0/12345`. Returns `None` for `bytes 0-0/*` (server declines to
/// disclose the total) or any malformed value.
fn parse_content_range_total(value: &str) -> Option<u64> {
    let (_, total) = value.rsplit_once('/')?;
    if total == "*" {
        return None;
    }
    total.trim().parse::<u64>().ok()
}

async fn download_tarball(http: &Client, url: &str, max_size: u64) -> RunnerResult<DownloadBody> {
    let mut resp = http
        .get(url)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| RunnerError::Internal(format!("GET: {}", reqwest_error(e))))?
        .error_for_status()
        .map_err(|e| RunnerError::Internal(format!("GET status: {}", reqwest_error(e))))?;

    if let Some(content_length) = resp.content_length()
        && content_length > max_size
    {
        return Ok(DownloadBody::OverSize {
            observed_size: content_length,
        });
    }

    let mut bytes = Vec::with_capacity(max_size.min(64 * 1024) as usize);
    let mut downloaded = 0u64;

    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| RunnerError::Internal(format!("read body: {}", reqwest_error(e))))?
    {
        if let Some(observed_size) =
            append_limited_chunk(&mut bytes, &mut downloaded, &chunk, max_size)?
        {
            return Ok(DownloadBody::OverSize { observed_size });
        }
    }

    Ok(DownloadBody::Complete(Bytes::from(bytes)))
}

fn append_limited_chunk(
    bytes: &mut Vec<u8>,
    downloaded: &mut u64,
    chunk: &[u8],
    max_size: u64,
) -> RunnerResult<Option<u64>> {
    let chunk_len = u64::try_from(chunk.len())
        .map_err(|_| RunnerError::Internal("body chunk length overflow".to_string()))?;
    let Some(next_downloaded) = downloaded.checked_add(chunk_len) else {
        return Ok(Some(u64::MAX));
    };
    if next_downloaded > max_size {
        return Ok(Some(next_downloaded));
    }
    bytes.extend_from_slice(chunk);
    *downloaded = next_downloaded;
    Ok(None)
}

async fn evict_oversized_cache(
    target: &CacheTarget,
    cache_dir: &Path,
    observed_size: u64,
) -> RunnerResult<()> {
    warn!(
        name = %target.name,
        version = %target.version,
        size = observed_size,
        limit = CACHE_MAX_SIZE,
        "storage_cache: cached archive exceeds size limit, evicting"
    );
    if let Err(e) = fs::remove_dir_all(cache_dir).await
        && e.kind() != io::ErrorKind::NotFound
    {
        return Err(RunnerError::Internal(format!(
            "remove oversized cache {}: {e}",
            cache_dir.display()
        )));
    }
    Ok(())
}

async fn write_to_cache(cache_dir: &Path, bytes: &[u8]) -> RunnerResult<()> {
    let staging = staging_dir(cache_dir);

    // Best-effort cleanup of stale staging from a prior crashed run.
    let _ = fs::remove_dir_all(&staging).await;
    fs::create_dir_all(&staging)
        .await
        .map_err(|e| RunnerError::Internal(format!("create staging {}: {e}", staging.display())))?;

    let archive_staging = staging.join("archive.tar.gz");
    if let Err(e) = fs::write(&archive_staging, bytes).await {
        let _ = fs::remove_dir_all(&staging).await;
        return Err(RunnerError::Internal(format!(
            "write {}: {e}",
            archive_staging.display()
        )));
    }

    // fsync the archive so a crash between rename and next sync cannot
    // leave a zero-byte or torn file visible at the final path.
    let f = match fs::File::open(&archive_staging).await {
        Ok(f) => f,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging).await;
            return Err(RunnerError::Internal(format!(
                "open for fsync {}: {e}",
                archive_staging.display()
            )));
        }
    };
    if let Err(e) = f.sync_all().await {
        drop(f);
        let _ = fs::remove_dir_all(&staging).await;
        return Err(RunnerError::Internal(format!(
            "fsync {}: {e}",
            archive_staging.display()
        )));
    }
    drop(f);

    // Ensure the `<name>/` parent exists so the rename below has a target.
    if let Some(parent) = cache_dir.parent()
        && let Err(e) = fs::create_dir_all(parent).await
    {
        let _ = fs::remove_dir_all(&staging).await;
        return Err(RunnerError::Internal(format!(
            "create cache parent {}: {e}",
            parent.display()
        )));
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
        // Non-race error: clean up the staging dir ourselves so EXDEV /
        // ENOSPC / EACCES leftovers don't accumulate between retries. The
        // cleanup is best-effort — we still surface the original error.
        let _ = fs::remove_dir_all(&staging).await;
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
    manifest: &mut GuestDownloadManifest,
    target: &CacheTarget,
    outcome: &TargetOutcome,
    telemetry: &mut JobTelemetry,
) {
    match outcome {
        TargetOutcome::Hit { .. } => {
            rewrite_url(manifest, target);
            telemetry.record("storage_cache_hit", Duration::ZERO, true, None);
        }
        TargetOutcome::Miss {
            download_duration, ..
        } => {
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
        TargetOutcome::SkippedStageUnavailable { reason } => {
            telemetry.record(
                "storage_cache_skipped_stage_unavailable",
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
fn rewrite_url(manifest: &mut GuestDownloadManifest, target: &CacheTarget) {
    let new_url = format!(
        "file://{}",
        guest_archive_path(&target.name, &target.version)
    );
    let mut applied = false;
    match target.kind {
        TargetKind::Storage => {
            if let Some(entry) = manifest.storages.get_mut(target.index)
                && entry.vas_storage_name == target.name
                && entry.vas_version_id == target.version
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
    use sandbox::{SandboxError, SandboxOperation, SandboxOperationReason};
    use sandbox_mock::{BoundedExecResponse, MockSandbox, WriteFilesCallSource};
    use tokio::io::AsyncWriteExt as _;
    use tokio::net::TcpListener;

    use crate::http::HttpClient;
    use crate::ids::RunId;
    use crate::types::{
        GuestDownloadArtifactEntry, GuestDownloadManifest, GuestDownloadStorageEntry,
    };

    fn new_telemetry() -> JobTelemetry {
        let http = HttpClient::new("http://localhost:0".to_string()).unwrap();
        JobTelemetry::new(http, RunId::nil(), "test-token".to_string())
    }

    fn home_at(temp: &tempfile::TempDir) -> HomePaths {
        HomePaths::with_root(temp.path().to_path_buf())
    }

    fn manifest_single_storage(url: String, name: &str, version: &str) -> GuestDownloadManifest {
        GuestDownloadManifest {
            storages: vec![GuestDownloadStorageEntry {
                mount_path: format!("/mnt/{name}"),
                archive_url: Some(url),
                cached: false,
                instructions_target_filename: None,
                vas_storage_name: name.to_string(),
                vas_version_id: version.to_string(),
            }],
            artifacts: Vec::new(),
            cleanup_paths: Vec::new(),
        }
    }

    fn tarball_bytes() -> Vec<u8> {
        // A small payload is enough — the cache treats it as opaque bytes.
        b"pretend-tar-gz-bytes".to_vec()
    }

    fn sandbox_write_files_error(message: impl Into<String>) -> SandboxError {
        SandboxError::Operation {
            operation: SandboxOperation::WriteFiles,
            reason: SandboxOperationReason::Guest,
            message: message.into(),
        }
    }

    fn assert_single_stage_file(
        sandbox: &MockSandbox,
        guest_path: &str,
        archive_path: &Path,
        len: u64,
    ) {
        let calls = sandbox.write_files_calls();
        assert_eq!(calls.len(), 1, "expected one write_files call: {calls:?}");
        assert_eq!(calls[0].files.len(), 1, "expected one staged file");
        assert_eq!(calls[0].files[0].path, guest_path);
        assert_eq!(
            calls[0].files[0].source,
            WriteFilesCallSource::File {
                path: archive_path.to_path_buf(),
                len,
            }
        );
    }

    async fn raw_http_url(
        response: Vec<u8>,
    ) -> (String, tokio::task::JoinHandle<std::io::Result<()>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await?;
            let mut request = [0u8; 1024];
            let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut request).await?;
            socket.write_all(&response).await?;
            Ok(())
        });
        (format!("http://{addr}/archive.tar.gz"), handle)
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
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        let ops = telemetry.pending_ops_snapshot();
        assert!(
            ops.iter().any(|(k, _, _)| k == "storage_cache_hit"),
            "expected storage_cache_hit in {ops:?}"
        );
        assert!(
            ops.iter().any(|(k, _, _)| k == "storage_cache_guest_stage"),
            "expected storage_cache_guest_stage in {ops:?}"
        );
        assert_single_stage_file(
            &sandbox,
            &guest_archive_path(name, version),
            &cache_dir.join("archive.tar.gz"),
            tarball_bytes().len() as u64,
        );
    }

    #[tokio::test]
    async fn guest_stage_failure_records_failed_telemetry() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        sandbox.push_write_files_result(Err(sandbox_write_files_error("stage failed")));
        let mut telemetry = new_telemetry();

        let name = "stage-failure";
        let version = "v1";
        let cache_dir = home.storage_cache_dir(name, version);
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::write(cache_dir.join("archive.tar.gz"), tarball_bytes()).unwrap();

        let original = "https://r2.example.com/stage-failure.tar.gz".to_string();
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        let err = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap_err();

        assert!(err.to_string().contains("stage failed"), "got: {err}");
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(original.as_str())
        );
        let ops = telemetry.pending_ops_snapshot();
        let (_, success, error) = ops
            .iter()
            .find(|(k, _, _)| k == "storage_cache_guest_stage")
            .expect("expected failed guest stage telemetry");
        assert!(!success);
        assert!(
            error
                .as_deref()
                .is_some_and(|error| error.contains("stage failed")),
            "expected stage failure reason in {ops:?}"
        );
    }

    #[tokio::test]
    async fn guest_stage_prepare_failure_records_failed_telemetry_and_skips_write_files() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        sandbox.push_bounded_exec_response(BoundedExecResponse {
            events: Vec::new(),
            result: Ok(sandbox::BoundedExecResult {
                termination: sandbox::BoundedExecTermination::Exited { exit_code: 1 },
                duration: Duration::ZERO,
                stdout: sandbox::BoundedExecOutput::Captured {
                    bytes: Vec::new(),
                    truncated: false,
                },
                stderr: sandbox::BoundedExecOutput::Captured {
                    bytes: b"rm failed".to_vec(),
                    truncated: false,
                },
                diagnostic: None,
            }),
        });
        let mut telemetry = new_telemetry();

        let name = "stage-prepare-failure";
        let version = "v1";
        let cache_dir = home.storage_cache_dir(name, version);
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::write(cache_dir.join("archive.tar.gz"), tarball_bytes()).unwrap();

        let original = "https://r2.example.com/stage-prepare-failure.tar.gz".to_string();
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        let err = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap_err();

        assert!(
            err.to_string()
                .contains("prepare guest storage cache stage dir failed"),
            "got: {err}"
        );
        assert!(err.to_string().contains("rm failed"), "got: {err}");
        assert!(sandbox.write_files_calls().is_empty());
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(original.as_str())
        );
        let ops = telemetry.pending_ops_snapshot();
        let (_, success, error) = ops
            .iter()
            .find(|(k, _, _)| k == "storage_cache_guest_stage")
            .expect("expected failed guest stage telemetry");
        assert!(!success);
        assert!(
            error
                .as_deref()
                .is_some_and(|error| error.contains("rm failed")),
            "expected stage prepare failure reason in {ops:?}"
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

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/archive.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/archive.tar.gz")
                    .header_missing("range");
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

        probe.assert_async().await;
        get.assert_async().await;

        let final_path = home.storage_cache_dir(name, version).join("archive.tar.gz");
        assert!(final_path.exists(), "cache file must exist after miss");
        assert_eq!(std::fs::read(&final_path).unwrap(), body);

        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );

        let ops = telemetry.pending_ops_snapshot();
        assert!(ops.iter().any(|(k, _, _)| k == "storage_cache_miss"));
        assert!(ops.iter().any(|(k, _, _)| k == "storage_cache_download"));
        assert!(ops.iter().any(|(k, _, _)| k == "storage_cache_guest_stage"));
        assert_single_stage_file(
            &sandbox,
            &guest_archive_path(name, version),
            &final_path,
            body.len() as u64,
        );
    }

    #[tokio::test]
    async fn over_size_entry_is_passthrough() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;

        let too_big = CACHE_MAX_SIZE + 1;
        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/big.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{too_big}"))
                    .body(b"x");
            })
            .await;
        // Full GET must NOT be called for passthrough — no mock registered.

        let original = server.url("/big.tar.gz");
        let name = "user-volume";
        let version = "v9";
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        probe.assert_async().await;

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
    async fn skipped_outcome_does_not_keep_cache_lock() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let http = Client::builder().build().unwrap();
        let server = MockServer::start_async().await;

        let too_big = CACHE_MAX_SIZE + 1;
        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/big.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{too_big}"))
                    .body(b"x");
            })
            .await;

        let target = CacheTarget {
            kind: TargetKind::Storage,
            index: 0,
            name: "user-volume".to_string(),
            version: "v9".to_string(),
            archive_url: server.url("/big.tar.gz"),
        };

        let processed = process_one(&target, &http, &home).await.unwrap();

        probe.assert_async().await;
        assert!(matches!(processed.outcome, TargetOutcome::SkippedOverSize));
        let _lock = lock::try_acquire(home.storage_lock("user-volume", "v9"))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn hit_outcome_does_not_keep_cache_lock() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let http = Client::builder().build().unwrap();

        let name = "cached-hit";
        let version = "v1";
        let cache_dir = home.storage_cache_dir(name, version);
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::write(cache_dir.join("archive.tar.gz"), tarball_bytes()).unwrap();

        let target = CacheTarget {
            kind: TargetKind::Storage,
            index: 0,
            name: name.to_string(),
            version: version.to_string(),
            archive_url: "https://r2.example.com/ignored.tar.gz".to_string(),
        };

        let processed = process_one(&target, &http, &home).await.unwrap();

        assert!(matches!(processed.outcome, TargetOutcome::Hit { .. }));
        let _lock = lock::try_acquire(home.storage_lock(name, version))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn full_download_over_probe_limit_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        sandbox.push_write_files_result(Err(sandbox_write_files_error("unexpected archive write")));
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/lying-body.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{CACHE_MAX_SIZE}"))
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/lying-body.tar.gz")
                    .header_missing("range");
                then.status(200)
                    .body(vec![b'x'; (CACHE_MAX_SIZE + 1) as usize]);
            })
            .await;

        let original = server.url("/lying-body.tar.gz");
        let name = "lying-body";
        let version = "v1";
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        let err = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap_err();

        probe.assert_async().await;
        get.assert_async().await;
        assert!(
            err.to_string().contains("download size mismatch"),
            "got: {err}"
        );
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(original.as_str())
        );
        assert!(
            !home
                .storage_cache_dir(name, version)
                .join("archive.tar.gz")
                .exists()
        );
        assert!(
            !telemetry
                .pending_ops_snapshot()
                .iter()
                .any(|(k, _, _)| k == "storage_cache_miss")
        );
        let sentinel = [WriteFileRequest {
            path: "/tmp/sentinel",
            source: WriteFileSource::Bytes(b"x"),
        }];
        assert!(
            sandbox.write_files(&sentinel).await.is_err(),
            "queued write_files error should remain if archive write was not attempted"
        );
    }

    #[tokio::test]
    async fn cached_true_entry_is_not_touched() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        // Entry the filter has already marked reuse-in-place: archive_url = None, cached = true.
        let mut manifest = GuestDownloadManifest {
            storages: vec![GuestDownloadStorageEntry {
                mount_path: "/mnt/foo".into(),
                archive_url: None,
                cached: true,
                instructions_target_filename: None,
                vas_storage_name: "foo".into(),
                vas_version_id: "v1".into(),
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

        // Entry without usable vas_storage_name / vas_version_id passes through.
        let mut manifest = GuestDownloadManifest {
            storages: vec![GuestDownloadStorageEntry {
                mount_path: "/mnt/legacy".into(),
                archive_url: Some("https://r2.example.com/legacy.tar.gz".into()),
                cached: false,
                instructions_target_filename: None,
                vas_storage_name: String::new(),
                vas_version_id: String::new(),
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
            Some(format!("file://{}", guest_archive_path(name, "v2")).as_str())
        );
        // v2 cache retained; v1 cache untouched (only a GC branch would evict it).
        assert!(v2_dir.join("archive.tar.gz").exists());
        assert!(v1_dir.join("archive.tar.gz").exists());
    }

    #[tokio::test]
    async fn oversized_disk_hit_is_evicted_and_revalidated() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let name = "oversized-hit";
        let version = "v1";
        let cache_dir = home.storage_cache_dir(name, version);
        std::fs::create_dir_all(&cache_dir).unwrap();
        let archive = std::fs::File::create(cache_dir.join("archive.tar.gz")).unwrap();
        archive.set_len(CACHE_MAX_SIZE + 1).unwrap();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/revalidated.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/revalidated.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let url = server.url("/revalidated.tar.gz");
        let mut manifest = manifest_single_storage(url, name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        probe.assert_async().await;
        get.assert_async().await;
        assert_eq!(
            std::fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz")).unwrap(),
            body
        );
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        let ops = telemetry.pending_ops_snapshot();
        assert!(
            ops.iter().any(|(k, _, _)| k == "storage_cache_miss"),
            "expected revalidation miss in {ops:?}"
        );
        assert!(
            !ops.iter().any(|(k, _, _)| k == "storage_cache_hit"),
            "oversized cache file must not be treated as a hit: {ops:?}"
        );
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

        let mut manifest = GuestDownloadManifest {
            storages: Vec::new(),
            artifacts: vec![GuestDownloadArtifactEntry {
                mount_path: "/mnt/artifact".into(),
                archive_url: Some("https://r2.example.com/ignored.tar.gz".into()),
                cached: false,
                vas_storage_name: name.to_string(),
                vas_storage_id: String::new(),
                vas_version_id: version.to_string(),
            }],
            cleanup_paths: Vec::new(),
        };

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        assert_eq!(
            manifest.artifacts[0].archive_url.as_deref(),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
    }

    #[tokio::test]
    async fn duplicate_cache_key_is_staged_once_for_storage_and_artifact() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        let name = "shared-cache-key";
        let version = "same-version";
        let body = tarball_bytes();
        let cache_dir = home.storage_cache_dir(name, version);
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::write(cache_dir.join("archive.tar.gz"), &body).unwrap();

        let mut manifest = GuestDownloadManifest {
            storages: vec![GuestDownloadStorageEntry {
                mount_path: "/mnt/storage".into(),
                archive_url: Some("https://r2.example.com/storage.tar.gz".into()),
                cached: false,
                instructions_target_filename: None,
                vas_storage_name: name.to_string(),
                vas_version_id: version.to_string(),
            }],
            artifacts: vec![GuestDownloadArtifactEntry {
                mount_path: "/mnt/artifact".into(),
                archive_url: Some("https://r2.example.com/artifact.tar.gz".into()),
                cached: false,
                vas_storage_name: name.to_string(),
                vas_storage_id: String::new(),
                vas_version_id: version.to_string(),
            }],
            cleanup_paths: Vec::new(),
        };

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        let expected = format!("file://{}", guest_archive_path(name, version));
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(expected.as_str())
        );
        assert_eq!(
            manifest.artifacts[0].archive_url.as_deref(),
            Some(expected.as_str())
        );
        assert_single_stage_file(
            &sandbox,
            &guest_archive_path(name, version),
            &cache_dir.join("archive.tar.gz"),
            body.len() as u64,
        );
    }

    #[tokio::test]
    async fn probe_failure_is_passthrough() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/broken.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(500);
            })
            .await;

        let original = format!(
            "{}?X-Amz-Signature=secret&X-Amz-Credential=credential",
            server.url("/broken.tar.gz")
        );
        let mut manifest = manifest_single_storage(original.clone(), "broken-skill", "v1");

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        probe.assert_async().await;

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
        let (_, _, error) = ops
            .iter()
            .find(|(k, _, _)| k == "storage_cache_skipped_head_failed")
            .expect("expected skipped head telemetry");
        let error = error.as_deref().expect("expected telemetry error reason");
        assert!(
            !error.contains("X-Amz-Signature")
                && !error.contains("secret")
                && !error.contains("credential")
                && !error.contains("/broken.tar.gz"),
            "telemetry error must not include presigned URL details: {error}"
        );
    }

    #[tokio::test]
    async fn probe_200_ignored_range_uses_content_length_without_reading_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let advertised_size = CACHE_MAX_SIZE + 1;

        let server_task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await?;
            let mut request = [0u8; 1024];
            let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut request).await?;
            socket
                .write_all(
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {advertised_size}\r\n\r\n")
                        .as_bytes(),
                )
                .await?;
            let _ = release_rx.await;
            Ok::<(), std::io::Error>(())
        });

        let http = Client::builder().build().unwrap();
        let result = tokio::time::timeout(
            HEAD_TIMEOUT + Duration::from_secs(1),
            probe_size(&http, &format!("http://{addr}/range-ignored.tar.gz")),
        )
        .await
        .expect("probe must return after headers without waiting for the body")
        .unwrap();

        let _ = release_tx.send(());
        server_task.await.unwrap().unwrap();
        assert_eq!(result, Some(advertised_size));
    }

    #[tokio::test]
    async fn probe_206_uses_content_range_without_reading_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let total_size = CACHE_MAX_SIZE;

        let server_task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await?;
            let mut request = [0u8; 1024];
            let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut request).await?;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{total_size}\r\nContent-Length: {}\r\n\r\n",
                        CACHE_MAX_SIZE + 1
                    )
                    .as_bytes(),
                )
                .await?;
            let _ = release_rx.await;
            Ok::<(), std::io::Error>(())
        });

        let http = Client::builder().build().unwrap();
        let result = tokio::time::timeout(
            HEAD_TIMEOUT + Duration::from_secs(1),
            probe_size(&http, &format!("http://{addr}/partial.tar.gz")),
        )
        .await
        .expect("probe must return after Content-Range without waiting for the body")
        .unwrap();

        let _ = release_tx.send(());
        server_task.await.unwrap().unwrap();
        assert_eq!(result, Some(total_size));
    }

    #[test]
    fn staging_dir_is_sibling() {
        let d = PathBuf::from("/var/lib/vm0-runner/storages/foo/v1");
        let s = staging_dir(&d);
        assert_eq!(s, PathBuf::from("/var/lib/vm0-runner/storages/foo/v1.tmp"));
        // Same parent → atomic rename.
        assert_eq!(s.parent(), d.parent());
    }

    #[tokio::test]
    async fn write_to_cache_rename_error_cleans_staging() {
        let temp = tempfile::tempdir().unwrap();
        let cache_dir = temp.path().join("storages").join("name").join("version");
        let parent = cache_dir.parent().unwrap();
        fs::create_dir_all(parent).await.unwrap();
        fs::write(&cache_dir, b"not-a-cache-dir").await.unwrap();

        let staging = staging_dir(&cache_dir);

        let err = write_to_cache(&cache_dir, b"archive bytes")
            .await
            .unwrap_err();

        assert!(err.to_string().contains("rename"), "got: {err}");
        assert!(
            !staging.exists(),
            "failed cache write must not leave staging dir"
        );
        assert_eq!(fs::read(&cache_dir).await.unwrap(), b"not-a-cache-dir");
    }

    #[test]
    fn limited_body_allows_exact_limit() {
        let mut bytes = Vec::new();
        let mut downloaded = 0u64;

        let first = append_limited_chunk(&mut bytes, &mut downloaded, b"abcd", 6).unwrap();
        let second = append_limited_chunk(&mut bytes, &mut downloaded, b"ef", 6).unwrap();

        assert_eq!(first, None);
        assert_eq!(second, None);
        assert_eq!(downloaded, 6);
        assert_eq!(bytes, b"abcdef");
    }

    #[test]
    fn limited_body_rejects_one_byte_over_limit() {
        let mut bytes = Vec::new();
        let mut downloaded = 0u64;

        let first = append_limited_chunk(&mut bytes, &mut downloaded, b"abcd", 6).unwrap();
        let second = append_limited_chunk(&mut bytes, &mut downloaded, b"efg", 6).unwrap();

        assert_eq!(first, None);
        assert_eq!(second, Some(7));
        assert_eq!(
            downloaded, 4,
            "over-limit chunk must not advance downloaded size"
        );
        assert_eq!(bytes, b"abcd", "over-limit chunk must not be appended");
    }

    #[tokio::test]
    async fn download_rejects_advertised_content_length_over_limit() {
        let server = MockServer::start_async().await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET).path("/too-long.tar.gz");
                then.status(200).body(vec![0u8; 7]);
            })
            .await;
        let http = Client::builder().build().unwrap();

        let result = download_tarball(&http, &server.url("/too-long.tar.gz"), 6)
            .await
            .unwrap();

        get.assert_async().await;
        match result {
            DownloadBody::Complete(bytes) => {
                panic!(
                    "content-length over limit should be rejected, read {} bytes",
                    bytes.len()
                )
            }
            DownloadBody::OverSize { observed_size } => assert_eq!(observed_size, 7),
        }
    }

    #[tokio::test]
    async fn download_rejects_stream_without_content_length_over_limit() {
        let (url, server_task) = raw_http_url(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\nabcd\r\n3\r\nefg\r\n0\r\n\r\n"
                .to_vec(),
        )
        .await;
        let http = Client::builder().build().unwrap();

        let result = download_tarball(&http, &url, 6).await.unwrap();
        server_task.await.unwrap().unwrap();

        match result {
            DownloadBody::Complete(bytes) => {
                panic!(
                    "stream over limit should be rejected, read {} bytes",
                    bytes.len()
                )
            }
            DownloadBody::OverSize { observed_size } => assert_eq!(observed_size, 7),
        }
    }

    #[test]
    fn stage_archives_sort_by_cache_key() {
        let mut stages = vec![
            StageArchive {
                name: "z-storage".to_string(),
                version: "v1".to_string(),
                guest_path: "/tmp/z.tar.gz".to_string(),
                archive_path: PathBuf::from("/cache/z/archive.tar.gz"),
                len: 1,
            },
            StageArchive {
                name: "a-storage".to_string(),
                version: "v1".to_string(),
                guest_path: "/tmp/a.tar.gz".to_string(),
                archive_path: PathBuf::from("/cache/a/archive.tar.gz"),
                len: 1,
            },
        ];

        sort_stage_archives(&mut stages);

        let names = stages
            .iter()
            .map(|stage| stage.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["a-storage", "z-storage"]);
    }

    #[tokio::test]
    async fn unavailable_stage_archive_is_skipped_before_guest_write() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let stage = StageArchive {
            name: "missing-stage".to_string(),
            version: "v1".to_string(),
            guest_path: guest_archive_path("missing-stage", "v1"),
            archive_path: temp.path().join("missing.tar.gz"),
            len: 1,
        };

        let locked = lock_stage_archives(vec![stage], &home).await.unwrap();

        assert!(locked.stages.is_empty());
        assert_eq!(locked.skipped.len(), 1);
        assert!(locked.skipped[0].reason.contains("stat"));
    }

    #[tokio::test]
    async fn changed_stage_archive_size_is_skipped_before_guest_write() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let archive_path = temp.path().join("changed.tar.gz");
        std::fs::write(&archive_path, b"longer-than-expected").unwrap();
        let stage = StageArchive {
            name: "changed-stage".to_string(),
            version: "v1".to_string(),
            guest_path: guest_archive_path("changed-stage", "v1"),
            archive_path,
            len: 1,
        };

        let locked = lock_stage_archives(vec![stage], &home).await.unwrap();

        assert!(locked.stages.is_empty());
        assert_eq!(locked.skipped.len(), 1);
        assert!(locked.skipped[0].reason.contains("size changed"));
    }

    #[tokio::test]
    async fn shared_version_distinct_names_get_distinct_guest_paths() {
        // Regression guard: two manifest entries that share `vasVersionId`
        // but differ in `vasStorageName` must resolve to distinct guest
        // `file://` URLs. Before the host/guest key symmetrization, both
        // entries collided on `{GUEST_STAGE_DIR}/{version}.tar.gz` and one
        // staged archive clobbered the other.
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        let version = "v1";
        let name_a = "storage-a";
        let name_b = "storage-b";
        for name in [name_a, name_b] {
            let cache_dir = home.storage_cache_dir(name, version);
            std::fs::create_dir_all(&cache_dir).unwrap();
            std::fs::write(cache_dir.join("archive.tar.gz"), tarball_bytes()).unwrap();
        }

        let mut manifest = GuestDownloadManifest {
            storages: vec![
                GuestDownloadStorageEntry {
                    mount_path: format!("/mnt/{name_a}"),
                    archive_url: Some("https://r2.example.com/ignored.tar.gz".into()),
                    cached: false,
                    instructions_target_filename: None,
                    vas_storage_name: name_a.to_string(),
                    vas_version_id: version.to_string(),
                },
                GuestDownloadStorageEntry {
                    mount_path: format!("/mnt/{name_b}"),
                    archive_url: Some("https://r2.example.com/ignored.tar.gz".into()),
                    cached: false,
                    instructions_target_filename: None,
                    vas_storage_name: name_b.to_string(),
                    vas_version_id: version.to_string(),
                },
            ],
            artifacts: Vec::new(),
            cleanup_paths: Vec::new(),
        };

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        let url_a = manifest.storages[0].archive_url.clone().unwrap();
        let url_b = manifest.storages[1].archive_url.clone().unwrap();
        assert_ne!(
            url_a, url_b,
            "same-version entries must get distinct guest URLs"
        );
        assert_eq!(
            url_a,
            format!("file://{}", guest_archive_path(name_a, version))
        );
        assert_eq!(
            url_b,
            format!("file://{}", guest_archive_path(name_b, version))
        );
    }

    #[tokio::test]
    async fn staged_archives_are_written_in_stable_lock_order() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        let version = "v1";
        for name in ["z-storage", "a-storage"] {
            let cache_dir = home.storage_cache_dir(name, version);
            std::fs::create_dir_all(&cache_dir).unwrap();
            std::fs::write(cache_dir.join("archive.tar.gz"), tarball_bytes()).unwrap();
        }

        let mut manifest = GuestDownloadManifest {
            storages: vec![
                GuestDownloadStorageEntry {
                    mount_path: "/mnt/z".into(),
                    archive_url: Some("https://r2.example.com/z.tar.gz".into()),
                    cached: false,
                    instructions_target_filename: None,
                    vas_storage_name: "z-storage".into(),
                    vas_version_id: version.into(),
                },
                GuestDownloadStorageEntry {
                    mount_path: "/mnt/a".into(),
                    archive_url: Some("https://r2.example.com/a.tar.gz".into()),
                    cached: false,
                    instructions_target_filename: None,
                    vas_storage_name: "a-storage".into(),
                    vas_version_id: version.into(),
                },
            ],
            artifacts: Vec::new(),
            cleanup_paths: Vec::new(),
        };

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        let calls = sandbox.write_files_calls();
        assert_eq!(calls.len(), 1, "expected one batched write_files call");
        let paths = calls[0]
            .files
            .iter()
            .map(|file| file.path.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            vec![
                guest_archive_path("a-storage", version),
                guest_archive_path("z-storage", version),
            ]
        );
    }

    #[tokio::test]
    async fn empty_key_components_are_passthrough() {
        // Defensive guard: an artifact carries non-optional `String` keys,
        // so an empty value is serde-representable. Hashing an empty string
        // yields a fixed digest that every other empty-key entry would
        // collide on, so we skip these rather than letting them share a
        // cache slot.
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        let original = "https://r2.example.com/nameless.tar.gz".to_string();
        let mut manifest = GuestDownloadManifest {
            storages: Vec::new(),
            artifacts: vec![GuestDownloadArtifactEntry {
                mount_path: "/mnt/nameless".into(),
                archive_url: Some(original.clone()),
                cached: false,
                vas_storage_name: String::new(),
                vas_storage_id: String::new(),
                vas_version_id: String::new(),
            }],
            cleanup_paths: Vec::new(),
        };

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        // archive_url untouched — the entry was skipped entirely.
        assert_eq!(
            manifest.artifacts[0].archive_url.as_deref(),
            Some(original.as_str())
        );
        assert!(telemetry.pending_ops_snapshot().is_empty());
    }

    #[tokio::test]
    async fn concurrent_populate_for_same_key_downloads_once() {
        // Two `populate_cache` invocations race for the same (name, version).
        // The per-version flock must serialize them, so exactly one issues a
        // GET to upstream and the second hits the just-warmed disk cache.
        // `buffer_unordered(CONCURRENCY)` inside `populate_cache` means both
        // tasks touch the flock acquire from separate spawn_blocking threads,
        // so the test exercises real cross-thread flock semantics.
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox_a = MockSandbox::new("test-a");
        let sandbox_b = MockSandbox::new("test-b");
        let mut telemetry_a = new_telemetry();
        let mut telemetry_b = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        // `hits(1..)` expectations are checked after the race — the second
        // caller must find the cache warm.
        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/concurrent.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/concurrent.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let url = server.url("/concurrent.tar.gz");
        let name = "race-skill";
        let version = "v1";
        let mut manifest_a = manifest_single_storage(url.clone(), name, version);
        let mut manifest_b = manifest_single_storage(url.clone(), name, version);

        let (res_a, res_b) = tokio::join!(
            populate_cache(&mut manifest_a, &sandbox_a, &home, &mut telemetry_a),
            populate_cache(&mut manifest_b, &sandbox_b, &home, &mut telemetry_b),
        );
        res_a.unwrap();
        res_b.unwrap();

        // Both manifests rewritten.
        let expected = format!("file://{}", guest_archive_path(name, version));
        assert_eq!(
            manifest_a.storages[0].archive_url.as_deref(),
            Some(expected.as_str())
        );
        assert_eq!(
            manifest_b.storages[0].archive_url.as_deref(),
            Some(expected.as_str())
        );

        // Exactly one full download — the second caller saw the
        // flock-serialized cache and took the hit path. The probe may
        // be issued 1-2 times depending on which task acquired the lock
        // first; the full GET must be exactly once.
        get.assert_calls_async(1).await;
        assert!(probe.calls_async().await >= 1);

        // One miss telemetry across both tasks; the other records a hit.
        let ops_a = telemetry_a.pending_ops_snapshot();
        let ops_b = telemetry_b.pending_ops_snapshot();
        let total_miss = ops_a
            .iter()
            .filter(|(k, _, _)| k == "storage_cache_miss")
            .count()
            + ops_b
                .iter()
                .filter(|(k, _, _)| k == "storage_cache_miss")
                .count();
        let total_hit = ops_a
            .iter()
            .filter(|(k, _, _)| k == "storage_cache_hit")
            .count()
            + ops_b
                .iter()
                .filter(|(k, _, _)| k == "storage_cache_hit")
                .count();
        assert_eq!(
            total_miss, 1,
            "exactly one miss across concurrent populates"
        );
        assert_eq!(total_hit, 1, "second populate must see the warmed cache");
    }

    #[tokio::test]
    async fn r2_style_head_rejected_probe_via_get_range_succeeds() {
        // Regression for #10842. R2 GET-presigned URLs 403 on HEAD (SigV4
        // binds the signature to the HTTP method). The probe must use
        // GET + Range: bytes=0-0 and parse Content-Range — never HEAD.
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let head_forbidden = server
            .mock_async(|when, then| {
                when.method(HEAD).path("/r2.tar.gz");
                then.status(403);
            })
            .await;
        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/r2.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let full = server
            .mock_async(|when, then| {
                when.method(GET).path("/r2.tar.gz").header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let url = server.url("/r2.tar.gz");
        let name = "r2-skill";
        let version = "v1";
        let mut manifest = manifest_single_storage(url, name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        head_forbidden.assert_calls_async(0).await;
        probe.assert_async().await;
        full.assert_async().await;

        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        let ops = telemetry.pending_ops_snapshot();
        assert!(
            ops.iter().any(|(k, _, _)| k == "storage_cache_miss"),
            "expected storage_cache_miss in {ops:?}"
        );
    }

    #[tokio::test]
    async fn probe_206_without_content_range_is_passthrough() {
        // Server returns 206 but omits Content-Range entirely. Probe can't
        // extract a total → Ok(None) → passthrough (SkippedHeadFailed).
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/nosize.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206).body(b"x");
            })
            .await;

        let original = server.url("/nosize.tar.gz");
        let mut manifest = manifest_single_storage(original.clone(), "nosize", "v1");

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        probe.assert_async().await;
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(original.as_str())
        );
        let ops = telemetry.pending_ops_snapshot();
        assert!(
            ops.iter()
                .any(|(k, _, _)| k == "storage_cache_skipped_head_failed"),
            "expected storage_cache_skipped_head_failed in {ops:?}"
        );
    }

    #[tokio::test]
    async fn probe_malformed_content_range_is_passthrough() {
        // 206 with a Content-Range value that can't be parsed into a total
        // must fall back to passthrough, not silently treat the archive as
        // zero-sized.
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/garbage.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", "bogus-no-slash")
                    .body(b"x");
            })
            .await;

        let original = server.url("/garbage.tar.gz");
        let mut manifest = manifest_single_storage(original.clone(), "garbage", "v1");

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        probe.assert_async().await;
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(original.as_str())
        );
        let ops = telemetry.pending_ops_snapshot();
        assert!(
            ops.iter()
                .any(|(k, _, _)| k == "storage_cache_skipped_head_failed"),
            "expected storage_cache_skipped_head_failed in {ops:?}"
        );
    }
}
