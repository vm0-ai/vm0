use crate::LOG_TAG;
use crate::archive;
use crate::error::DownloadError;
use crate::path::normalize_path;
use crate::source;
use crate::telemetry::{DownloadRunTelemetry, DownloadTaskTelemetry, RemoteArchiveTaskMetrics};
use guest_common::{log_error, log_info, log_warn};
use std::any::Any;
use std::collections::VecDeque;
use std::fs;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const MAX_RETRIES: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_secs(1);
const MAX_CONCURRENT: usize = 4;
type AttemptRunner = fn(&mut StartedDownload) -> Result<(), DownloadError>;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct DownloadTask {
    label: String,
    url: String,
    mount_path: String,
    normalized_mount_path: PathBuf,
    telemetry: DownloadTaskTelemetry,
}

impl DownloadTask {
    pub(crate) fn storage(
        label: String,
        url: String,
        mount_path: String,
        has_instructions_target: bool,
    ) -> Self {
        let normalized_mount_path = normalize_path(Path::new(&mount_path));
        let telemetry =
            DownloadTaskTelemetry::storage(&url, &normalized_mount_path, has_instructions_target);
        Self {
            label,
            url,
            mount_path,
            normalized_mount_path,
            telemetry,
        }
    }

    pub(crate) fn artifact(label: String, url: String, mount_path: String) -> Self {
        let normalized_mount_path = normalize_path(Path::new(&mount_path));
        let telemetry = DownloadTaskTelemetry::artifact(&url, &normalized_mount_path);
        Self {
            label,
            url,
            mount_path,
            normalized_mount_path,
            telemetry,
        }
    }

    fn prepare(self) -> Result<PreparedDownloadTask, String> {
        fs::create_dir_all(&self.mount_path).map_err(|e| {
            format!(
                "{} target preparation failed: failed to create directory {}: {e}",
                self.label, self.mount_path
            )
        })?;
        let effective_mount_path = Path::new(&self.mount_path).canonicalize().map_err(|e| {
            format!(
                "{} target preparation failed: failed to resolve directory {}: {e}",
                self.label, self.mount_path
            )
        })?;

        Ok(PreparedDownloadTask {
            task: self,
            effective_mount_path,
        })
    }
}

pub(crate) struct PreparedDownloadTask {
    task: DownloadTask,
    effective_mount_path: PathBuf,
}

impl PreparedDownloadTask {
    fn logical_mount_path(&self) -> &Path {
        &self.task.normalized_mount_path
    }

    fn effective_mount_path(&self) -> &Path {
        &self.effective_mount_path
    }

    fn failure_detail(&self, error: &DownloadError) -> String {
        format!("{} download failed: {}", self.task.label, error)
    }
}

struct PendingDownload {
    id: usize,
    task: PreparedDownloadTask,
}

impl PendingDownload {
    fn new(id: usize, task: PreparedDownloadTask) -> Self {
        Self { id, task }
    }
}

struct StartedDownload {
    id: usize,
    task: PreparedDownloadTask,
    start: Instant,
    attempt: u32,
    opened_file_compressed_bytes: Option<u64>,
    remote_metrics: Option<RemoteArchiveTaskMetrics>,
}

impl StartedDownload {
    fn new(download: PendingDownload) -> Self {
        let start = Instant::now();
        log_info!(
            LOG_TAG,
            "Downloading {} to {}",
            download.task.task.label,
            download.task.task.mount_path
        );
        Self {
            id: download.id,
            remote_metrics: download.task.task.telemetry.remote_metrics(),
            task: download.task,
            start,
            attempt: 1,
            opened_file_compressed_bytes: None,
        }
    }

    fn should_retry(&self, error: &DownloadError) -> bool {
        error.retriable && self.attempt < MAX_RETRIES
    }

    fn finish(self, result: Result<(), DownloadError>) -> bool {
        match result {
            Ok(()) => {
                let elapsed = self.start.elapsed();
                self.task.task.telemetry.record_result(
                    elapsed,
                    true,
                    None,
                    self.opened_file_compressed_bytes,
                    self.remote_metrics.as_ref(),
                );
                log_info!(
                    LOG_TAG,
                    "{} downloaded in {}ms",
                    self.task.task.label,
                    elapsed.as_millis()
                );
                true
            }
            Err(error) => {
                let failure_detail = self.task.failure_detail(&error);
                self.task.task.telemetry.record_result(
                    self.start.elapsed(),
                    false,
                    Some(&failure_detail),
                    self.opened_file_compressed_bytes,
                    self.remote_metrics.as_ref(),
                );
                log_error!(LOG_TAG, "{failure_detail}");
                false
            }
        }
    }
}

struct DownloadReservation {
    id: usize,
    logical_mount_path: PathBuf,
    effective_mount_path: PathBuf,
}

impl DownloadReservation {
    fn new(download: &StartedDownload) -> Self {
        Self {
            id: download.id,
            logical_mount_path: download.task.logical_mount_path().to_path_buf(),
            effective_mount_path: download.task.effective_mount_path().to_path_buf(),
        }
    }
}

struct WaitingRetry {
    ready_at: Instant,
    download: StartedDownload,
}

enum ReadyDownload {
    Pending(usize),
    Retry(usize),
}

struct DownloadCompletion {
    download: StartedDownload,
    completed_at: Instant,
    outcome: AttemptOutcome,
}

enum AttemptOutcome {
    Finished(Result<(), DownloadError>),
    Panicked(String),
}

struct DownloadScheduler {
    pending: VecDeque<PendingDownload>,
    waiting_retries: Vec<WaitingRetry>,
    reservations: Vec<DownloadReservation>,
    active_attempts: usize,
    all_success: bool,
}

impl DownloadScheduler {
    fn new(pending: VecDeque<PendingDownload>) -> Self {
        Self {
            pending,
            waiting_retries: Vec::new(),
            reservations: Vec::new(),
            active_attempts: 0,
            all_success: true,
        }
    }

    fn has_work(&self) -> bool {
        !self.pending.is_empty() || !self.reservations.is_empty()
    }

    fn can_make_progress(&self) -> bool {
        self.active_attempts > 0 || !self.waiting_retries.is_empty()
    }

    fn next_retry_deadline(&self) -> Option<Instant> {
        self.waiting_retries
            .iter()
            .map(|retry| retry.ready_at)
            .min()
    }

    fn start_ready_attempts<'scope, 'env: 'scope>(
        &mut self,
        scope: &'scope thread::Scope<'scope, 'env>,
        completion_tx: &mpsc::Sender<DownloadCompletion>,
        attempt_runner: AttemptRunner,
        telemetry: &mut DownloadRunTelemetry,
    ) {
        while self.active_attempts < MAX_CONCURRENT {
            let now = Instant::now();
            let retry = self
                .waiting_retries
                .iter()
                .enumerate()
                .filter(|(_, retry)| retry.ready_at <= now)
                .min_by_key(|(_, retry)| retry.download.id)
                .map(|(index, retry)| (index, retry.download.id));
            let pending = find_startable_download(
                &self.pending,
                &self.reservations,
                &mut |pending_id, pending_path, active_id, active_path| {
                    telemetry.record_conflict(pending_id, pending_path, active_id, active_path);
                },
            );
            let selection = match (retry, pending) {
                (Some((retry_index, retry_id)), Some((pending_index, pending_id))) => {
                    if retry_id < pending_id {
                        ReadyDownload::Retry(retry_index)
                    } else {
                        ReadyDownload::Pending(pending_index)
                    }
                }
                (Some((index, _)), None) => ReadyDownload::Retry(index),
                (None, Some((index, _))) => ReadyDownload::Pending(index),
                (None, None) => break,
            };

            let download = match selection {
                ReadyDownload::Retry(index) => self.waiting_retries.swap_remove(index).download,
                ReadyDownload::Pending(index) => {
                    let Some(download) = self.pending.remove(index) else {
                        log_error!(LOG_TAG, "Download scheduler selected a missing task");
                        break;
                    };
                    let download = StartedDownload::new(download);
                    self.reservations.push(DownloadReservation::new(&download));
                    download
                }
            };

            let completion_tx = completion_tx.clone();
            scope.spawn(move || {
                let mut download = download;
                let outcome =
                    std::panic::catch_unwind(AssertUnwindSafe(|| attempt_runner(&mut download)))
                        .map(AttemptOutcome::Finished)
                        .unwrap_or_else(|e| AttemptOutcome::Panicked(panic_message(e.as_ref())));
                let _ = completion_tx.send(DownloadCompletion {
                    download,
                    completed_at: Instant::now(),
                    outcome,
                });
            });
            self.active_attempts += 1;
        }
    }

    fn record_completion(&mut self, mut completion: DownloadCompletion) {
        self.active_attempts -= 1;

        match completion.outcome {
            AttemptOutcome::Finished(Err(error)) if completion.download.should_retry(&error) => {
                completion.download.attempt += 1;
                self.waiting_retries.push(WaitingRetry {
                    ready_at: completion.completed_at + RETRY_DELAY,
                    download: completion.download,
                });
            }
            AttemptOutcome::Finished(result) => {
                self.reservations
                    .retain(|reserved| reserved.id != completion.download.id);
                if !completion.download.finish(result) {
                    self.all_success = false;
                }
            }
            AttemptOutcome::Panicked(msg) => {
                self.reservations
                    .retain(|reserved| reserved.id != completion.download.id);
                log_error!(LOG_TAG, "Thread panicked: {msg}");
                self.all_success = false;
            }
        }
    }
}

/// Prepare download targets before any archive worker can start.
pub(crate) fn prepare_download_tasks(
    tasks: Vec<DownloadTask>,
) -> Result<Vec<PreparedDownloadTask>, String> {
    tasks.into_iter().map(DownloadTask::prepare).collect()
}

/// Download all prepared tasks in parallel using std::thread.
/// Limits active archive attempts to MAX_CONCURRENT and serializes logically or
/// physically overlapping mount paths across each task's complete retry cycle.
/// Returns true if all downloads succeeded, false if any failed.
pub(crate) fn download_all_parallel(tasks: Vec<PreparedDownloadTask>) -> bool {
    download_all_parallel_with_runner(tasks, run_download_attempt)
}

fn download_all_parallel_with_runner(
    tasks: Vec<PreparedDownloadTask>,
    attempt_runner: AttemptRunner,
) -> bool {
    let pending = tasks
        .into_iter()
        .enumerate()
        .map(|(sequence, task)| PendingDownload::new(sequence, task))
        .collect::<VecDeque<_>>();
    let mut telemetry = DownloadRunTelemetry::start(pending.iter().map(|download| {
        (
            download.task.task.telemetry,
            download.task.logical_mount_path(),
        )
    }));
    if pending.is_empty() {
        telemetry.finish();
        return true;
    }

    log_info!(
        LOG_TAG,
        "Downloading {} items (max {} concurrent)",
        pending.len(),
        MAX_CONCURRENT
    );

    let success = thread::scope(|scope| {
        let (completion_tx, completion_rx) = mpsc::channel();
        let mut scheduler = DownloadScheduler::new(pending);

        while scheduler.has_work() {
            scheduler.start_ready_attempts(scope, &completion_tx, attempt_runner, &mut telemetry);

            if !scheduler.can_make_progress() {
                log_error!(LOG_TAG, "Download scheduler cannot make progress");
                return false;
            }

            let completion = if scheduler.active_attempts < MAX_CONCURRENT {
                match scheduler.next_retry_deadline() {
                    Some(deadline) => {
                        match completion_rx
                            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                        {
                            Ok(completion) => Some(completion),
                            Err(mpsc::RecvTimeoutError::Timeout) => None,
                            Err(mpsc::RecvTimeoutError::Disconnected) => {
                                log_error!(LOG_TAG, "Download scheduler completion channel closed");
                                return false;
                            }
                        }
                    }
                    None => match completion_rx.recv() {
                        Ok(completion) => Some(completion),
                        Err(e) => {
                            log_error!(LOG_TAG, "Download scheduler failed: {e}");
                            return false;
                        }
                    },
                }
            } else {
                match completion_rx.recv() {
                    Ok(completion) => Some(completion),
                    Err(e) => {
                        log_error!(LOG_TAG, "Download scheduler failed: {e}");
                        return false;
                    }
                }
            };

            let Some(completion) = completion else {
                continue;
            };
            scheduler.record_completion(completion);
        }

        scheduler.all_success
    });
    telemetry.finish();
    success
}

fn find_startable_download(
    pending: &VecDeque<PendingDownload>,
    reservations: &[DownloadReservation],
    on_conflict: &mut impl FnMut(usize, &Path, usize, &Path),
) -> Option<(usize, usize)> {
    // Scan the pending queue instead of using strict FIFO so a reserved
    // parent/child mount-path conflict does not leave a slot idle when a later
    // independent task can start.
    for (index, download) in pending.iter().enumerate() {
        if let Some((blocking, pending_path, reserved_path)) =
            reservations.iter().find_map(|reservation| {
                conflicting_mount_paths(&download.task, reservation)
                    .map(|(pending_path, reserved_path)| (reservation, pending_path, reserved_path))
            })
        {
            on_conflict(download.id, pending_path, blocking.id, reserved_path);
            continue;
        }

        return Some((index, download.id));
    }

    None
}

fn conflicting_mount_paths<'pending, 'reserved>(
    pending: &'pending PreparedDownloadTask,
    reserved: &'reserved DownloadReservation,
) -> Option<(&'pending Path, &'reserved Path)> {
    if mount_paths_conflict(pending.logical_mount_path(), &reserved.logical_mount_path) {
        return Some((pending.logical_mount_path(), &reserved.logical_mount_path));
    }
    if mount_paths_conflict(
        pending.effective_mount_path(),
        &reserved.effective_mount_path,
    ) {
        return Some((
            pending.effective_mount_path(),
            &reserved.effective_mount_path,
        ));
    }
    None
}

fn mount_paths_conflict(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

fn panic_message(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|msg| (*msg).to_owned()))
        .unwrap_or_else(|| "unknown".to_owned())
}

/// Download and extract one archive attempt.
///
/// The scheduler uses the same target for every attempt. It neither clears the
/// target nor rolls back files written by a failed extraction attempt, so later
/// attempts run against any filesystem state left by earlier ones.
fn run_download_attempt(download: &mut StartedDownload) -> Result<(), DownloadError> {
    if let Some(metrics) = download.remote_metrics.as_mut() {
        metrics.begin_attempt();
    }
    let attempt_start = Instant::now();
    let result = download_and_extract(
        &download.task.task.url,
        download.task.effective_mount_path(),
        &mut download.opened_file_compressed_bytes,
        download.remote_metrics.as_mut(),
    );
    if let Err(error) = &result {
        log_warn!(
            LOG_TAG,
            "Attempt {}/{MAX_RETRIES} failed after {}ms: {error}",
            download.attempt,
            attempt_start.elapsed().as_millis()
        );
    }

    result
}

fn download_and_extract(
    url: &str,
    target_path: &Path,
    opened_file_compressed_bytes: &mut Option<u64>,
    remote_metrics: Option<&mut RemoteArchiveTaskMetrics>,
) -> Result<(), DownloadError> {
    fs::create_dir_all(target_path).map_err(|e| {
        DownloadError::fatal(format!(
            "Failed to create directory {}: {e}",
            target_path.display()
        ))
    })?;

    let attempt_metrics = remote_metrics
        .is_some()
        .then(source::RemoteArchiveAttemptMetrics::default);
    let reader = match source::open_archive(url, attempt_metrics.as_ref()) {
        Ok(reader) => reader,
        Err(error) => {
            if let (Some(metrics), Some(attempt_metrics)) = (remote_metrics, &attempt_metrics) {
                metrics.record_attempt(attempt_metrics.snapshot(), Duration::ZERO);
            }
            return Err(error);
        }
    };
    *opened_file_compressed_bytes = reader.compressed_bytes();
    let extract_start = Instant::now();
    let result = archive::extract_tar_gz(reader, target_path);
    let extract_wall = extract_start.elapsed();
    if let (Some(metrics), Some(attempt_metrics)) = (remote_metrics, &attempt_metrics) {
        metrics.record_attempt(attempt_metrics.snapshot(), extract_wall);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalized_path(path: &str) -> PathBuf {
        normalize_path(Path::new(path))
    }

    fn task_at(path: &str) -> DownloadTask {
        DownloadTask::storage(
            format!("task {path}"),
            "file:///tmp/archive.tar.gz".to_owned(),
            path.to_owned(),
            false,
        )
    }

    fn prepared_task_at(path: &str) -> PreparedDownloadTask {
        PreparedDownloadTask {
            task: task_at(path),
            effective_mount_path: normalized_path(path),
        }
    }

    fn pending_at(id: usize, path: &str) -> PendingDownload {
        PendingDownload::new(id, prepared_task_at(path))
    }

    #[test]
    fn mount_paths_conflict_for_exact_and_parent_child_paths() {
        assert!(mount_paths_conflict(
            &normalized_path("/tmp/mount"),
            &normalized_path("/tmp/mount")
        ));
        assert!(mount_paths_conflict(
            &normalized_path("/tmp/mount"),
            &normalized_path("/tmp/mount/child")
        ));
        assert!(mount_paths_conflict(
            &normalized_path("/tmp/mount/child"),
            &normalized_path("/tmp/mount")
        ));
    }

    #[test]
    fn mount_paths_do_not_conflict_for_siblings_or_prefix_traps() {
        assert!(!mount_paths_conflict(
            &normalized_path("/tmp/mount-a"),
            &normalized_path("/tmp/mount-b")
        ));
        assert!(!mount_paths_conflict(
            &normalized_path("/tmp/foo/bar"),
            &normalized_path("/tmp/foo/barista")
        ));
    }

    #[test]
    fn mount_path_conflicts_use_lexical_normalization() {
        assert!(mount_paths_conflict(
            &normalized_path("/tmp//foo/./bar/baz/.."),
            &normalized_path("/tmp/foo/bar")
        ));
        assert!(!mount_paths_conflict(
            &normalized_path("/tmp/foo/bar/../barista"),
            &normalized_path("/tmp/foo/bar")
        ));
    }

    #[test]
    fn task_panic_returns_false_without_unwinding() {
        guest_common::log::clear_system_log_file();

        fn runner(download: &mut StartedDownload) -> Result<(), DownloadError> {
            if download.task.task.url == "panic" {
                panic!("expected panic");
            }
            Ok(())
        }

        let result = std::panic::catch_unwind(|| {
            download_all_parallel_with_runner(
                vec![
                    PreparedDownloadTask {
                        task: DownloadTask::storage(
                            "panic".to_owned(),
                            "panic".to_owned(),
                            "/tmp/panic".to_owned(),
                            false,
                        ),
                        effective_mount_path: PathBuf::from("/tmp/panic"),
                    },
                    PreparedDownloadTask {
                        task: DownloadTask::storage(
                            "success".to_owned(),
                            "success".to_owned(),
                            "/tmp/success".to_owned(),
                            false,
                        ),
                        effective_mount_path: PathBuf::from("/tmp/success"),
                    },
                ],
                runner,
            )
        });

        assert!(matches!(result, Ok(false)));
    }

    #[test]
    fn find_startable_download_observes_conflict_and_selects_later_task() {
        let pending = VecDeque::from([
            pending_at(3, "/tmp/mount/child"),
            pending_at(4, "/tmp/other"),
        ]);
        let reservations = vec![DownloadReservation {
            id: 2,
            logical_mount_path: normalized_path("/tmp/mount"),
            effective_mount_path: normalized_path("/tmp/mount"),
        }];
        let mut conflicts = Vec::new();

        let selected = find_startable_download(
            &pending,
            &reservations,
            &mut |pending_id, _, active_id, _| {
                conflicts.push((pending_id, active_id));
            },
        );

        assert_eq!(conflicts, [(3, 2)]);
        assert_eq!(selected, Some((1, 4)));
    }

    #[test]
    fn find_startable_download_reports_first_active_conflict_on_each_scan() {
        let pending = VecDeque::from([pending_at(4, "/tmp/mount/child")]);
        let reservations = vec![
            DownloadReservation {
                id: 2,
                logical_mount_path: normalized_path("/tmp/mount"),
                effective_mount_path: normalized_path("/tmp/mount"),
            },
            DownloadReservation {
                id: 3,
                logical_mount_path: normalized_path("/tmp/mount/child"),
                effective_mount_path: normalized_path("/tmp/mount/child"),
            },
        ];
        let mut conflicts = Vec::new();

        for _ in 0..2 {
            let selected = find_startable_download(
                &pending,
                &reservations,
                &mut |pending_id, _, active_id, _| {
                    conflicts.push((pending_id, active_id));
                },
            );
            assert_eq!(selected, None);
        }

        assert_eq!(conflicts, [(4, 2), (4, 2)]);
    }

    #[test]
    fn download_task_failure_detail_includes_entry_metadata() {
        let task = DownloadTask::storage(
            "storage 1 mountPath=/workspace vasStorageName=repo vasVersionId=v1 urlScheme=file cached=false"
                .into(),
            "file:///tmp/archive.tar.gz".into(),
            "/workspace".into(),
            false,
        );
        let error = DownloadError::fatal("Failed to read archive entries: invalid gzip header");

        let detail = PreparedDownloadTask {
            task,
            effective_mount_path: PathBuf::from("/workspace"),
        }
        .failure_detail(&error);

        assert!(detail.contains("storage 1"));
        assert!(detail.contains("mountPath=/workspace"));
        assert!(detail.contains("vasStorageName=repo"));
        assert!(detail.contains("vasVersionId=v1"));
        assert!(detail.contains("urlScheme=file"));
        assert!(detail.contains("Failed to read archive entries"));
    }
}
