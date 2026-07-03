//! Runner-side content-addressed cache for small storage archives.
//!
//! Sits between `apply_storage_fingerprint_reuse` and `download_storages` in
//! `run_in_sandbox`. For each eligible manifest entry, checks a host-local
//! cache keyed by `(vasStorageName, vasVersionId)`. On hit, reads the cached
//! tarball from disk and pushes it into the guest via vsock; on miss,
//! downloads the archive from R2 into the cache first. Once guest staging
//! succeeds, the entry's `archive_url` is rewritten to
//! `file:///tmp/vm0-storage-cache/<hash(name)>-<hash(version)>.tar.gz`
//! so `guest-download` reads the guest-local staged archive instead of
//! re-fetching.
//! Keying on both name and version gives same-version entries with different
//! storage names separate collision-resistant staged filenames in normal
//! operation, so they do not clobber each other on the guest tmpfs.
//!
//! Entries above [`CACHE_MAX_SIZE`], entries without a content key, and
//! entries already marked `cached = true` (reuse-in-place from
//! `apply_storage_fingerprint_reuse`) pass through untouched.
//! If the probe says an entry is cache-eligible but the full response exceeds
//! [`CACHE_MAX_SIZE`], the cache fails closed instead of handing the same
//! inconsistent URL to the guest.
//!
//! Runtime contract: `file://` URLs produced here point to guest-local archives
//! staged under [`GUEST_STAGE_DIR`]. `guest-download` supports that scheme and
//! treats missing local archives as a broken staging contract.

use std::collections::{HashMap, hash_map::Entry};
use std::fmt;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use reqwest::Client;
use sandbox::{Sandbox, WriteFileEntry};
use tokio::fs;
use tokio::io::AsyncReadExt as _;
use tokio::task::JoinSet;
use tracing::{info, warn};

use crate::error::{RunnerError, RunnerResult};
use crate::lock;
use crate::paths::{HomePaths, short_digest, touch_mtime};
use crate::telemetry::JobTelemetry;
use crate::types::GuestDownloadManifest;

/// Archive sizes strictly larger than this are passthrough.
const CACHE_MAX_SIZE: u64 = 8 * 1024 * 1024;

/// Parallel (probe GET / full GET / flock / vsock) operations per `populate_cache` call.
const CONCURRENCY: usize = 4;

/// Maximum number of warm cache-hit archives staged in one guest batch write.
const GUEST_STAGE_BATCH_MAX_FILES: usize = 64;

/// Maximum total warm cache-hit bytes staged in one guest batch write.
const GUEST_STAGE_BATCH_MAX_BYTES: usize = 15 * 1024 * 1024;

/// Guest stage directory for `file://` archives.
const GUEST_STAGE_DIR: &str = "/tmp/vm0-storage-cache";

const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
/// Storage cache fetches are best-effort and capped to small archives, so a
/// slow full GET should fall back to guest-download instead of holding the
/// per-version cache lock for minutes across retry attempts.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);
const CACHE_HTTP_MAX_ATTEMPTS: usize = 3;
const CACHE_HTTP_RETRY_DELAY: Duration = Duration::from_millis(200);
const STORAGE_CACHE_STAGE_TOTAL: &str = "storage_cache_stage_total";
const STORAGE_CACHE_STAGE_BATCH_WRITE: &str = "storage_cache_stage_batch_write";
const STORAGE_CACHE_STAGE_SINGLE_WRITE: &str = "storage_cache_stage_single_write";
const STORAGE_CACHE_STAGE_FAILED: &str = "storage-cache-stage-failed";
const STORAGE_CACHE_PROCESS_GROUP: &str = "storage_cache_process_group";
const STORAGE_CACHE_PROCESS_GROUP_FAILED: &str = "storage-cache-process-group-failed";
const STORAGE_CACHE_LOCK_WAIT: &str = "storage_cache_lock_wait";
const STORAGE_CACHE_LOCK_WAIT_FAILED: &str = "storage-cache-lock-wait-failed";
const STORAGE_CACHE_HIT_READ: &str = "storage_cache_hit_read";
const STORAGE_CACHE_MISS_PASSTHROUGH: &str = "storage_cache_miss_passthrough";
const STORAGE_CACHE_LOCK_BUSY_PASSTHROUGH: &str = "storage_cache_lock_busy_passthrough";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct StorageCacheOptions {
    pub(crate) miss_passthrough: bool,
}

/// Guest-side filename for a cached archive.
///
/// Includes both hashed components so two manifest entries that differ only in
/// `vas_storage_name` but share `vas_version_id` derive their staged filenames
/// from both values under the same truncated-hash collision model as the host
/// cache. Uses the same `short_digest` helper that `HomePaths` uses for the host
/// cache dir, so host writes and guest reads use one shared keying scheme.
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

struct CacheTargetGroup {
    targets: Vec<CacheTarget>,
}

enum GroupOutcome {
    Shared {
        outcome_target_index: usize,
        outcome: TargetOutcome,
    },
    PerTarget(Vec<TargetOutcome>),
}

struct ProcessedGroup {
    outcome: GroupOutcome,
    stage_write: Option<GuestStageWrite>,
}

struct ProcessedTarget {
    outcome: TargetOutcome,
    stage_write: Option<GuestStageWrite>,
}

struct GuestStageWrite {
    guest_path: String,
    bytes: Bytes,
}

#[derive(Default)]
struct GuestStageBatch {
    writes: Vec<GuestStageWrite>,
    content_bytes: usize,
}

/// Aggregates actual guest write time, excluding cache probe/download work.
struct StorageCacheStageMetrics {
    total_duration: Duration,
    attempted: bool,
    failed: bool,
}

struct CacheProcessMetric {
    action_type: &'static str,
    duration: Duration,
    success: bool,
    error: Option<&'static str>,
}

#[derive(Default)]
struct CacheProcessMetrics {
    records: Vec<CacheProcessMetric>,
}

impl CacheProcessMetrics {
    fn record(
        &mut self,
        action_type: &'static str,
        duration: Duration,
        success: bool,
        error: Option<&'static str>,
    ) {
        self.records.push(CacheProcessMetric {
            action_type,
            duration,
            success,
            error,
        });
    }

    fn record_to(self, telemetry: &mut JobTelemetry) {
        for record in self.records {
            telemetry.record(
                record.action_type,
                record.duration,
                record.success,
                record.error,
            );
        }
    }
}

struct GuestStageRecorder<'a> {
    sandbox: &'a dyn Sandbox,
    guest_writes: &'a GuestWriteLocks,
    telemetry: &'a mut JobTelemetry,
    metrics: &'a mut StorageCacheStageMetrics,
}

struct ProcessedGroupTask {
    group: CacheTargetGroup,
    metrics: CacheProcessMetrics,
    processed: RunnerResult<ProcessedGroup>,
}

type ProcessedGroupTaskResult = ProcessedGroupTask;

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
    /// Size probe (`GET` + `Range: bytes=0-0`) could not determine the
    /// archive size, so the entry falls back to the original R2 URL.
    /// `reason` carries either the upstream error string or a short tag
    /// describing the missing-header case so ops can separate transient
    /// network failures from permanent 4xx / missing size-header responses
    /// in the telemetry feed.
    SkippedHeadFailed {
        reason: String,
    },
    SkippedInvalidDownload {
        reason: String,
    },
    MissPassthrough {
        reason: &'static str,
    },
    LockBusyPassthrough,
}

enum DownloadBody {
    Complete(Bytes),
    Empty,
    OverSize { observed_size: u64 },
}

enum CachedArchive {
    Hit(Bytes),
    Missing,
    Empty,
    OverSize { observed_size: u64 },
}

#[derive(Default)]
struct GuestWriteLocks {
    inner: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl GuestWriteLocks {
    async fn write_file(
        &self,
        sandbox: &dyn Sandbox,
        guest_path: &str,
        bytes: &[u8],
    ) -> RunnerResult<()> {
        let lock = {
            let mut locks = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            Arc::clone(
                locks
                    .entry(guest_path.to_string())
                    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
            )
        };
        let _guard = lock.lock().await;
        sandbox.write_file(guest_path, bytes).await?;
        Ok(())
    }

    async fn write_files(
        &self,
        sandbox: &dyn Sandbox,
        writes: &[GuestStageWrite],
    ) -> RunnerResult<()> {
        if writes.is_empty() {
            return Ok(());
        }
        let mut paths = writes
            .iter()
            .map(|write| write.guest_path.as_str())
            .collect::<Vec<_>>();
        paths.sort_unstable();
        paths.dedup();
        let locks = {
            let mut lock_map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            paths
                .into_iter()
                .map(|path| {
                    Arc::clone(
                        lock_map
                            .entry(path.to_string())
                            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
                    )
                })
                .collect::<Vec<_>>()
        };
        let mut guards = Vec::with_capacity(locks.len());
        for lock in &locks {
            guards.push(lock.lock().await);
        }
        let entries = writes
            .iter()
            .map(|write| WriteFileEntry {
                path: write.guest_path.as_str(),
                content: write.bytes.as_ref(),
            })
            .collect::<Vec<_>>();
        sandbox.write_files(&entries).await?;
        Ok(())
    }
}

impl GuestStageBatch {
    fn should_flush_before(&self, write: &GuestStageWrite) -> bool {
        !self.writes.is_empty()
            && (self.writes.len() >= GUEST_STAGE_BATCH_MAX_FILES
                || self.content_bytes.saturating_add(write.bytes.len())
                    > GUEST_STAGE_BATCH_MAX_BYTES)
    }

    fn push(&mut self, write: GuestStageWrite) {
        self.content_bytes += write.bytes.len();
        self.writes.push(write);
    }

    fn should_flush_after_push(&self) -> bool {
        self.writes.len() >= GUEST_STAGE_BATCH_MAX_FILES
            || self.content_bytes >= GUEST_STAGE_BATCH_MAX_BYTES
    }
}

impl StorageCacheStageMetrics {
    fn start() -> Self {
        Self {
            total_duration: Duration::ZERO,
            attempted: false,
            failed: false,
        }
    }

    fn record_write_result(
        &mut self,
        telemetry: &mut JobTelemetry,
        action_type: &str,
        started_at: Instant,
        result: &RunnerResult<()>,
    ) {
        self.attempted = true;
        let duration = started_at.elapsed();
        self.total_duration = self.total_duration.saturating_add(duration);
        let success = result.is_ok();
        if !success {
            self.failed = true;
        }
        telemetry.record(
            action_type,
            duration,
            success,
            (!success).then_some(STORAGE_CACHE_STAGE_FAILED),
        );
    }

    fn record_total(&self, telemetry: &mut JobTelemetry) {
        if self.attempted {
            let success = !self.failed;
            telemetry.record(
                STORAGE_CACHE_STAGE_TOTAL,
                self.total_duration,
                success,
                (!success).then_some(STORAGE_CACHE_STAGE_FAILED),
            );
        }
    }
}

async fn flush_guest_stage_batch(
    batch: &mut GuestStageBatch,
    stage: &mut GuestStageRecorder<'_>,
) -> RunnerResult<()> {
    if batch.writes.is_empty() {
        return Ok(());
    }
    let started_at = Instant::now();
    let result = stage
        .guest_writes
        .write_files(stage.sandbox, &batch.writes)
        .await;
    stage.metrics.record_write_result(
        stage.telemetry,
        STORAGE_CACHE_STAGE_BATCH_WRITE,
        started_at,
        &result,
    );
    result?;
    batch.writes.clear();
    batch.content_bytes = 0;
    Ok(())
}

async fn stage_single_guest_write(
    write: &GuestStageWrite,
    stage: &mut GuestStageRecorder<'_>,
) -> RunnerResult<()> {
    let started_at = Instant::now();
    let result = stage
        .guest_writes
        .write_file(stage.sandbox, &write.guest_path, &write.bytes)
        .await;
    stage.metrics.record_write_result(
        stage.telemetry,
        STORAGE_CACHE_STAGE_SINGLE_WRITE,
        started_at,
        &result,
    );
    result
}

async fn push_guest_stage_write(
    batch: &mut GuestStageBatch,
    write: GuestStageWrite,
    stage: &mut GuestStageRecorder<'_>,
) -> RunnerResult<()> {
    if write.bytes.len() > GUEST_STAGE_BATCH_MAX_BYTES {
        stage_single_guest_write(&write, stage).await?;
        return Ok(());
    }
    if batch.should_flush_before(&write) {
        flush_guest_stage_batch(batch, stage).await?;
    }
    batch.push(write);
    if batch.should_flush_after_push() {
        flush_guest_stage_batch(batch, stage).await?;
    }
    Ok(())
}

fn should_batch_stage_write(outcome: &GroupOutcome) -> bool {
    matches!(
        outcome,
        GroupOutcome::Shared {
            outcome: TargetOutcome::Hit,
            ..
        }
    )
}

async fn abort_pending_processed_groups(groups: &mut JoinSet<ProcessedGroupTaskResult>) {
    groups.abort_all();
    while groups.join_next().await.is_some() {}
}

async fn join_next_processed_group(
    groups: &mut JoinSet<ProcessedGroupTaskResult>,
) -> RunnerResult<Option<ProcessedGroupTaskResult>> {
    match groups.join_next().await {
        Some(Ok(result)) => Ok(Some(result)),
        Some(Err(error)) => {
            abort_pending_processed_groups(groups).await;
            Err(RunnerError::Internal(format!(
                "storage cache group task failed: {error}"
            )))
        }
        None => Ok(None),
    }
}

async fn stage_processed_group(
    group: CacheTargetGroup,
    processed: ProcessedGroup,
    outcomes: &mut Vec<(CacheTargetGroup, GroupOutcome)>,
    stage_batch: &mut GuestStageBatch,
    stage: &mut GuestStageRecorder<'_>,
) -> RunnerResult<()> {
    let ProcessedGroup {
        outcome,
        stage_write,
    } = processed;
    if let Some(stage_write) = stage_write {
        if should_batch_stage_write(&outcome) {
            push_guest_stage_write(stage_batch, stage_write, stage).await?;
        } else {
            flush_guest_stage_batch(stage_batch, stage).await?;
            stage_single_guest_write(&stage_write, stage).await?;
        }
    }
    outcomes.push((group, outcome));
    Ok(())
}

async fn stage_joined_processed_group(
    groups: &mut JoinSet<ProcessedGroupTaskResult>,
    task: ProcessedGroupTask,
    outcomes: &mut Vec<(CacheTargetGroup, GroupOutcome)>,
    stage_batch: &mut GuestStageBatch,
    stage: &mut GuestStageRecorder<'_>,
) -> RunnerResult<()> {
    let ProcessedGroupTask {
        group,
        metrics,
        processed,
    } = task;
    metrics.record_to(stage.telemetry);
    let processed = match processed {
        Ok(processed) => processed,
        Err(error) => {
            abort_pending_processed_groups(groups).await;
            return Err(error);
        }
    };
    if let Err(error) = stage_processed_group(group, processed, outcomes, stage_batch, stage).await
    {
        abort_pending_processed_groups(groups).await;
        return Err(error);
    }
    Ok(())
}

/// Populate the runner-side cache for eligible entries in `manifest`.
///
/// Mutates `manifest.storages[i].archive_url` / `manifest.artifacts[i].archive_url`
/// in place, rewriting them to `file://` URLs pointing at guest-local tarballs
/// staged over vsock.
///
/// Invariant: only touches entries where `cached == false`, `archive_url.is_some()`,
/// and both `vas_storage_name` and `vas_version_id` are non-empty. Entries that
/// `apply_storage_fingerprint_reuse` marked as reuse-in-place (`archive_url = None`)
/// are left untouched.
#[cfg(test)]
async fn populate_cache(
    manifest: &mut GuestDownloadManifest,
    sandbox: &dyn Sandbox,
    home: &HomePaths,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<()> {
    populate_cache_with_options(
        manifest,
        sandbox,
        home,
        telemetry,
        StorageCacheOptions::default(),
    )
    .await
}

pub async fn populate_cache_with_options(
    manifest: &mut GuestDownloadManifest,
    sandbox: &dyn Sandbox,
    home: &HomePaths,
    telemetry: &mut JobTelemetry,
    options: StorageCacheOptions,
) -> RunnerResult<()> {
    let targets = collect_targets(manifest);
    if targets.is_empty() {
        return Ok(());
    }
    let target_groups = group_targets(targets);

    let http = if options.miss_passthrough {
        None
    } else {
        Some(
            Client::builder()
                .build()
                .map_err(|e| RunnerError::Internal(format!("build http client: {e}")))?,
        )
    };
    let guest_writes = GuestWriteLocks::default();
    let mut stage_metrics = StorageCacheStageMetrics::start();

    // Cache population runs in owned tasks so a slow guest staging write does
    // not stop already-started workers from releasing host cache flocks. Failure
    // paths explicitly abort and drain pending workers so locks are not left for
    // the runtime to clean up later.
    let mut groups = JoinSet::new();
    let stage_result: RunnerResult<Vec<(CacheTargetGroup, GroupOutcome)>> = async {
        let mut outcomes = Vec::new();
        let mut stage_batch = GuestStageBatch::default();
        let mut stage = GuestStageRecorder {
            sandbox,
            guest_writes: &guest_writes,
            telemetry,
            metrics: &mut stage_metrics,
        };

        for group in target_groups {
            while groups.len() >= CONCURRENCY {
                let Some(task) = join_next_processed_group(&mut groups).await? else {
                    break;
                };
                stage_joined_processed_group(
                    &mut groups,
                    task,
                    &mut outcomes,
                    &mut stage_batch,
                    &mut stage,
                )
                .await?;
            }

            let home = home.clone();
            let http = http.clone();
            groups.spawn(async move {
                let mut metrics = CacheProcessMetrics::default();
                let started_at = Instant::now();
                let processed = match http.as_ref() {
                    Some(http) => process_group(&group, http, &home, &mut metrics).await,
                    None => process_group_hit_or_passthrough(&group, &home, &mut metrics).await,
                };
                let success = processed.is_ok();
                metrics.record(
                    STORAGE_CACHE_PROCESS_GROUP,
                    started_at.elapsed(),
                    success,
                    (!success).then_some(STORAGE_CACHE_PROCESS_GROUP_FAILED),
                );
                ProcessedGroupTask {
                    group,
                    metrics,
                    processed,
                }
            });
        }

        while let Some(task) = join_next_processed_group(&mut groups).await? {
            stage_joined_processed_group(
                &mut groups,
                task,
                &mut outcomes,
                &mut stage_batch,
                &mut stage,
            )
            .await?;
        }
        flush_guest_stage_batch(&mut stage_batch, &mut stage).await?;
        Ok(outcomes)
    }
    .await;
    stage_metrics.record_total(telemetry);
    let outcomes = stage_result?;

    if options.miss_passthrough {
        record_passthrough_summary(&outcomes, telemetry);
    }
    for (group, outcome) in outcomes {
        apply_group_outcome(manifest, &group, &outcome, telemetry);
    }
    Ok(())
}

fn group_targets(targets: Vec<CacheTarget>) -> Vec<CacheTargetGroup> {
    let mut group_order = Vec::new();
    let mut groups_by_key: HashMap<(String, String), Vec<CacheTarget>> = HashMap::new();

    for target in targets {
        let key = (target.name.clone(), target.version.clone());
        match groups_by_key.entry(key.clone()) {
            Entry::Occupied(mut entry) => {
                entry.get_mut().push(target);
            }
            Entry::Vacant(entry) => {
                group_order.push(key);
                entry.insert(vec![target]);
            }
        }
    }

    let mut groups = Vec::with_capacity(group_order.len());
    for key in group_order {
        if let Some(targets) = groups_by_key.remove(&key) {
            groups.push(CacheTargetGroup { targets });
        }
    }
    groups
}

fn collect_targets(manifest: &GuestDownloadManifest) -> Vec<CacheTarget> {
    let mut out = Vec::new();
    for (i, s) in manifest.storages.iter().enumerate() {
        if let Some(target) = cache_target_from_entry(
            TargetKind::Storage,
            i,
            s.cached,
            s.archive_url.as_deref(),
            &s.vas_storage_name,
            &s.vas_version_id,
        ) {
            out.push(target);
        }
    }
    for (i, a) in manifest.artifacts.iter().enumerate() {
        if let Some(target) = cache_target_from_entry(
            TargetKind::Artifact,
            i,
            a.cached,
            a.archive_url.as_deref(),
            &a.vas_storage_name,
            &a.vas_version_id,
        ) {
            out.push(target);
        }
    }
    out
}

fn cache_target_from_entry(
    kind: TargetKind,
    index: usize,
    cached: bool,
    archive_url: Option<&str>,
    name: &str,
    version: &str,
) -> Option<CacheTarget> {
    if cached {
        return None;
    }
    let archive_url = archive_url?;
    // Empty components would hash to the same fixed digest as every other
    // empty component, collapsing distinct manifest entries into a shared
    // cache slot. Treat them like missing keys: passthrough.
    if name.is_empty() || version.is_empty() {
        return None;
    }
    Some(CacheTarget {
        kind,
        index,
        name: name.to_string(),
        version: version.to_string(),
        archive_url: archive_url.to_string(),
    })
}

async fn process_group(
    group: &CacheTargetGroup,
    http: &Client,
    home: &HomePaths,
    metrics: &mut CacheProcessMetrics,
) -> RunnerResult<ProcessedGroup> {
    // Same-key targets are expected to refer to the same archive content, so a
    // definitive cache outcome can be shared across the group. Probe and full
    // download passthrough failures are the exception: they are URL/request
    // level decisions, so try the next duplicate before giving up per target.
    let mut retryable_passthrough_outcomes = Vec::new();
    for (index, target) in group.targets.iter().enumerate() {
        let ProcessedTarget {
            outcome,
            stage_write,
        } = process_one(target, http, home, metrics).await?;
        match outcome {
            TargetOutcome::SkippedHeadFailed { .. }
            | TargetOutcome::SkippedInvalidDownload { .. } => {
                retryable_passthrough_outcomes.push(outcome);
                if retryable_passthrough_outcomes.len() == group.targets.len() {
                    return Ok(ProcessedGroup {
                        outcome: GroupOutcome::PerTarget(retryable_passthrough_outcomes),
                        stage_write: None,
                    });
                }
            }
            outcome => {
                return Ok(ProcessedGroup {
                    outcome: GroupOutcome::Shared {
                        outcome_target_index: index,
                        outcome,
                    },
                    stage_write,
                });
            }
        }
    }

    Ok(ProcessedGroup {
        outcome: GroupOutcome::PerTarget(retryable_passthrough_outcomes),
        stage_write: None,
    })
}

async fn process_group_hit_or_passthrough(
    group: &CacheTargetGroup,
    home: &HomePaths,
    metrics: &mut CacheProcessMetrics,
) -> RunnerResult<ProcessedGroup> {
    let target = group
        .targets
        .first()
        .ok_or_else(|| RunnerError::Internal("empty storage cache target group".into()))?;
    let ProcessedTarget {
        outcome,
        stage_write,
    } = process_one_hit_or_passthrough(target, home, metrics).await?;

    Ok(ProcessedGroup {
        outcome: GroupOutcome::Shared {
            outcome_target_index: 0,
            outcome,
        },
        stage_write,
    })
}

async fn process_one(
    target: &CacheTarget,
    http: &Client,
    home: &HomePaths,
    metrics: &mut CacheProcessMetrics,
) -> RunnerResult<ProcessedTarget> {
    let lock_path = home.storage_lock(&target.name, &target.version);
    let cache_dir = home.storage_cache_dir(&target.name, &target.version);
    let archive_path = cache_dir.join("archive.tar.gz");

    // Fast path: a cache hit only needs reader ownership. Once bytes are in
    // memory, the guest copy no longer depends on the on-disk cache entry.
    {
        let started_at = Instant::now();
        let reader_result = lock::acquire_shared(lock_path.clone()).await;
        let success = reader_result.is_ok();
        metrics.record(
            STORAGE_CACHE_LOCK_WAIT,
            started_at.elapsed(),
            success,
            (!success).then_some(STORAGE_CACHE_LOCK_WAIT_FAILED),
        );
        let reader = reader_result?;
        if let CachedArchive::Hit(bytes) =
            read_cache_entry(&cache_dir, &archive_path, metrics).await?
        {
            let guest_path = guest_archive_path(&target.name, &target.version);
            drop(reader);
            return Ok(ProcessedTarget {
                outcome: TargetOutcome::Hit,
                stage_write: Some(GuestStageWrite { guest_path, bytes }),
            });
        }
    }

    // Mutation path: re-check under exclusive ownership because another runner
    // may have populated or repaired the cache while this task waited.
    let started_at = Instant::now();
    let writer_result = lock::acquire(lock_path).await;
    let success = writer_result.is_ok();
    metrics.record(
        STORAGE_CACHE_LOCK_WAIT,
        started_at.elapsed(),
        success,
        (!success).then_some(STORAGE_CACHE_LOCK_WAIT_FAILED),
    );
    let writer = writer_result?;
    match read_cache_entry(&cache_dir, &archive_path, metrics).await? {
        CachedArchive::Hit(bytes) => {
            let guest_path = guest_archive_path(&target.name, &target.version);
            drop(writer);
            return Ok(ProcessedTarget {
                outcome: TargetOutcome::Hit,
                stage_write: Some(GuestStageWrite { guest_path, bytes }),
            });
        }
        CachedArchive::Missing => {}
        CachedArchive::Empty => {
            evict_empty_cache(target, &cache_dir).await?;
        }
        CachedArchive::OverSize { observed_size } => {
            evict_oversized_cache(target, &cache_dir, observed_size).await?;
        }
    }

    // Miss path: probe size via `GET` + `Range: bytes=0-0`. A probe failure is
    // treated as passthrough — the entry keeps its original R2 URL and the
    // guest downloads it as today. The exclusive lock stays held through cache
    // population so same-key runners do not duplicate downloads or race on the
    // staging directory.
    let size = match retry_cache_fetch(|| probe_size(http, &target.archive_url)).await {
        Ok(SizeProbe::Known(n)) => n,
        Ok(SizeProbe::Unknown(reason)) => {
            let reason = reason.as_str();
            warn!(
                name = %target.name,
                version = %target.version,
                reason,
                "storage_cache: probe returned no usable size header, passthrough"
            );
            return Ok(ProcessedTarget {
                outcome: TargetOutcome::SkippedHeadFailed {
                    reason: reason.to_string(),
                },
                stage_write: None,
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
                stage_write: None,
            });
        }
    };
    if size > CACHE_MAX_SIZE {
        info!(
            name = %target.name,
            version = %target.version,
            size,
            "storage_cache: entry over size limit, passthrough"
        );
        return Ok(ProcessedTarget {
            outcome: TargetOutcome::SkippedOverSize,
            stage_write: None,
        });
    }

    // Download, stage, fsync, atomic rename, then release cache ownership before
    // pushing the bytes to the guest.
    let t = Instant::now();
    let bytes =
        match retry_cache_fetch(|| download_tarball(http, &target.archive_url, CACHE_MAX_SIZE))
            .await
        {
            Ok(body) => body,
            Err(e) => {
                let reason = e.to_string();
                match e.into_error() {
                    CacheDownloadError::Http(_) => {
                        warn!(
                            name = %target.name,
                            version = %target.version,
                            error = %reason,
                            "storage_cache: full download failed, passthrough"
                        );
                        return Ok(ProcessedTarget {
                            outcome: TargetOutcome::SkippedInvalidDownload { reason },
                            stage_write: None,
                        });
                    }
                    CacheDownloadError::Internal(e) => return Err(e),
                }
            }
        };
    let bytes = match bytes {
        DownloadBody::Complete(bytes) => bytes,
        DownloadBody::Empty => {
            warn!(
                name = %target.name,
                version = %target.version,
                "storage_cache: full download returned empty archive, passthrough"
            );
            return Ok(ProcessedTarget {
                outcome: TargetOutcome::SkippedInvalidDownload {
                    reason: "empty-download".to_string(),
                },
                stage_write: None,
            });
        }
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
    let observed_size = u64::try_from(bytes.len())
        .map_err(|_| RunnerError::Internal("downloaded archive length overflow".to_string()))?;
    if observed_size != size {
        warn!(
            name = %target.name,
            version = %target.version,
            probe_size = size,
            observed_size,
            "storage_cache: full download size differed from probe, passthrough"
        );
        return Ok(ProcessedTarget {
            outcome: TargetOutcome::SkippedInvalidDownload {
                reason: "size-mismatch".to_string(),
            },
            stage_write: None,
        });
    }
    write_to_cache(&cache_dir, &bytes).await?;
    let guest_path = guest_archive_path(&target.name, &target.version);
    drop(writer);

    Ok(ProcessedTarget {
        outcome: TargetOutcome::Miss {
            download_duration: t.elapsed(),
        },
        stage_write: Some(GuestStageWrite { guest_path, bytes }),
    })
}

async fn process_one_hit_or_passthrough(
    target: &CacheTarget,
    home: &HomePaths,
    metrics: &mut CacheProcessMetrics,
) -> RunnerResult<ProcessedTarget> {
    let lock_path = home.storage_lock(&target.name, &target.version);
    let cache_dir = home.storage_cache_dir(&target.name, &target.version);
    let archive_path = cache_dir.join("archive.tar.gz");
    let started_at = Instant::now();
    let reader_result = lock::try_acquire_shared_or_busy(lock_path).await;
    let success = reader_result.is_ok();
    metrics.record(
        STORAGE_CACHE_LOCK_WAIT,
        started_at.elapsed(),
        success,
        (!success).then_some(STORAGE_CACHE_LOCK_WAIT_FAILED),
    );
    let reader = match reader_result? {
        lock::TryLock::Acquired(lock) => lock,
        lock::TryLock::Busy => {
            return Ok(ProcessedTarget {
                outcome: TargetOutcome::LockBusyPassthrough,
                stage_write: None,
            });
        }
    };

    match read_cache_entry(&cache_dir, &archive_path, metrics).await? {
        CachedArchive::Hit(bytes) => {
            let guest_path = guest_archive_path(&target.name, &target.version);
            drop(reader);
            Ok(ProcessedTarget {
                outcome: TargetOutcome::Hit,
                stage_write: Some(GuestStageWrite { guest_path, bytes }),
            })
        }
        CachedArchive::Missing => Ok(ProcessedTarget {
            outcome: TargetOutcome::MissPassthrough { reason: "missing" },
            stage_write: None,
        }),
        CachedArchive::Empty => Ok(ProcessedTarget {
            outcome: TargetOutcome::MissPassthrough { reason: "empty" },
            stage_write: None,
        }),
        CachedArchive::OverSize { .. } => Ok(ProcessedTarget {
            outcome: TargetOutcome::MissPassthrough {
                reason: "over-size",
            },
            stage_write: None,
        }),
    }
}

async fn read_cache_entry(
    cache_dir: &Path,
    archive_path: &Path,
    metrics: &mut CacheProcessMetrics,
) -> RunnerResult<CachedArchive> {
    match fs::metadata(archive_path).await {
        Ok(metadata) if metadata.len() == 0 => Ok(CachedArchive::Empty),
        Ok(metadata) if metadata.len() <= CACHE_MAX_SIZE => {
            let started_at = Instant::now();
            match read_cached_archive(archive_path, CACHE_MAX_SIZE).await? {
                DownloadBody::Complete(bytes) => {
                    metrics.record(STORAGE_CACHE_HIT_READ, started_at.elapsed(), true, None);
                    touch_mtime(cache_dir);
                    Ok(CachedArchive::Hit(bytes))
                }
                DownloadBody::Empty => Ok(CachedArchive::Empty),
                DownloadBody::OverSize { observed_size } => {
                    Ok(CachedArchive::OverSize { observed_size })
                }
            }
        }
        Ok(metadata) => Ok(CachedArchive::OverSize {
            observed_size: metadata.len(),
        }),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(CachedArchive::Missing),
        Err(e) => Err(RunnerError::Internal(format!(
            "stat cached {}: {e}",
            archive_path.display()
        ))),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum SizeProbe {
    Known(u64),
    Unknown(SizeProbeUnknown),
}

#[derive(Debug, PartialEq, Eq)]
enum SizeProbeUnknown {
    MissingSizeHeader,
    InvalidSizeHeader,
    MissingContentRange,
    UnknownSize,
    InvalidContentRange,
}

impl SizeProbeUnknown {
    fn as_str(&self) -> &'static str {
        match self {
            Self::MissingSizeHeader => "missing-size-header",
            Self::InvalidSizeHeader => "invalid-size-header",
            Self::MissingContentRange => "missing-content-range",
            Self::UnknownSize => "unknown-size",
            Self::InvalidContentRange => "invalid-content-range",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ProbeContentRange {
    Known(u64),
    UnknownSize,
    Invalid,
}

trait CacheRetryableError {
    fn is_retryable(&self) -> bool;
}

#[derive(Debug)]
enum CacheHttpError {
    Status {
        phase: &'static str,
        status: reqwest::StatusCode,
    },
    UnexpectedStatus {
        phase: &'static str,
        status: reqwest::StatusCode,
    },
    Transport {
        phase: &'static str,
        detail: String,
        retryable: bool,
    },
}

impl CacheHttpError {
    fn status(phase: &'static str, status: reqwest::StatusCode) -> Self {
        Self::Status { phase, status }
    }

    fn unexpected_status(phase: &'static str, status: reqwest::StatusCode) -> Self {
        Self::UnexpectedStatus { phase, status }
    }

    fn from_reqwest(phase: &'static str, error: reqwest::Error) -> Self {
        if let Some(status) = error.status() {
            return Self::status(phase, status);
        }
        let retryable = reqwest_error_is_retryable(&error);
        Self::Transport {
            phase,
            detail: reqwest_error(error),
            retryable,
        }
    }
}

impl fmt::Display for CacheHttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Status { phase, status } => write!(f, "{phase}: HTTP status {status}"),
            Self::UnexpectedStatus { phase, status } => {
                write!(f, "{phase}: unexpected status {status}")
            }
            Self::Transport { phase, detail, .. } => write!(f, "{phase}: {detail}"),
        }
    }
}

impl CacheRetryableError for CacheHttpError {
    fn is_retryable(&self) -> bool {
        match self {
            Self::Status { status, .. } => {
                *status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
            }
            Self::UnexpectedStatus { .. } => false,
            Self::Transport { retryable, .. } => *retryable,
        }
    }
}

#[derive(Debug)]
enum CacheDownloadError {
    Http(CacheHttpError),
    Internal(RunnerError),
}

impl From<CacheHttpError> for CacheDownloadError {
    fn from(error: CacheHttpError) -> Self {
        Self::Http(error)
    }
}

impl From<RunnerError> for CacheDownloadError {
    fn from(error: RunnerError) -> Self {
        Self::Internal(error)
    }
}

impl fmt::Display for CacheDownloadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http(error) => write!(f, "{error}"),
            Self::Internal(error) => write!(f, "{error}"),
        }
    }
}

impl CacheRetryableError for CacheDownloadError {
    fn is_retryable(&self) -> bool {
        match self {
            Self::Http(error) => error.is_retryable(),
            Self::Internal(_) => false,
        }
    }
}

#[derive(Debug)]
struct CacheRetryError<E> {
    error: E,
    attempts: usize,
    exhausted_retry: bool,
}

impl<E> CacheRetryError<E> {
    fn into_error(self) -> E {
        self.error
    }
}

impl<E: fmt::Display> fmt::Display for CacheRetryError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.exhausted_retry {
            write!(
                f,
                "retry exhausted after {} attempts: {}",
                self.attempts, self.error
            )
        } else {
            write!(f, "{}", self.error)
        }
    }
}

async fn retry_cache_fetch<T, E, F, Fut>(mut operation: F) -> Result<T, CacheRetryError<E>>
where
    E: CacheRetryableError,
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    let mut attempt = 1;
    loop {
        match operation().await {
            Ok(value) => return Ok(value),
            Err(error) => {
                let retryable = error.is_retryable();
                let should_retry = retryable && attempt < CACHE_HTTP_MAX_ATTEMPTS;
                if !should_retry {
                    return Err(CacheRetryError {
                        error,
                        attempts: attempt,
                        exhausted_retry: retryable && attempt >= CACHE_HTTP_MAX_ATTEMPTS,
                    });
                }
                sleep_cache_retry_delay().await;
                attempt += 1;
            }
        }
    }
}

async fn sleep_cache_retry_delay() {
    let delay = cache_http_retry_delay();
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
}

fn cache_http_retry_delay() -> Duration {
    if cfg!(test) {
        Duration::ZERO
    } else {
        CACHE_HTTP_RETRY_DELAY
    }
}

async fn probe_size(http: &Client, url: &str) -> Result<SizeProbe, CacheHttpError> {
    use reqwest::{StatusCode, header};
    let resp = http
        .get(url)
        .header(header::RANGE, "bytes=0-0")
        .timeout(HEAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| CacheHttpError::from_reqwest("probe GET", e))?;

    let status = resp.status();
    if status == StatusCode::PARTIAL_CONTENT {
        // 206: parse total from `Content-Range: bytes 0-0/<total>`.
        let total = match resp.headers().get(header::CONTENT_RANGE) {
            Some(value) => match value.to_str() {
                Ok(value) => match parse_probe_content_range_total(value) {
                    ProbeContentRange::Known(total) => SizeProbe::Known(total),
                    ProbeContentRange::UnknownSize => {
                        SizeProbe::Unknown(SizeProbeUnknown::UnknownSize)
                    }
                    ProbeContentRange::Invalid => {
                        SizeProbe::Unknown(SizeProbeUnknown::InvalidContentRange)
                    }
                },
                Err(_) => SizeProbe::Unknown(SizeProbeUnknown::InvalidContentRange),
            },
            None => SizeProbe::Unknown(SizeProbeUnknown::MissingContentRange),
        };
        // Do not drain the body here. Some origins ignore Range while still
        // returning large bodies, and probe safety matters more than reusing
        // this connection.
        return Ok(total);
    }
    if status == StatusCode::OK {
        // 200: server ignored Range. Fall back to Content-Length.
        let total = match resp.headers().get(header::CONTENT_LENGTH) {
            Some(value) => match value.to_str().ok().and_then(parse_ascii_decimal_u64) {
                Some(0) => SizeProbe::Unknown(SizeProbeUnknown::InvalidSizeHeader),
                Some(total) => SizeProbe::Known(total),
                None => SizeProbe::Unknown(SizeProbeUnknown::InvalidSizeHeader),
            },
            None => SizeProbe::Unknown(SizeProbeUnknown::MissingSizeHeader),
        };
        // Drop the response after headers instead of buffering an ignored
        // Range response into memory.
        return Ok(total);
    }
    // 4xx / 5xx / 416 / anything else — treat as probe failure.
    if status.is_success() {
        Err(CacheHttpError::unexpected_status("probe GET", status))
    } else {
        Err(CacheHttpError::status("probe GET", status))
    }
}

fn reqwest_error(e: reqwest::Error) -> String {
    e.without_url().to_string()
}

fn reqwest_error_is_retryable(e: &reqwest::Error) -> bool {
    // Truncated/protocol-level body reads can surface as decode-style errors
    // without a status, and those should retry like other transient cache fetches.
    !(e.is_builder() || e.is_redirect())
}

/// Parse the total size from the response to our `Range: bytes=0-0` probe.
fn parse_probe_content_range_total(value: &str) -> ProbeContentRange {
    let mut parts = value.split_whitespace();
    let Some(unit) = parts.next() else {
        return ProbeContentRange::Invalid;
    };
    let Some(range_and_total) = parts.next() else {
        return ProbeContentRange::Invalid;
    };
    if parts.next().is_some() || !unit.eq_ignore_ascii_case("bytes") {
        return ProbeContentRange::Invalid;
    }

    let mut range_total_parts = range_and_total.split('/');
    let Some(range) = range_total_parts.next() else {
        return ProbeContentRange::Invalid;
    };
    let Some(total) = range_total_parts.next() else {
        return ProbeContentRange::Invalid;
    };
    if range_total_parts.next().is_some() {
        return ProbeContentRange::Invalid;
    }

    let Some((start, end)) = range.split_once('-') else {
        return ProbeContentRange::Invalid;
    };
    let Some(start) = parse_ascii_decimal_u64(start) else {
        return ProbeContentRange::Invalid;
    };
    let Some(end) = parse_ascii_decimal_u64(end) else {
        return ProbeContentRange::Invalid;
    };
    if start != 0 || end != 0 {
        return ProbeContentRange::Invalid;
    }

    if total == "*" {
        return ProbeContentRange::UnknownSize;
    }
    let Some(total) = parse_ascii_decimal_u64(total) else {
        return ProbeContentRange::Invalid;
    };
    if total <= end {
        return ProbeContentRange::Invalid;
    }
    ProbeContentRange::Known(total)
}

fn parse_ascii_decimal_u64(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse::<u64>().ok()
}

async fn download_tarball(
    http: &Client,
    url: &str,
    max_size: u64,
) -> Result<DownloadBody, CacheDownloadError> {
    let mut resp = http
        .get(url)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| CacheHttpError::from_reqwest("GET", e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(CacheHttpError::status("GET", status).into());
    }

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
        .map_err(|e| CacheHttpError::from_reqwest("read body", e))?
    {
        if let Some(observed_size) =
            append_limited_chunk(&mut bytes, &mut downloaded, &chunk, max_size)?
        {
            return Ok(DownloadBody::OverSize { observed_size });
        }
    }

    if bytes.is_empty() {
        return Ok(DownloadBody::Empty);
    }

    Ok(DownloadBody::Complete(Bytes::from(bytes)))
}

async fn read_cached_archive(path: &Path, max_size: u64) -> RunnerResult<DownloadBody> {
    let mut file = fs::File::open(path)
        .await
        .map_err(|e| RunnerError::Internal(format!("open cached {}: {e}", path.display())))?;
    let mut bytes = Vec::with_capacity(max_size.min(64 * 1024) as usize);
    let mut downloaded = 0u64;
    let mut buf = [0u8; 64 * 1024];

    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| RunnerError::Internal(format!("read cached {}: {e}", path.display())))?;
        if n == 0 {
            break;
        }
        let chunk = buf.get(..n).ok_or_else(|| {
            RunnerError::Internal(format!(
                "read cached {} produced invalid chunk length {n}",
                path.display()
            ))
        })?;
        if let Some(observed_size) =
            append_limited_chunk(&mut bytes, &mut downloaded, chunk, max_size)?
        {
            return Ok(DownloadBody::OverSize { observed_size });
        }
    }

    if bytes.is_empty() {
        return Ok(DownloadBody::Empty);
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

async fn evict_empty_cache(target: &CacheTarget, cache_dir: &Path) -> RunnerResult<()> {
    warn!(
        name = %target.name,
        version = %target.version,
        "storage_cache: cached archive is empty, evicting"
    );
    if let Err(e) = fs::remove_dir_all(cache_dir).await
        && e.kind() != io::ErrorKind::NotFound
    {
        return Err(RunnerError::Internal(format!(
            "remove empty cache {}: {e}",
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

fn apply_group_outcome(
    manifest: &mut GuestDownloadManifest,
    group: &CacheTargetGroup,
    group_outcome: &GroupOutcome,
    telemetry: &mut JobTelemetry,
) {
    match group_outcome {
        GroupOutcome::Shared {
            outcome_target_index,
            outcome,
        } => match outcome {
            TargetOutcome::Hit => {
                for target in &group.targets {
                    apply_outcome(manifest, target, outcome, telemetry);
                }
            }
            TargetOutcome::Miss { .. } => {
                // The representative miss already staged the group archive in
                // the guest. Other same-key entries are equivalent to cache
                // hits for both rewrite behavior and entry-level telemetry.
                let hit = TargetOutcome::Hit;
                for (index, target) in group.targets.iter().enumerate() {
                    if index == *outcome_target_index {
                        apply_outcome(manifest, target, outcome, telemetry);
                    } else {
                        apply_outcome(manifest, target, &hit, telemetry);
                    }
                }
            }
            TargetOutcome::SkippedOverSize
            | TargetOutcome::SkippedHeadFailed { .. }
            | TargetOutcome::SkippedInvalidDownload { .. }
            | TargetOutcome::MissPassthrough { .. }
            | TargetOutcome::LockBusyPassthrough => {
                for target in &group.targets {
                    apply_outcome(manifest, target, outcome, telemetry);
                }
            }
        },
        GroupOutcome::PerTarget(outcomes) => {
            debug_assert_eq!(group.targets.len(), outcomes.len());
            for (target, outcome) in group.targets.iter().zip(outcomes) {
                apply_outcome(manifest, target, outcome, telemetry);
            }
        }
    }
}

fn apply_outcome(
    manifest: &mut GuestDownloadManifest,
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
        TargetOutcome::SkippedInvalidDownload { reason } => {
            telemetry.record(
                "storage_cache_skipped_invalid_download",
                Duration::ZERO,
                true,
                Some(reason.as_str()),
            );
        }
        TargetOutcome::MissPassthrough { reason } => {
            telemetry.record(
                STORAGE_CACHE_MISS_PASSTHROUGH,
                Duration::ZERO,
                true,
                Some(reason),
            );
        }
        TargetOutcome::LockBusyPassthrough => {
            telemetry.record(
                STORAGE_CACHE_LOCK_BUSY_PASSTHROUGH,
                Duration::ZERO,
                true,
                None,
            );
        }
    }
}

#[derive(Default)]
struct PassthroughSummary {
    hit_targets: usize,
    miss_targets: usize,
    lock_busy_targets: usize,
}

fn record_passthrough_summary(
    outcomes: &[(CacheTargetGroup, GroupOutcome)],
    telemetry: &mut JobTelemetry,
) {
    let mut summary = PassthroughSummary::default();
    for (group, group_outcome) in outcomes {
        match group_outcome {
            GroupOutcome::Shared { outcome, .. } => {
                add_passthrough_summary(&mut summary, outcome, group.targets.len());
            }
            GroupOutcome::PerTarget(target_outcomes) => {
                for outcome in target_outcomes {
                    add_passthrough_summary(&mut summary, outcome, 1);
                }
            }
        }
    }

    telemetry.record(
        passthrough_hit_count_action(summary.hit_targets),
        Duration::ZERO,
        true,
        None,
    );
    telemetry.record(
        passthrough_miss_count_action(summary.miss_targets),
        Duration::ZERO,
        true,
        None,
    );
    telemetry.record(
        passthrough_lock_busy_count_action(summary.lock_busy_targets),
        Duration::ZERO,
        true,
        None,
    );
}

fn add_passthrough_summary(
    summary: &mut PassthroughSummary,
    outcome: &TargetOutcome,
    target_count: usize,
) {
    match outcome {
        TargetOutcome::Hit => summary.hit_targets += target_count,
        TargetOutcome::MissPassthrough { .. } => summary.miss_targets += target_count,
        TargetOutcome::LockBusyPassthrough => summary.lock_busy_targets += target_count,
        TargetOutcome::Miss { .. }
        | TargetOutcome::SkippedOverSize
        | TargetOutcome::SkippedHeadFailed { .. }
        | TargetOutcome::SkippedInvalidDownload { .. } => {}
    }
}

fn passthrough_hit_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "storage_cache_passthrough_hit_count_0",
        CountBucket::One => "storage_cache_passthrough_hit_count_1",
        CountBucket::Two => "storage_cache_passthrough_hit_count_2",
        CountBucket::ThreeToFour => "storage_cache_passthrough_hit_count_3_4",
        CountBucket::FiveToEight => "storage_cache_passthrough_hit_count_5_8",
        CountBucket::NineToSixteen => "storage_cache_passthrough_hit_count_9_16",
        CountBucket::SeventeenPlus => "storage_cache_passthrough_hit_count_17_plus",
    }
}

fn passthrough_miss_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "storage_cache_passthrough_miss_count_0",
        CountBucket::One => "storage_cache_passthrough_miss_count_1",
        CountBucket::Two => "storage_cache_passthrough_miss_count_2",
        CountBucket::ThreeToFour => "storage_cache_passthrough_miss_count_3_4",
        CountBucket::FiveToEight => "storage_cache_passthrough_miss_count_5_8",
        CountBucket::NineToSixteen => "storage_cache_passthrough_miss_count_9_16",
        CountBucket::SeventeenPlus => "storage_cache_passthrough_miss_count_17_plus",
    }
}

fn passthrough_lock_busy_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "storage_cache_passthrough_lock_busy_count_0",
        CountBucket::One => "storage_cache_passthrough_lock_busy_count_1",
        CountBucket::Two => "storage_cache_passthrough_lock_busy_count_2",
        CountBucket::ThreeToFour => "storage_cache_passthrough_lock_busy_count_3_4",
        CountBucket::FiveToEight => "storage_cache_passthrough_lock_busy_count_5_8",
        CountBucket::NineToSixteen => "storage_cache_passthrough_lock_busy_count_9_16",
        CountBucket::SeventeenPlus => "storage_cache_passthrough_lock_busy_count_17_plus",
    }
}

#[derive(Clone, Copy)]
enum CountBucket {
    Zero,
    One,
    Two,
    ThreeToFour,
    FiveToEight,
    NineToSixteen,
    SeventeenPlus,
}

fn count_bucket(count: usize) -> CountBucket {
    match count {
        0 => CountBucket::Zero,
        1 => CountBucket::One,
        2 => CountBucket::Two,
        3 | 4 => CountBucket::ThreeToFour,
        5..=8 => CountBucket::FiveToEight,
        9..=16 => CountBucket::NineToSixteen,
        _ => CountBucket::SeventeenPlus,
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
            if let Some(entry) = manifest.storages.get_mut(target.index) {
                applied = rewrite_entry_url(
                    &mut entry.archive_url,
                    &entry.vas_storage_name,
                    &entry.vas_version_id,
                    target,
                    new_url,
                );
            }
        }
        TargetKind::Artifact => {
            if let Some(entry) = manifest.artifacts.get_mut(target.index) {
                applied = rewrite_entry_url(
                    &mut entry.archive_url,
                    &entry.vas_storage_name,
                    &entry.vas_version_id,
                    target,
                    new_url,
                );
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

fn rewrite_entry_url(
    archive_url: &mut Option<String>,
    name: &str,
    version: &str,
    target: &CacheTarget,
    new_url: String,
) -> bool {
    if name != target.name.as_str() || version != target.version.as_str() {
        return false;
    }
    *archive_url = Some(new_url);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    use async_trait::async_trait;
    use httpmock::Method::{GET, HEAD};
    use httpmock::prelude::*;
    use sandbox::{SandboxError, SandboxOperation, SandboxOperationReason};
    use sandbox_mock::{MockLifecycleGate, MockSandbox};
    use std::collections::HashSet;
    use std::sync::{Arc, Mutex};
    use tokio::io::AsyncWriteExt as _;
    use tokio::net::TcpListener;

    use crate::http::{HttpClient, HttpClientConfig};
    use crate::ids::RunId;
    use crate::types::{
        GuestDownloadArtifactEntry, GuestDownloadManifest, GuestDownloadStorageEntry,
    };

    fn new_telemetry() -> JobTelemetry {
        let http = HttpClient::new(HttpClientConfig {
            api_url: "http://localhost:0".to_string(),
            vercel_bypass: None,
        })
        .unwrap();
        JobTelemetry::new(http, RunId::nil(), "test-token".to_string())
    }

    fn assert_op(ops: &[(String, bool, Option<String>)], action_type: &str, success: bool) {
        assert!(
            ops.iter()
                .any(|(key, op_success, _)| key == action_type && *op_success == success),
            "expected {action_type} success={success} in {ops:?}"
        );
    }

    fn assert_op_error(
        ops: &[(String, bool, Option<String>)],
        action_type: &str,
        expected_error: &str,
    ) {
        let error = ops
            .iter()
            .find(|(key, _, _)| key == action_type)
            .and_then(|(_, _, error)| error.as_deref());
        assert_eq!(
            error,
            Some(expected_error),
            "expected {action_type} error {expected_error:?} in {ops:?}"
        );
    }

    fn assert_no_op(ops: &[(String, bool, Option<String>)], action_type: &str) {
        assert!(
            !ops.iter().any(|(key, _, _)| key == action_type),
            "expected no {action_type} in {ops:?}"
        );
    }

    fn op_count(ops: &[(String, bool, Option<String>)], action_type: &str) -> usize {
        ops.iter().filter(|(key, _, _)| key == action_type).count()
    }

    fn assert_op_count(ops: &[(String, bool, Option<String>)], action_type: &str, expected: usize) {
        assert_eq!(
            op_count(ops, action_type),
            expected,
            "expected {expected} {action_type} ops in {ops:?}"
        );
    }

    fn op_duration_ms(ops: &[(String, u64, bool, Option<String>)], action_type: &str) -> u64 {
        ops.iter()
            .find(|(key, _, _, _)| key == action_type)
            .map(|(_, duration_ms, _, _)| *duration_ms)
            .unwrap_or_else(|| panic!("expected {action_type} in {ops:?}"))
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

    fn manifest_duplicate_storages(
        first_url: String,
        second_url: String,
        name: &str,
        version: &str,
    ) -> GuestDownloadManifest {
        GuestDownloadManifest {
            storages: vec![
                GuestDownloadStorageEntry {
                    mount_path: "/mnt/duplicate-a".into(),
                    archive_url: Some(first_url),
                    cached: false,
                    instructions_target_filename: None,
                    vas_storage_name: name.to_string(),
                    vas_version_id: version.to_string(),
                },
                GuestDownloadStorageEntry {
                    mount_path: "/mnt/duplicate-b".into(),
                    archive_url: Some(second_url),
                    cached: false,
                    instructions_target_filename: None,
                    vas_storage_name: name.to_string(),
                    vas_version_id: version.to_string(),
                },
            ],
            artifacts: Vec::new(),
            cleanup_paths: Vec::new(),
        }
    }

    fn manifest_single_artifact(url: String, name: &str, version: &str) -> GuestDownloadManifest {
        GuestDownloadManifest {
            storages: Vec::new(),
            artifacts: vec![GuestDownloadArtifactEntry {
                mount_path: format!("/mnt/artifact-{name}"),
                archive_url: Some(url),
                cached: false,
                vas_storage_name: name.to_string(),
                vas_storage_id: format!("{name}-id"),
                vas_version_id: version.to_string(),
                missing_root_policy: None,
            }],
            cleanup_paths: Vec::new(),
        }
    }

    fn tarball_bytes() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let encoder = flate2::write::GzEncoder::new(&mut bytes, flate2::Compression::default());
            let mut builder = tar::Builder::new(encoder);
            let content = b"storage cache test file\n";
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "file.txt", &content[..])
                .unwrap();
            let encoder = builder.into_inner().unwrap();
            encoder.finish().unwrap();
        }
        bytes
    }

    fn write_cached_archive(home: &HomePaths, name: &str, version: &str, bytes: &[u8]) {
        let cache_dir = home.storage_cache_dir(name, version);
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::write(cache_dir.join("archive.tar.gz"), bytes).unwrap();
    }

    struct SamePathConcurrentWriteDetectingSandbox {
        inner: MockSandbox,
        gate: MockLifecycleGate,
        active_paths: Mutex<HashSet<String>>,
    }

    impl SamePathConcurrentWriteDetectingSandbox {
        fn new(id: impl Into<String>) -> Self {
            let inner = MockSandbox::new(id);
            let gate = MockLifecycleGate::new();
            inner.set_write_file_lifecycle_gate(gate.clone());
            Self {
                inner,
                gate,
                active_paths: Mutex::new(HashSet::new()),
            }
        }

        fn gate(&self) -> MockLifecycleGate {
            self.gate.clone()
        }

        fn write_file_calls(&self) -> Vec<sandbox_mock::WriteFileCall> {
            self.inner.write_file_calls()
        }
    }

    #[async_trait]
    impl Sandbox for SamePathConcurrentWriteDetectingSandbox {
        fn id(&self) -> &str {
            self.inner.id()
        }

        fn source_ip(&self) -> &str {
            self.inner.source_ip()
        }

        fn process_pid(&self) -> Option<u32> {
            self.inner.process_pid()
        }

        async fn start(&mut self) -> sandbox::Result<()> {
            self.inner.start().await
        }

        async fn stop(&mut self) -> sandbox::Result<()> {
            self.inner.stop().await
        }

        async fn kill(&mut self) -> sandbox::Result<()> {
            self.inner.kill().await
        }

        async fn park(&mut self) -> sandbox::Result<()> {
            self.inner.park().await
        }

        async fn unpark(&mut self) -> sandbox::Result<()> {
            self.inner.unpark().await
        }

        async fn exec(
            &self,
            request: &sandbox::ExecRequest<'_>,
        ) -> sandbox::Result<sandbox::ExecResult> {
            self.inner.exec(request).await
        }

        async fn exec_with_diagnostic_label(
            &self,
            request: &sandbox::ExecRequest<'_>,
            label: &'static str,
        ) -> sandbox::Result<sandbox::ExecResult> {
            self.inner.exec_with_diagnostic_label(request, label).await
        }

        async fn read_file(&self, path: &str, max_bytes: u64) -> sandbox::Result<Option<Vec<u8>>> {
            self.inner.read_file(path, max_bytes).await
        }

        async fn copy_file(
            &self,
            path: &str,
            host_path: &Path,
            options: sandbox::CopyFileOptions,
        ) -> sandbox::Result<sandbox::CopyFileResult> {
            self.inner.copy_file(path, host_path, options).await
        }

        async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
            {
                let mut active_paths = self.active_paths.lock().unwrap_or_else(|e| e.into_inner());
                if !active_paths.insert(path.to_string()) {
                    return Err(SandboxError::Operation {
                        operation: SandboxOperation::WriteFile,
                        reason: SandboxOperationReason::Other,
                        message: format!("concurrent write_file to {path}"),
                    });
                }
            }

            let result = self.inner.write_file(path, content).await;
            self.active_paths
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(path);
            result
        }

        async fn write_private_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
            self.inner.write_private_file(path, content).await
        }

        async fn start_process(
            &self,
            request: &sandbox::StartProcessRequest<'_>,
        ) -> sandbox::Result<sandbox::GuestProcessHandle> {
            self.inner.start_process(request).await
        }

        async fn wait_process(
            &self,
            handle: sandbox::GuestProcessHandle,
            timeout: Duration,
        ) -> sandbox::Result<sandbox::ProcessExit> {
            self.inner.wait_process(handle, timeout).await
        }
    }

    fn sandbox_write_file_error(message: impl Into<String>) -> SandboxError {
        SandboxError::Operation {
            operation: SandboxOperation::WriteFile,
            reason: SandboxOperationReason::Guest,
            message: message.into(),
        }
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

    async fn raw_http_sequence_url(
        responses: Vec<Vec<u8>>,
    ) -> (String, tokio::task::JoinHandle<std::io::Result<()>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            for response in responses {
                let (mut socket, _) = listener.accept().await?;
                let mut request = [0u8; 1024];
                let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut request).await?;
                socket.write_all(&response).await?;
            }
            Ok(())
        });
        (format!("http://{addr}/archive.tar.gz"), handle)
    }

    async fn await_raw_http_sequence(handle: tokio::task::JoinHandle<std::io::Result<()>>) {
        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("raw HTTP sequence server should finish")
            .expect("raw HTTP sequence server task should not panic")
            .expect("raw HTTP sequence server should not fail");
    }

    fn status_response(status: &str) -> Vec<u8> {
        format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n").into_bytes()
    }

    fn partial_content_response(total: usize) -> Vec<u8> {
        format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{total}\r\nContent-Length: 1\r\n\r\nx"
        )
        .into_bytes()
    }

    fn ok_response(body: &[u8]) -> Vec<u8> {
        let mut response =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
        response.extend_from_slice(body);
        response
    }

    fn truncated_ok_response(body: &[u8]) -> Vec<u8> {
        let partial_len = (body.len() / 2).max(1);
        let mut response =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
        response.extend_from_slice(&body[..partial_len]);
        response
    }

    fn assert_storage_cache_skipped_reason(ops: &[(String, bool, Option<String>)], expected: &str) {
        let reason = ops
            .iter()
            .find(|(k, _, _)| k == "storage_cache_skipped_head_failed")
            .and_then(|(_, _, error)| error.as_deref());
        assert_eq!(
            reason,
            Some(expected),
            "expected storage_cache_skipped_head_failed reason {expected:?} in {ops:?}"
        );
    }

    fn assert_storage_cache_skipped_reason_contains(
        ops: &[(String, bool, Option<String>)],
        expected: &str,
    ) {
        let reason = ops
            .iter()
            .find(|(k, _, _)| k == "storage_cache_skipped_head_failed")
            .and_then(|(_, _, error)| error.as_deref())
            .expect("expected storage_cache_skipped_head_failed reason");
        assert!(
            reason.contains(expected),
            "expected storage_cache_skipped_head_failed reason to contain {expected:?} in {ops:?}"
        );
    }

    fn assert_storage_cache_skipped_invalid_download(
        ops: &[(String, bool, Option<String>)],
        expected: &str,
    ) {
        let reason = ops
            .iter()
            .find(|(k, _, _)| k == "storage_cache_skipped_invalid_download")
            .and_then(|(_, _, error)| error.as_deref());
        assert_eq!(
            reason,
            Some(expected),
            "expected storage_cache_skipped_invalid_download reason {expected:?} in {ops:?}"
        );
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
        assert_op(&ops, STORAGE_CACHE_PROCESS_GROUP, true);
        assert_op(&ops, STORAGE_CACHE_LOCK_WAIT, true);
        assert_op(&ops, STORAGE_CACHE_HIT_READ, true);
        assert_op_count(&ops, STORAGE_CACHE_PROCESS_GROUP, 1);
        assert_op_count(&ops, STORAGE_CACHE_LOCK_WAIT, 1);
        assert_op_count(&ops, STORAGE_CACHE_HIT_READ, 1);
        let batches = sandbox.write_files_calls();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].files.len(), 1);
        assert_eq!(batches[0].files[0].path, guest_archive_path(name, version));
    }

    #[tokio::test]
    async fn guarded_hit_path_reads_from_disk_and_rewrites_url() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        let name = "guarded-hit";
        let version = "v1";
        write_cached_archive(&home, name, version, &tarball_bytes());
        let mut manifest = manifest_single_storage(
            "https://r2.example.com/never-called.tar.gz".into(),
            name,
            version,
        );

        populate_cache_with_options(
            &mut manifest,
            &sandbox,
            &home,
            &mut telemetry,
            StorageCacheOptions {
                miss_passthrough: true,
            },
        )
        .await
        .unwrap();

        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        let batches = sandbox.write_files_calls();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].files.len(), 1);
        assert_eq!(batches[0].files[0].path, guest_archive_path(name, version));
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, "storage_cache_hit", true);
        assert_op(&ops, "storage_cache_passthrough_hit_count_1", true);
        assert_op(&ops, "storage_cache_passthrough_miss_count_0", true);
        assert_no_op(&ops, "storage_cache_miss");
        assert_no_op(&ops, "storage_cache_download");
    }

    #[tokio::test]
    async fn guarded_miss_passthrough_keeps_url_without_http_or_cache_write() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (hit_tx, mut hit_rx) = tokio::sync::oneshot::channel();
        let server_task = tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let _ = hit_tx.send(());
                let _ = socket
                    .write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n")
                    .await;
            }
        });
        let name = "guarded-miss";
        let version = "v1";
        let original = format!("http://{addr}/archive.tar.gz");
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        populate_cache_with_options(
            &mut manifest,
            &sandbox,
            &home,
            &mut telemetry,
            StorageCacheOptions {
                miss_passthrough: true,
            },
        )
        .await
        .unwrap();

        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(original.as_str())
        );
        assert!(
            hit_rx.try_recv().is_err(),
            "guarded miss should not contact the archive URL"
        );
        server_task.abort();
        let _ = server_task.await;
        assert!(!home.storage_cache_dir(name, version).exists());
        assert!(sandbox.write_file_calls().is_empty());
        assert!(sandbox.write_files_calls().is_empty());
        let ops = telemetry.pending_ops_snapshot();
        assert_op_error(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, "missing");
        assert_op(&ops, "storage_cache_passthrough_miss_count_1", true);
        assert_op(&ops, "storage_cache_passthrough_hit_count_0", true);
        assert_no_op(&ops, "storage_cache_miss");
        assert_no_op(&ops, "storage_cache_download");
        assert_no_op(&ops, "storage_cache_skipped_head_failed");
    }

    #[tokio::test]
    async fn guarded_empty_and_oversized_cached_archives_passthrough_without_eviction() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let empty_name = "guarded-empty";
        let oversized_name = "guarded-oversized";
        let version = "v1";
        let empty_dir = home.storage_cache_dir(empty_name, version);
        std::fs::create_dir_all(&empty_dir).unwrap();
        std::fs::write(empty_dir.join("archive.tar.gz"), b"").unwrap();
        let oversized_dir = home.storage_cache_dir(oversized_name, version);
        std::fs::create_dir_all(&oversized_dir).unwrap();
        let oversized_file = std::fs::File::create(oversized_dir.join("archive.tar.gz")).unwrap();
        oversized_file.set_len(CACHE_MAX_SIZE + 1).unwrap();
        let empty_url = "https://r2.example.com/empty.tar.gz".to_string();
        let oversized_url = "https://r2.example.com/oversized.tar.gz".to_string();
        let mut manifest = GuestDownloadManifest {
            storages: vec![
                GuestDownloadStorageEntry {
                    mount_path: "/mnt/empty".into(),
                    archive_url: Some(empty_url.clone()),
                    cached: false,
                    instructions_target_filename: None,
                    vas_storage_name: empty_name.to_string(),
                    vas_version_id: version.to_string(),
                },
                GuestDownloadStorageEntry {
                    mount_path: "/mnt/oversized".into(),
                    archive_url: Some(oversized_url.clone()),
                    cached: false,
                    instructions_target_filename: None,
                    vas_storage_name: oversized_name.to_string(),
                    vas_version_id: version.to_string(),
                },
            ],
            artifacts: Vec::new(),
            cleanup_paths: Vec::new(),
        };

        populate_cache_with_options(
            &mut manifest,
            &sandbox,
            &home,
            &mut telemetry,
            StorageCacheOptions {
                miss_passthrough: true,
            },
        )
        .await
        .unwrap();

        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(empty_url.as_str())
        );
        assert_eq!(
            manifest.storages[1].archive_url.as_deref(),
            Some(oversized_url.as_str())
        );
        assert!(empty_dir.join("archive.tar.gz").exists());
        assert!(oversized_dir.join("archive.tar.gz").exists());
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, "storage_cache_passthrough_miss_count_2", true);
        assert_op_count(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, 2);
        assert_no_op(&ops, "storage_cache_skipped_over_size");
        assert_no_op(&ops, "storage_cache_miss");
    }

    #[tokio::test]
    async fn guarded_same_key_duplicate_misses_preserve_each_original_url() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let name = "guarded-duplicate";
        let version = "v1";
        let first_url = "https://r2.example.com/first.tar.gz".to_string();
        let second_url = "https://mirror.example.com/second.tar.gz".to_string();
        let mut manifest =
            manifest_duplicate_storages(first_url.clone(), second_url.clone(), name, version);

        populate_cache_with_options(
            &mut manifest,
            &sandbox,
            &home,
            &mut telemetry,
            StorageCacheOptions {
                miss_passthrough: true,
            },
        )
        .await
        .unwrap();

        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(first_url.as_str())
        );
        assert_eq!(
            manifest.storages[1].archive_url.as_deref(),
            Some(second_url.as_str())
        );
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, "storage_cache_passthrough_miss_count_2", true);
        assert_op_count(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, 2);
        assert_no_op(&ops, "storage_cache_miss");
    }

    #[tokio::test]
    async fn guarded_artifact_miss_passthrough_keeps_url() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let name = "guarded-artifact";
        let version = "v1";
        let original = "https://r2.example.com/artifact.tar.gz".to_string();
        let mut manifest = manifest_single_artifact(original.clone(), name, version);

        populate_cache_with_options(
            &mut manifest,
            &sandbox,
            &home,
            &mut telemetry,
            StorageCacheOptions {
                miss_passthrough: true,
            },
        )
        .await
        .unwrap();

        assert_eq!(
            manifest.artifacts[0].archive_url.as_deref(),
            Some(original.as_str())
        );
        assert!(!home.storage_cache_dir(name, version).exists());
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, true);
        assert_no_op(&ops, "storage_cache_miss");
    }

    #[tokio::test]
    async fn guarded_lock_busy_passthrough_does_not_wait_for_writer() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let name = "guarded-busy";
        let version = "v1";
        let original = "https://r2.example.com/busy.tar.gz".to_string();
        let _writer = lock::acquire(home.storage_lock(name, version))
            .await
            .unwrap();
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        populate_cache_with_options(
            &mut manifest,
            &sandbox,
            &home,
            &mut telemetry,
            StorageCacheOptions {
                miss_passthrough: true,
            },
        )
        .await
        .unwrap();

        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(original.as_str())
        );
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_LOCK_BUSY_PASSTHROUGH, true);
        assert_op(&ops, "storage_cache_passthrough_lock_busy_count_1", true);
        assert_no_op(&ops, STORAGE_CACHE_MISS_PASSTHROUGH);
        assert_no_op(&ops, "storage_cache_miss");
    }

    #[tokio::test]
    async fn warm_hits_are_staged_in_one_guest_batch() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let body = tarball_bytes();
        let first_name = "warm-batch-a";
        let second_name = "warm-batch-b";
        let version = "v1";
        write_cached_archive(&home, first_name, version, &body);
        write_cached_archive(&home, second_name, version, &body);

        let mut manifest = GuestDownloadManifest {
            storages: vec![
                GuestDownloadStorageEntry {
                    mount_path: "/mnt/a".into(),
                    archive_url: Some("https://r2.example.com/a.tar.gz".into()),
                    cached: false,
                    instructions_target_filename: None,
                    vas_storage_name: first_name.to_string(),
                    vas_version_id: version.to_string(),
                },
                GuestDownloadStorageEntry {
                    mount_path: "/mnt/b".into(),
                    archive_url: Some("https://r2.example.com/b.tar.gz".into()),
                    cached: false,
                    instructions_target_filename: None,
                    vas_storage_name: second_name.to_string(),
                    vas_version_id: version.to_string(),
                },
            ],
            artifacts: Vec::new(),
            cleanup_paths: Vec::new(),
        };

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        let batches = sandbox.write_files_calls();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].files.len(), 2);
        let staged_paths = batches[0]
            .files
            .iter()
            .map(|file| file.path.clone())
            .collect::<HashSet<_>>();
        assert_eq!(
            staged_paths,
            HashSet::from([
                guest_archive_path(first_name, version),
                guest_archive_path(second_name, version),
            ])
        );
        assert_eq!(sandbox.write_file_calls().len(), 2);
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_STAGE_TOTAL, true);
        assert_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE, true);
        assert_no_op(&ops, STORAGE_CACHE_STAGE_SINGLE_WRITE);
        let ops_with_duration = telemetry.pending_ops_with_duration_snapshot();
        assert_eq!(
            op_duration_ms(&ops_with_duration, STORAGE_CACHE_STAGE_TOTAL),
            op_duration_ms(&ops_with_duration, STORAGE_CACHE_STAGE_BATCH_WRITE),
            "pure batch staging total should equal the batch guest write duration in {ops_with_duration:?}"
        );
    }

    #[tokio::test]
    async fn warm_hit_batch_stage_failure_records_failed_staging_telemetry() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        sandbox.push_write_file_result(Err(sandbox_write_file_error("vsock write failed")));
        let mut telemetry = new_telemetry();

        let name = "warm-batch-fail";
        let version = "v1";
        let original = "https://r2.example.com/fail.tar.gz".to_string();
        write_cached_archive(&home, name, version, &tarball_bytes());
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        let err = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap_err();

        assert!(err.to_string().contains("vsock write failed"), "got: {err}");
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(original.as_str())
        );

        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE, false);
        assert_op(&ops, STORAGE_CACHE_STAGE_TOTAL, false);
        assert_op_error(
            &ops,
            STORAGE_CACHE_STAGE_BATCH_WRITE,
            STORAGE_CACHE_STAGE_FAILED,
        );
        assert_op_error(&ops, STORAGE_CACHE_STAGE_TOTAL, STORAGE_CACHE_STAGE_FAILED);
        assert_no_op(&ops, STORAGE_CACHE_STAGE_SINGLE_WRITE);
        assert_no_op(&ops, "storage_cache_hit");
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
        assert_op(&ops, STORAGE_CACHE_STAGE_TOTAL, true);
        assert_op(&ops, STORAGE_CACHE_STAGE_SINGLE_WRITE, true);
        assert_no_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE);
        let ops_with_duration = telemetry.pending_ops_with_duration_snapshot();
        assert_eq!(
            op_duration_ms(&ops_with_duration, STORAGE_CACHE_STAGE_TOTAL),
            op_duration_ms(&ops_with_duration, STORAGE_CACHE_STAGE_SINGLE_WRITE),
            "single-write staging total should equal the single guest write duration in {ops_with_duration:?}"
        );
        assert!(ops.iter().any(|(k, _, _)| k == "storage_cache_miss"));
        assert!(ops.iter().any(|(k, _, _)| k == "storage_cache_download"));
        assert_op(&ops, STORAGE_CACHE_PROCESS_GROUP, true);
        assert_op(&ops, STORAGE_CACHE_LOCK_WAIT, true);
        assert_op_count(&ops, STORAGE_CACHE_PROCESS_GROUP, 1);
        assert_op_count(&ops, STORAGE_CACHE_LOCK_WAIT, 2);
        assert_no_op(&ops, STORAGE_CACHE_HIT_READ);
    }

    #[tokio::test]
    async fn probe_transient_status_retry_then_success_rewrites_url() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let body = tarball_bytes();
        let responses = vec![
            status_response("500 Internal Server Error"),
            partial_content_response(body.len()),
            ok_response(&body),
        ];
        let (url, handle) = raw_http_sequence_url(responses).await;
        let name = "probe-retry-success";
        let version = "v1";
        let mut manifest = manifest_single_storage(url, name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();
        await_raw_http_sequence(handle).await;

        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        assert_eq!(
            std::fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz")).unwrap(),
            body
        );
        assert_eq!(sandbox.write_file_calls().len(), 1);
        let ops = telemetry.pending_ops_snapshot();
        assert!(ops.iter().any(|(key, _, _)| key == "storage_cache_miss"));
        assert_no_op(&ops, "storage_cache_skipped_head_failed");
    }

    #[tokio::test]
    async fn probe_client_error_does_not_retry() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/forbidden.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(403);
            })
            .await;
        let full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/forbidden.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let original = server.url("/forbidden.tar.gz");
        let name = "probe-client-error";
        let version = "v1";
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        probe.assert_calls_async(1).await;
        full.assert_calls_async(0).await;
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(original.as_str())
        );
        assert!(sandbox.write_file_calls().is_empty());
        let ops = telemetry.pending_ops_snapshot();
        let reason = ops
            .iter()
            .find(|(key, _, _)| key == "storage_cache_skipped_head_failed")
            .and_then(|(_, _, error)| error.as_deref())
            .expect("expected storage_cache_skipped_head_failed reason");
        assert!(reason.contains("403"), "expected 403 in reason: {reason}");
        assert!(
            !reason.contains("retry exhausted"),
            "4xx errors must not retry: {reason}"
        );
    }

    #[tokio::test]
    async fn probe_builder_error_does_not_retry() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let original = "not-a-url".to_string();
        let name = "probe-builder-error";
        let version = "v1";
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(original.as_str())
        );
        assert!(sandbox.write_file_calls().is_empty());
        let ops = telemetry.pending_ops_snapshot();
        let reason = ops
            .iter()
            .find(|(key, _, _)| key == "storage_cache_skipped_head_failed")
            .and_then(|(_, _, error)| error.as_deref())
            .expect("expected storage_cache_skipped_head_failed reason");
        assert!(
            !reason.contains("retry exhausted"),
            "builder errors must not retry: {reason}"
        );
    }

    #[tokio::test]
    async fn full_download_transient_status_retry_then_success_rewrites_url() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let body = tarball_bytes();
        let responses = vec![
            partial_content_response(body.len()),
            status_response("503 Service Unavailable"),
            ok_response(&body),
        ];
        let (url, handle) = raw_http_sequence_url(responses).await;
        let name = "download-retry-success";
        let version = "v1";
        let mut manifest = manifest_single_storage(url, name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();
        await_raw_http_sequence(handle).await;

        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        assert_eq!(
            std::fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz")).unwrap(),
            body
        );
        assert_eq!(sandbox.write_file_calls().len(), 1);
        let ops = telemetry.pending_ops_snapshot();
        assert!(ops.iter().any(|(key, _, _)| key == "storage_cache_miss"));
        assert_no_op(&ops, "storage_cache_skipped_invalid_download");
    }

    #[tokio::test]
    async fn full_download_body_read_error_retry_then_success_rewrites_url() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let body = tarball_bytes();
        let responses = vec![
            partial_content_response(body.len()),
            truncated_ok_response(&body),
            ok_response(&body),
        ];
        let (url, handle) = raw_http_sequence_url(responses).await;
        let name = "download-body-retry-success";
        let version = "v1";
        let mut manifest = manifest_single_storage(url, name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();
        await_raw_http_sequence(handle).await;

        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        assert_eq!(
            std::fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz")).unwrap(),
            body
        );
        assert_eq!(sandbox.write_file_calls().len(), 1);
        let ops = telemetry.pending_ops_snapshot();
        assert!(ops.iter().any(|(key, _, _)| key == "storage_cache_miss"));
        assert_no_op(&ops, "storage_cache_skipped_invalid_download");
    }

    #[tokio::test]
    async fn full_download_client_error_does_not_retry() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/download-forbidden.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/download-forbidden.tar.gz")
                    .header_missing("range");
                then.status(403);
            })
            .await;

        let original = format!(
            "{}?X-Amz-Signature=secret&X-Amz-Credential=credential",
            server.url("/download-forbidden.tar.gz")
        );
        let name = "download-client-error";
        let version = "v1";
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        probe.assert_async().await;
        full.assert_calls_async(1).await;
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(original.as_str())
        );
        assert!(sandbox.write_file_calls().is_empty());
        let ops = telemetry.pending_ops_snapshot();
        let reason = ops
            .iter()
            .find(|(key, _, _)| key == "storage_cache_skipped_invalid_download")
            .and_then(|(_, _, error)| error.as_deref())
            .expect("expected storage_cache_skipped_invalid_download reason");
        assert!(reason.contains("403"), "expected 403 in reason: {reason}");
        assert!(
            !reason.contains("retry exhausted"),
            "4xx errors must not retry: {reason}"
        );
        assert!(
            !reason.contains("X-Amz-Signature")
                && !reason.contains("secret")
                && !reason.contains("credential")
                && !reason.contains("/download-forbidden.tar.gz"),
            "telemetry error must not include presigned URL details: {reason}"
        );
    }

    #[tokio::test]
    async fn full_download_retry_exhaustion_is_passthrough() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/download-fails.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/download-fails.tar.gz")
                    .header_missing("range");
                then.status(503);
            })
            .await;

        let original = format!(
            "{}?X-Amz-Signature=secret&X-Amz-Credential=credential",
            server.url("/download-fails.tar.gz")
        );
        let name = "download-retry-exhausted";
        let version = "v1";
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        probe.assert_async().await;
        full.assert_calls_async(CACHE_HTTP_MAX_ATTEMPTS).await;
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(original.as_str())
        );
        assert!(sandbox.write_file_calls().is_empty());
        assert!(
            !home
                .storage_cache_dir(name, version)
                .join("archive.tar.gz")
                .exists()
        );
        let ops = telemetry.pending_ops_snapshot();
        let reason = ops
            .iter()
            .find(|(key, _, _)| key == "storage_cache_skipped_invalid_download")
            .and_then(|(_, _, error)| error.as_deref())
            .expect("expected storage_cache_skipped_invalid_download reason");
        assert!(
            reason.contains("retry exhausted after 3 attempts") && reason.contains("503"),
            "unexpected retry exhaustion reason: {reason}"
        );
        assert!(
            !reason.contains("X-Amz-Signature")
                && !reason.contains("secret")
                && !reason.contains("credential")
                && !reason.contains("/download-fails.tar.gz"),
            "telemetry error must not include presigned URL details: {reason}"
        );
    }

    #[tokio::test]
    async fn miss_path_single_stage_failure_records_failed_staging_telemetry() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        sandbox.push_write_file_result(Err(sandbox_write_file_error("single write failed")));
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

        let original = server.url("/archive.tar.gz");
        let name = "single-stage-fail";
        let version = "v1";
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        let err = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap_err();

        probe.assert_async().await;
        get.assert_async().await;
        assert!(
            err.to_string().contains("single write failed"),
            "got: {err}"
        );
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(original.as_str())
        );
        assert_eq!(
            std::fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz")).unwrap(),
            body
        );

        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_STAGE_SINGLE_WRITE, false);
        assert_op(&ops, STORAGE_CACHE_STAGE_TOTAL, false);
        assert_op_error(
            &ops,
            STORAGE_CACHE_STAGE_SINGLE_WRITE,
            STORAGE_CACHE_STAGE_FAILED,
        );
        assert_op_error(&ops, STORAGE_CACHE_STAGE_TOTAL, STORAGE_CACHE_STAGE_FAILED);
        assert_no_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE);
        assert_no_op(&ops, "storage_cache_miss");
        assert_no_op(&ops, "storage_cache_download");
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
        assert_no_op(&ops, STORAGE_CACHE_STAGE_TOTAL);
        assert_no_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE);
        assert_no_op(&ops, STORAGE_CACHE_STAGE_SINGLE_WRITE);
        assert!(
            ops.iter()
                .any(|(k, _, _)| k == "storage_cache_skipped_over_size")
        );
    }

    #[tokio::test]
    async fn full_download_over_probe_limit_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        sandbox.push_write_file_result(Err(sandbox_write_file_error("unexpected archive write")));
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
        assert!(
            sandbox.write_file("/tmp/sentinel", b"x").await.is_err(),
            "queued write_file error should remain if archive write was not attempted"
        );
    }

    #[tokio::test]
    async fn empty_full_download_is_passthrough_without_cache_write() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/empty-body.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", "bytes 0-0/1")
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/empty-body.tar.gz")
                    .header_missing("range");
                then.status(200).body(Vec::<u8>::new());
            })
            .await;

        let original = server.url("/empty-body.tar.gz");
        let name = "empty-body";
        let version = "v1";
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        probe.assert_async().await;
        get.assert_async().await;
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
        assert!(sandbox.write_file_calls().is_empty());
        let ops = telemetry.pending_ops_snapshot();
        assert_storage_cache_skipped_invalid_download(&ops, "empty-download");
    }

    #[tokio::test]
    async fn non_tar_full_download_is_cached_as_opaque_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = b"not a valid tar.gz".to_vec();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/invalid-body.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/invalid-body.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let original = server.url("/invalid-body.tar.gz");
        let name = "invalid-body";
        let version = "v1";
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        probe.assert_async().await;
        get.assert_async().await;
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        assert_eq!(
            std::fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz")).unwrap(),
            body
        );
        let writes = sandbox.write_file_calls();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].path, guest_archive_path(name, version));
        assert_eq!(writes[0].content, body);
        let ops = telemetry.pending_ops_snapshot();
        assert!(ops.iter().any(|(k, _, _)| k == "storage_cache_miss"));
        assert_no_op(&ops, "storage_cache_skipped_invalid_download");
    }

    #[tokio::test]
    async fn shorter_full_download_is_passthrough_without_cache_write() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/short-body.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len() + 1))
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/short-body.tar.gz")
                    .header_missing("range");
                then.status(200).body(body);
            })
            .await;

        let original = server.url("/short-body.tar.gz");
        let name = "short-body";
        let version = "v1";
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        probe.assert_async().await;
        get.assert_async().await;
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
        assert!(sandbox.write_file_calls().is_empty());
        let ops = telemetry.pending_ops_snapshot();
        assert_storage_cache_skipped_invalid_download(&ops, "size-mismatch");
    }

    #[tokio::test]
    async fn longer_full_download_within_limit_is_passthrough_without_cache_write() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/long-body.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", "bytes 0-0/1")
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/long-body.tar.gz")
                    .header_missing("range");
                then.status(200).body(body);
            })
            .await;

        let original = server.url("/long-body.tar.gz");
        let name = "long-body";
        let version = "v1";
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        probe.assert_async().await;
        get.assert_async().await;
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
        assert!(sandbox.write_file_calls().is_empty());
        let ops = telemetry.pending_ops_snapshot();
        assert_storage_cache_skipped_invalid_download(&ops, "size-mismatch");
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
    async fn empty_disk_hit_is_evicted_and_revalidated() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let name = "empty-hit";
        let version = "v1";
        let cache_dir = home.storage_cache_dir(name, version);
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::write(cache_dir.join("archive.tar.gz"), b"").unwrap();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/empty-revalidated.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/empty-revalidated.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let url = server.url("/empty-revalidated.tar.gz");
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
            "empty cache file must not be treated as a hit: {ops:?}"
        );
    }

    #[tokio::test]
    async fn non_tar_disk_hit_is_staged_without_revalidation() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = b"not a valid tar.gz".to_vec();

        let name = "non-tar-hit";
        let version = "v1";
        let cache_dir = home.storage_cache_dir(name, version);
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::write(cache_dir.join("archive.tar.gz"), &body).unwrap();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/should-not-revalidate.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/should-not-revalidate.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let url = server.url("/should-not-revalidate.tar.gz");
        let mut manifest = manifest_single_storage(url, name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        probe.assert_calls_async(0).await;
        get.assert_calls_async(0).await;
        assert_eq!(
            std::fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz")).unwrap(),
            body
        );
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        let batches = sandbox.write_files_calls();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].files.len(), 1);
        assert_eq!(batches[0].files[0].path, guest_archive_path(name, version));
        assert_eq!(batches[0].files[0].content, body);
        let ops = telemetry.pending_ops_snapshot();
        assert!(
            ops.iter().any(|(k, _, _)| k == "storage_cache_hit"),
            "expected cache hit in {ops:?}"
        );
        assert!(
            !ops.iter().any(|(k, _, _)| k == "storage_cache_miss"),
            "non-tar cache file must not be revalidated: {ops:?}"
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
                missing_root_policy: None,
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
    async fn probe_retry_exhaustion_is_passthrough() {
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

        probe.assert_calls_async(CACHE_HTTP_MAX_ATTEMPTS).await;

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
            error.contains("retry exhausted after 3 attempts") && error.contains("500"),
            "unexpected retry exhaustion reason: {error}"
        );
        assert!(
            !error.contains("X-Amz-Signature")
                && !error.contains("secret")
                && !error.contains("credential")
                && !error.contains("/broken.tar.gz"),
            "telemetry error must not include presigned URL details: {error}"
        );
    }

    #[tokio::test]
    async fn probe_transport_retry_exhaustion_is_sanitized_passthrough() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let responses = vec![Vec::new(); CACHE_HTTP_MAX_ATTEMPTS];
        let (url, handle) = raw_http_sequence_url(responses).await;

        let original = format!("{url}?X-Amz-Signature=secret&X-Amz-Credential=credential");
        let name = "transport-retry-exhausted";
        let version = "v1";
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();
        await_raw_http_sequence(handle).await;

        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(original.as_str())
        );
        assert!(sandbox.write_file_calls().is_empty());
        let ops = telemetry.pending_ops_snapshot();
        let (_, _, error) = ops
            .iter()
            .find(|(k, _, _)| k == "storage_cache_skipped_head_failed")
            .expect("expected skipped head telemetry");
        let error = error.as_deref().expect("expected telemetry error reason");
        assert!(
            error.contains("retry exhausted after 3 attempts"),
            "unexpected retry exhaustion reason: {error}"
        );
        assert!(
            !error.contains("X-Amz-Signature")
                && !error.contains("secret")
                && !error.contains("credential")
                && !error.contains("/archive.tar.gz"),
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
        assert_eq!(result, SizeProbe::Known(advertised_size));
    }

    #[tokio::test]
    async fn probe_200_rejects_malformed_content_length() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Length: +7\r\n\r\n".to_vec();
        let (url, handle) = raw_http_url(response).await;

        let http = Client::builder().build().unwrap();
        let result = probe_size(&http, &url).await;

        handle.await.unwrap().unwrap();
        match result {
            Ok(SizeProbe::Unknown(SizeProbeUnknown::InvalidSizeHeader)) => {}
            Err(err) => assert!(err.to_string().contains("probe GET"), "got: {err}"),
            other => panic!("malformed Content-Length must not become a known size: {other:?}"),
        }
    }

    #[tokio::test]
    async fn probe_200_malformed_content_length_is_passthrough() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let response = b"HTTP/1.1 200 OK\r\nContent-Length: +7\r\n\r\n".to_vec();
        let (original, handle) = raw_http_url(response).await;
        let name = "malformed-length";
        let version = "v1";
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        handle.await.unwrap().unwrap();
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
        assert!(sandbox.write_file_calls().is_empty());
        let ops = telemetry.pending_ops_snapshot();
        let reason = ops
            .iter()
            .find(|(k, _, _)| k == "storage_cache_skipped_head_failed")
            .and_then(|(_, _, error)| error.as_deref())
            .expect("expected storage_cache_skipped_head_failed reason");
        assert!(
            reason == "invalid-size-header" || reason.contains("probe GET"),
            "unexpected malformed Content-Length reason: {reason}"
        );
    }

    #[tokio::test]
    async fn probe_200_zero_content_length_is_passthrough() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/zero-length.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(200).header("content-length", "0");
            })
            .await;
        let full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/zero-length.tar.gz")
                    .header_missing("range");
                then.status(200).body(tarball_bytes());
            })
            .await;

        let original = server.url("/zero-length.tar.gz");
        let name = "zero-length";
        let version = "v1";
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        probe.assert_async().await;
        full.assert_calls_async(0).await;
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
        let ops = telemetry.pending_ops_snapshot();
        assert_storage_cache_skipped_reason(&ops, "invalid-size-header");
    }

    #[tokio::test]
    async fn probe_non_ok_success_status_is_passthrough() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/no-content.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(204).header("content-length", "0");
            })
            .await;
        let full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/no-content.tar.gz")
                    .header_missing("range");
                then.status(200).body(tarball_bytes());
            })
            .await;

        let original = server.url("/no-content.tar.gz");
        let name = "no-content";
        let version = "v1";
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        probe.assert_async().await;
        full.assert_calls_async(0).await;
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
        let ops = telemetry.pending_ops_snapshot();
        assert_storage_cache_skipped_reason_contains(&ops, "204");
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
        assert_eq!(result, SizeProbe::Known(total_size));
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
            DownloadBody::Empty => panic!("content-length over limit must not be empty"),
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
            DownloadBody::Empty => panic!("stream over limit must not be empty"),
            DownloadBody::OverSize { observed_size } => assert_eq!(observed_size, 7),
        }
    }

    #[tokio::test]
    async fn cached_archive_read_rejects_one_byte_over_limit() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("archive.tar.gz");
        fs::write(&archive_path, b"abcdefg").await.unwrap();

        let result = read_cached_archive(&archive_path, 6).await.unwrap();

        match result {
            DownloadBody::Complete(bytes) => {
                panic!(
                    "cached file over limit should be rejected, read {} bytes",
                    bytes.len()
                )
            }
            DownloadBody::Empty => panic!("cached file over limit must not be empty"),
            DownloadBody::OverSize { observed_size } => assert_eq!(observed_size, 7),
        }
    }

    #[tokio::test]
    async fn warmed_cache_hits_do_not_serialize_guest_writes_across_sandboxes() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let name = "warm-shared";
        let version = "v1";
        write_cached_archive(&home, name, version, &tarball_bytes());

        let sandbox_a = Arc::new(MockSandbox::new("test-a"));
        let sandbox_b = Arc::new(MockSandbox::new("test-b"));
        let gate_a = MockLifecycleGate::new();
        let gate_b = MockLifecycleGate::new();
        sandbox_a.set_write_file_lifecycle_gate(gate_a.clone());
        sandbox_b.set_write_file_lifecycle_gate(gate_b.clone());

        let task_a = {
            let home = home.clone();
            let sandbox = Arc::clone(&sandbox_a);
            tokio::spawn(async move {
                let mut manifest = manifest_single_storage(
                    "https://r2.example.com/ignored-a.tar.gz".to_string(),
                    name,
                    version,
                );
                let mut telemetry = new_telemetry();
                populate_cache(&mut manifest, sandbox.as_ref(), &home, &mut telemetry)
                    .await
                    .unwrap();
                manifest
            })
        };
        gate_a
            .wait_entered(1, Duration::from_secs(5))
            .await
            .unwrap();
        assert!(
            !task_a.is_finished(),
            "first guest write should wait on its sandbox gate"
        );

        let task_b = {
            let home = home.clone();
            let sandbox = Arc::clone(&sandbox_b);
            tokio::spawn(async move {
                let mut manifest = manifest_single_storage(
                    "https://r2.example.com/ignored-b.tar.gz".to_string(),
                    name,
                    version,
                );
                let mut telemetry = new_telemetry();
                populate_cache(&mut manifest, sandbox.as_ref(), &home, &mut telemetry)
                    .await
                    .unwrap();
                manifest
            })
        };
        gate_b
            .wait_entered(1, Duration::from_secs(5))
            .await
            .unwrap();

        gate_b.release_one();
        let manifest_b = task_b.await.unwrap();
        gate_a.release_one();
        let manifest_a = task_a.await.unwrap();

        let expected = format!("file://{}", guest_archive_path(name, version));
        assert_eq!(
            manifest_a.storages[0].archive_url.as_deref(),
            Some(expected.as_str())
        );
        assert_eq!(
            manifest_b.storages[0].archive_url.as_deref(),
            Some(expected.as_str())
        );
    }

    #[tokio::test]
    async fn slow_guest_staging_does_not_pause_in_flight_cache_population() {
        async fn read_request(socket: &mut tokio::net::TcpStream) -> std::io::Result<String> {
            let mut request = Vec::new();
            let mut buf = [0u8; 1024];
            loop {
                let n = socket.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buf[..n]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            Ok(String::from_utf8_lossy(&request).into_owned())
        }

        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = Arc::new(MockSandbox::new("test"));
        let gate = MockLifecycleGate::new();
        sandbox.set_write_file_lifecycle_gate(gate.clone());

        let ready_name = "ready-stages-while-cold-in-flight";
        let cold_name = "cold-continues-while-stage-blocked";
        let version = "v1";

        let ready_body = tarball_bytes();
        let cold_body = tarball_bytes();
        let ready_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ready_addr = ready_listener.local_addr().unwrap();
        let cold_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let cold_addr = cold_listener.local_addr().unwrap();
        let (allow_ready_tx, allow_ready_rx) = tokio::sync::oneshot::channel::<()>();
        let (cold_probe_seen_tx, cold_probe_seen_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_cold_probe_tx, release_cold_probe_rx) = tokio::sync::oneshot::channel::<()>();
        let (cold_full_seen_tx, cold_full_seen_rx) = tokio::sync::oneshot::channel::<()>();

        let ready_server_task = tokio::spawn(async move {
            let (mut probe_socket, _) = ready_listener.accept().await?;
            let probe_request = read_request(&mut probe_socket).await?;
            assert!(
                probe_request
                    .to_ascii_lowercase()
                    .contains("range: bytes=0-0"),
                "expected range probe, got {probe_request:?}"
            );
            let _ = allow_ready_rx.await;
            probe_socket
                .write_all(
                    format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx",
                        ready_body.len()
                    )
                    .as_bytes(),
                )
                .await?;
            drop(probe_socket);

            let (mut full_socket, _) = ready_listener.accept().await?;
            let full_request = read_request(&mut full_socket).await?;
            assert!(
                !full_request
                    .to_ascii_lowercase()
                    .contains("range: bytes=0-0"),
                "expected full download, got {full_request:?}"
            );
            full_socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        ready_body.len()
                    )
                    .as_bytes(),
                )
                .await?;
            full_socket.write_all(&ready_body).await?;
            Ok::<(), std::io::Error>(())
        });

        let cold_server_task = tokio::spawn(async move {
            let (mut probe_socket, _) = cold_listener.accept().await?;
            let probe_request = read_request(&mut probe_socket).await?;
            assert!(
                probe_request
                    .to_ascii_lowercase()
                    .contains("range: bytes=0-0"),
                "expected range probe, got {probe_request:?}"
            );
            let _ = cold_probe_seen_tx.send(());
            let _ = release_cold_probe_rx.await;
            probe_socket
                .write_all(
                    format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx",
                        cold_body.len()
                    )
                    .as_bytes(),
                )
                .await?;
            drop(probe_socket);

            let (mut full_socket, _) = cold_listener.accept().await?;
            let full_request = read_request(&mut full_socket).await?;
            assert!(
                !full_request
                    .to_ascii_lowercase()
                    .contains("range: bytes=0-0"),
                "expected full download, got {full_request:?}"
            );
            full_socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        cold_body.len()
                    )
                    .as_bytes(),
                )
                .await?;
            full_socket.write_all(&cold_body).await?;
            let _ = cold_full_seen_tx.send(());
            Ok::<(), std::io::Error>(())
        });

        let task = {
            let home = home.clone();
            let sandbox = Arc::clone(&sandbox);
            tokio::spawn(async move {
                let mut manifest = GuestDownloadManifest {
                    storages: vec![
                        GuestDownloadStorageEntry {
                            mount_path: "/mnt/ready".into(),
                            archive_url: Some(format!("http://{ready_addr}/ready.tar.gz")),
                            cached: false,
                            instructions_target_filename: None,
                            vas_storage_name: ready_name.to_string(),
                            vas_version_id: version.to_string(),
                        },
                        GuestDownloadStorageEntry {
                            mount_path: "/mnt/cold".into(),
                            archive_url: Some(format!("http://{cold_addr}/cold.tar.gz")),
                            cached: false,
                            instructions_target_filename: None,
                            vas_storage_name: cold_name.to_string(),
                            vas_version_id: version.to_string(),
                        },
                    ],
                    artifacts: Vec::new(),
                    cleanup_paths: Vec::new(),
                };
                let mut telemetry = new_telemetry();
                populate_cache(&mut manifest, sandbox.as_ref(), &home, &mut telemetry).await?;
                Ok::<GuestDownloadManifest, RunnerError>(manifest)
            })
        };

        tokio::time::timeout(Duration::from_secs(5), cold_probe_seen_rx)
            .await
            .expect("cold worker should start the probe")
            .unwrap();
        allow_ready_tx.send(()).unwrap();
        gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
        release_cold_probe_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), cold_full_seen_rx)
            .await
            .expect("cold worker should continue while guest staging is blocked")
            .unwrap();

        let cold_lock = tokio::time::timeout(
            Duration::from_secs(5),
            lock::acquire(home.storage_lock(cold_name, version)),
        )
        .await
        .expect("cold worker should release the host cache lock before guest staging unblocks")
        .unwrap();
        drop(cold_lock);

        gate.release_one();
        gate.wait_entered(2, Duration::from_secs(5)).await.unwrap();
        gate.release_one();
        let manifest = task.await.unwrap().unwrap();
        ready_server_task.await.unwrap().unwrap();
        cold_server_task.await.unwrap().unwrap();

        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(format!("file://{}", guest_archive_path(ready_name, version)).as_str())
        );
        assert_eq!(
            manifest.storages[1].archive_url.as_deref(),
            Some(format!("file://{}", guest_archive_path(cold_name, version)).as_str())
        );
    }

    #[tokio::test]
    async fn duplicate_same_key_targets_share_one_guest_path_write() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let name = "duplicate-key";
        let version = "v1";
        write_cached_archive(&home, name, version, &tarball_bytes());

        let sandbox = Arc::new(SamePathConcurrentWriteDetectingSandbox::new("test"));
        let gate = sandbox.gate();

        let task = {
            let home = home.clone();
            let sandbox = Arc::clone(&sandbox);
            tokio::spawn(async move {
                let mut manifest = manifest_duplicate_storages(
                    "https://r2.example.com/duplicate-a.tar.gz".into(),
                    "https://r2.example.com/duplicate-b.tar.gz".into(),
                    name,
                    version,
                );
                let mut telemetry = new_telemetry();
                populate_cache(&mut manifest, sandbox.as_ref(), &home, &mut telemetry).await?;
                Ok::<GuestDownloadManifest, RunnerError>(manifest)
            })
        };

        gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
        assert_eq!(
            sandbox.write_file_calls().len(),
            1,
            "duplicate same-key guest path write should be blocked in the sandbox"
        );

        gate.release_one();
        let manifest = task.await.unwrap().unwrap();
        assert_eq!(
            sandbox.write_file_calls().len(),
            1,
            "duplicate same-key targets should share one guest write"
        );

        let expected = format!("file://{}", guest_archive_path(name, version));
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(expected.as_str())
        );
        assert_eq!(
            manifest.storages[1].archive_url.as_deref(),
            Some(expected.as_str())
        );
    }

    #[tokio::test]
    async fn duplicate_same_key_cold_miss_downloads_and_stages_once() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/duplicate-a.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/duplicate-a.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;
        let unused_probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/duplicate-b.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let unused_full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/duplicate-b.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let name = "duplicate-miss";
        let version = "v1";
        let mut manifest = manifest_duplicate_storages(
            server.url("/duplicate-a.tar.gz"),
            server.url("/duplicate-b.tar.gz"),
            name,
            version,
        );

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        probe.assert_async().await;
        full.assert_async().await;
        unused_probe.assert_calls_async(0).await;
        unused_full.assert_calls_async(0).await;
        assert_eq!(
            sandbox.write_file_calls().len(),
            1,
            "duplicate same-key cold miss should stage one guest archive"
        );

        let expected = format!("file://{}", guest_archive_path(name, version));
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(expected.as_str())
        );
        assert_eq!(
            manifest.storages[1].archive_url.as_deref(),
            Some(expected.as_str())
        );

        let ops = telemetry.pending_ops_snapshot();
        assert_eq!(
            ops.iter()
                .filter(|(key, _, _)| key == "storage_cache_miss")
                .count(),
            1,
            "expected one representative miss in {ops:?}"
        );
        assert_eq!(
            ops.iter()
                .filter(|(key, _, _)| key == "storage_cache_download")
                .count(),
            1,
            "expected one representative download in {ops:?}"
        );
        assert_eq!(
            ops.iter()
                .filter(|(key, _, _)| key == "storage_cache_hit")
                .count(),
            1,
            "expected one hit-equivalent duplicate target in {ops:?}"
        );
    }

    #[tokio::test]
    async fn duplicate_storage_and_artifact_key_share_warmed_guest_write() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        let name = "shared-storage-artifact";
        let version = "v1";
        write_cached_archive(&home, name, version, &tarball_bytes());

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
                vas_storage_id: "storage-id".into(),
                vas_version_id: version.to_string(),
                missing_root_policy: None,
            }],
            cleanup_paths: Vec::new(),
        };

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        assert_eq!(
            sandbox.write_file_calls().len(),
            1,
            "storage and artifact targets with the same key should share one guest write"
        );
        let expected = format!("file://{}", guest_archive_path(name, version));
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(expected.as_str())
        );
        assert_eq!(
            manifest.artifacts[0].archive_url.as_deref(),
            Some(expected.as_str())
        );

        let ops = telemetry.pending_ops_snapshot();
        assert_eq!(
            ops.iter()
                .filter(|(key, _, _)| key == "storage_cache_hit")
                .count(),
            2,
            "expected entry-level hit telemetry for both duplicate targets in {ops:?}"
        );
    }

    #[tokio::test]
    async fn duplicate_same_key_probe_failure_falls_back_to_next_target() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let failed_probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/probe-fails.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(500);
            })
            .await;
        let failed_full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/probe-fails.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;
        let successful_probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/probe-succeeds.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let successful_full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/probe-succeeds.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let name = "probe-fallback";
        let version = "v1";
        let mut manifest = manifest_duplicate_storages(
            server.url("/probe-fails.tar.gz"),
            server.url("/probe-succeeds.tar.gz"),
            name,
            version,
        );

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        failed_probe
            .assert_calls_async(CACHE_HTTP_MAX_ATTEMPTS)
            .await;
        failed_full.assert_calls_async(0).await;
        successful_probe.assert_async().await;
        successful_full.assert_async().await;
        assert_eq!(
            sandbox.write_file_calls().len(),
            1,
            "fallback target should stage one guest archive for the whole group"
        );

        let expected = format!("file://{}", guest_archive_path(name, version));
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(expected.as_str())
        );
        assert_eq!(
            manifest.storages[1].archive_url.as_deref(),
            Some(expected.as_str())
        );

        let ops = telemetry.pending_ops_snapshot();
        assert_eq!(
            ops.iter()
                .filter(|(key, _, _)| key == "storage_cache_miss")
                .count(),
            1,
            "expected one successful representative miss in {ops:?}"
        );
        assert!(
            !ops.iter()
                .any(|(key, _, _)| key == "storage_cache_skipped_head_failed"),
            "transient representative probe failure should not be the final group outcome: {ops:?}"
        );
    }

    #[tokio::test]
    async fn duplicate_same_key_invalid_download_falls_back_to_next_target() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let invalid_probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/invalid-download.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let invalid_full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/invalid-download.tar.gz")
                    .header_missing("range");
                then.status(200);
            })
            .await;
        let successful_probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/valid-download.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let successful_full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/valid-download.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let name = "download-fallback";
        let version = "v1";
        let mut manifest = manifest_duplicate_storages(
            server.url("/invalid-download.tar.gz"),
            server.url("/valid-download.tar.gz"),
            name,
            version,
        );

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        invalid_probe.assert_async().await;
        invalid_full.assert_async().await;
        successful_probe.assert_async().await;
        successful_full.assert_async().await;
        assert_eq!(
            sandbox.write_file_calls().len(),
            1,
            "fallback target should stage one guest archive for the whole group"
        );

        let expected = format!("file://{}", guest_archive_path(name, version));
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(expected.as_str())
        );
        assert_eq!(
            manifest.storages[1].archive_url.as_deref(),
            Some(expected.as_str())
        );

        let ops = telemetry.pending_ops_snapshot();
        assert_eq!(
            ops.iter()
                .filter(|(key, _, _)| key == "storage_cache_miss")
                .count(),
            1,
            "expected one successful representative miss in {ops:?}"
        );
        assert!(
            !ops.iter()
                .any(|(key, _, _)| key == "storage_cache_skipped_invalid_download"),
            "transient representative invalid download should not be the final group outcome: {ops:?}"
        );
    }

    #[tokio::test]
    async fn duplicate_same_key_all_probe_failures_stay_per_target_passthrough() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let failed_probe_a = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/probe-fails-a.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(500);
            })
            .await;
        let failed_full_a = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/probe-fails-a.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;
        let failed_probe_b = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/probe-fails-b.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(503);
            })
            .await;
        let failed_full_b = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/probe-fails-b.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let name = "probe-all-fail";
        let version = "v1";
        let original_a = server.url("/probe-fails-a.tar.gz");
        let original_b = server.url("/probe-fails-b.tar.gz");
        let mut manifest =
            manifest_duplicate_storages(original_a.clone(), original_b.clone(), name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        failed_probe_a
            .assert_calls_async(CACHE_HTTP_MAX_ATTEMPTS)
            .await;
        failed_probe_b
            .assert_calls_async(CACHE_HTTP_MAX_ATTEMPTS)
            .await;
        failed_full_a.assert_calls_async(0).await;
        failed_full_b.assert_calls_async(0).await;
        assert!(
            sandbox.write_file_calls().is_empty(),
            "all probe failures should not stage a guest archive"
        );
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(original_a.as_str())
        );
        assert_eq!(
            manifest.storages[1].archive_url.as_deref(),
            Some(original_b.as_str())
        );

        let ops = telemetry.pending_ops_snapshot();
        assert_eq!(
            ops.iter()
                .filter(|(key, _, _)| key == "storage_cache_skipped_head_failed")
                .count(),
            2,
            "expected each failed duplicate probe to retain its passthrough telemetry in {ops:?}"
        );
        assert!(
            !ops.iter().any(|(key, _, _)| key == "storage_cache_miss"
                || key == "storage_cache_download"
                || key == "storage_cache_hit"),
            "all probe failures should not record cache hit/miss/download telemetry: {ops:?}"
        );
    }

    #[tokio::test]
    async fn duplicate_same_key_all_invalid_downloads_stay_per_target_passthrough() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let empty_probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/empty-download.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let empty_full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/empty-download.tar.gz")
                    .header_missing("range");
                then.status(200);
            })
            .await;
        let mismatch_probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/size-mismatch.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len() + 1))
                    .body(b"x");
            })
            .await;
        let mismatch_full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/size-mismatch.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let name = "download-all-invalid";
        let version = "v1";
        let original_a = server.url("/empty-download.tar.gz");
        let original_b = server.url("/size-mismatch.tar.gz");
        let mut manifest =
            manifest_duplicate_storages(original_a.clone(), original_b.clone(), name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        empty_probe.assert_async().await;
        empty_full.assert_async().await;
        mismatch_probe.assert_async().await;
        mismatch_full.assert_async().await;
        assert!(
            sandbox.write_file_calls().is_empty(),
            "all invalid downloads should not stage a guest archive"
        );
        assert_eq!(
            manifest.storages[0].archive_url.as_deref(),
            Some(original_a.as_str())
        );
        assert_eq!(
            manifest.storages[1].archive_url.as_deref(),
            Some(original_b.as_str())
        );

        let ops = telemetry.pending_ops_snapshot();
        assert_eq!(
            ops.iter()
                .filter(|(key, _, _)| key == "storage_cache_skipped_invalid_download")
                .count(),
            2,
            "expected each failed duplicate download to retain its passthrough telemetry in {ops:?}"
        );
        assert!(
            !ops.iter().any(|(key, _, _)| key == "storage_cache_miss"
                || key == "storage_cache_download"
                || key == "storage_cache_hit"),
            "all invalid downloads should not record cache hit/miss/download telemetry: {ops:?}"
        );
    }

    #[tokio::test]
    async fn shared_version_distinct_names_get_distinct_guest_paths() {
        // Regression guard: two manifest entries that share `vasVersionId`
        // but differ in `vasStorageName` must resolve to distinct guest
        // `file://` URLs. Before the host/guest key symmetrization, both
        // entries collided on `{GUEST_STAGE_DIR}/{version}.tar.gz` and the
        // second `sandbox.write_file` clobbered the first.
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
                missing_root_policy: None,
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
        // `populate_cache` runs cache workers in spawned tasks, so both tasks
        // touch the flock acquire from separate spawn_blocking threads. This
        // exercises real cross-thread flock semantics.
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
        let total_process_group = op_count(&ops_a, STORAGE_CACHE_PROCESS_GROUP)
            + op_count(&ops_b, STORAGE_CACHE_PROCESS_GROUP);
        let total_lock_wait =
            op_count(&ops_a, STORAGE_CACHE_LOCK_WAIT) + op_count(&ops_b, STORAGE_CACHE_LOCK_WAIT);
        let total_hit_read =
            op_count(&ops_a, STORAGE_CACHE_HIT_READ) + op_count(&ops_b, STORAGE_CACHE_HIT_READ);
        assert_eq!(
            total_miss, 1,
            "exactly one miss across concurrent populates"
        );
        assert_eq!(total_hit, 1, "second populate must see the warmed cache");
        assert_eq!(
            total_process_group, 2,
            "each concurrent populate should record group processing"
        );
        assert!(
            total_lock_wait >= 3,
            "miss plus hit paths should record lock wait telemetry in {ops_a:?} / {ops_b:?}"
        );
        assert_eq!(
            total_hit_read, 1,
            "the warmed-cache caller should record one hit read"
        );
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
        // extract a total, so the entry must stay passthrough.
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
        let full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/nosize.tar.gz")
                    .header_missing("range");
                then.status(200).body(tarball_bytes());
            })
            .await;

        let original = server.url("/nosize.tar.gz");
        let name = "nosize";
        let version = "v1";
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        probe.assert_async().await;
        full.assert_calls_async(0).await;
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
        let ops = telemetry.pending_ops_snapshot();
        assert_storage_cache_skipped_reason(&ops, "missing-content-range");
    }

    #[tokio::test]
    async fn probe_wildcard_content_range_is_passthrough() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/wildcard.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", "bytes 0-0/*")
                    .body(b"x");
            })
            .await;
        let full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/wildcard.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let original = server.url("/wildcard.tar.gz");
        let name = "wildcard";
        let version = "v1";
        let mut manifest = manifest_single_storage(original.clone(), name, version);

        populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        probe.assert_async().await;
        full.assert_calls_async(0).await;
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
        let ops = telemetry.pending_ops_snapshot();
        assert_storage_cache_skipped_reason(&ops, "unknown-size");
    }

    #[tokio::test]
    async fn probe_malformed_content_range_is_passthrough() {
        let cases = [
            ("bogus-no-slash", "no-slash"),
            ("bogus/7", "bogus-slash"),
            ("bytes */7", "wildcard-range"),
            ("bytes 1-0/7", "reversed-range"),
            ("bytes 0-1/7", "wrong-range"),
            ("items 0-0/7", "wrong-unit"),
            ("bytes 0-0/0", "empty-total"),
            ("bytes -0/7", "empty-start"),
            ("bytes 0-/7", "empty-end"),
            ("bytes 0-0/", "empty-size"),
            ("bytes 0-0/7/8", "extra-slash"),
            ("bytes 0-0/7 extra", "extra-token"),
            ("bytes 0-0/18446744073709551616", "overflow-total"),
            ("bytes +0-0/7", "plus-start"),
            ("bytes 0-+0/7", "plus-end"),
            ("bytes 0-0/+7", "plus-total"),
        ];

        for (content_range, slug) in cases {
            let temp = tempfile::tempdir().unwrap();
            let home = home_at(&temp);
            let sandbox = MockSandbox::new("test");
            let mut telemetry = new_telemetry();
            let server = MockServer::start_async().await;
            let path = format!("/{slug}.tar.gz");
            let probe_path = path.clone();
            let full_path = path.clone();
            let probe_content_range = content_range.to_string();

            let probe = server
                .mock_async(move |when, then| {
                    when.method(GET)
                        .path(probe_path.as_str())
                        .header("range", "bytes=0-0");
                    then.status(206)
                        .header("content-range", probe_content_range)
                        .body(b"x");
                })
                .await;
            let full = server
                .mock_async(move |when, then| {
                    when.method(GET)
                        .path(full_path.as_str())
                        .header_missing("range");
                    then.status(200).body(tarball_bytes());
                })
                .await;

            let original = server.url(path.as_str());
            let name = format!("garbage-{slug}");
            let version = "v1";
            let mut manifest = manifest_single_storage(original.clone(), name.as_str(), version);

            populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

            probe.assert_async().await;
            full.assert_calls_async(0).await;
            assert_eq!(
                manifest.storages[0].archive_url.as_deref(),
                Some(original.as_str()),
                "{content_range} must stay passthrough"
            );
            assert!(
                !home
                    .storage_cache_dir(name.as_str(), version)
                    .join("archive.tar.gz")
                    .exists(),
                "{content_range} must not write a cache archive"
            );
            let ops = telemetry.pending_ops_snapshot();
            assert_storage_cache_skipped_reason(&ops, "invalid-content-range");
        }
    }
}
