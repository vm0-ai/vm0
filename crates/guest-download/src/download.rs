use crate::LOG_TAG;
use crate::archive;
use crate::error::DownloadError;
use crate::source;
use crate::telemetry;
use guest_common::{log_error, log_info, log_warn};
use std::any::Any;
use std::collections::VecDeque;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const MAX_RETRIES: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_secs(1);
const MAX_CONCURRENT: usize = 4;
type TaskRunner = fn(DownloadTask) -> bool;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct DownloadTask {
    label: String,
    url: String,
    mount_path: String,
    telemetry: telemetry::TaskMetadata,
}

impl DownloadTask {
    pub(crate) fn storage(
        label: String,
        url: String,
        mount_path: String,
        instructions_target_filename: Option<&str>,
    ) -> Self {
        let normalized_mount_path = normalize_mount_path(&mount_path);
        let telemetry = telemetry::TaskMetadata::storage(
            &url,
            &normalized_mount_path,
            instructions_target_filename,
        );
        Self {
            label,
            url,
            mount_path,
            telemetry,
        }
    }

    pub(crate) fn artifact(label: String, url: String, mount_path: String) -> Self {
        let normalized_mount_path = normalize_mount_path(&mount_path);
        let telemetry = telemetry::TaskMetadata::artifact(&url, normalized_mount_path.as_path());
        Self {
            label,
            url,
            mount_path,
            telemetry,
        }
    }

    #[cfg(test)]
    fn test_storage(label: String, url: String, mount_path: String) -> Self {
        Self::storage(label, url, mount_path, None)
    }

    pub(crate) fn mount_path(&self) -> &str {
        &self.mount_path
    }

    fn telemetry_snapshot(&self) -> telemetry::TaskSnapshot {
        telemetry::TaskSnapshot::new(self.telemetry, normalize_mount_path(&self.mount_path))
    }

    fn failure_detail(&self, error: &DownloadError) -> String {
        format!("{} download failed: {}", self.label, error)
    }
}

struct ScheduledDownload {
    id: usize,
    task: DownloadTask,
}

struct ActiveDownload {
    id: usize,
    mount_path: PathBuf,
}

struct DownloadCompletion {
    id: usize,
    outcome: DownloadOutcome,
}

enum DownloadOutcome {
    Finished(bool),
    Panicked(String),
}

/// Download all tasks in parallel using std::thread.
/// Limits concurrency to MAX_CONCURRENT and serializes overlapping mount paths.
/// Returns true if all downloads succeeded, false if any failed.
pub(crate) fn download_all_parallel(tasks: Vec<DownloadTask>) -> bool {
    download_all_parallel_with_runner(tasks, run_download_task)
}

fn download_all_parallel_with_runner(tasks: Vec<DownloadTask>, task_runner: TaskRunner) -> bool {
    let mut recorder =
        telemetry::BatchRecorder::new(tasks.iter().map(DownloadTask::telemetry_snapshot));
    if tasks.is_empty() {
        recorder.finish();
        return true;
    }

    log_info!(
        LOG_TAG,
        "Downloading {} items (max {} concurrent)",
        tasks.len(),
        MAX_CONCURRENT
    );

    let success = thread::scope(|scope| {
        let (completion_tx, completion_rx) = mpsc::channel();
        let mut pending: VecDeque<ScheduledDownload> = tasks
            .into_iter()
            .enumerate()
            .map(|(id, task)| ScheduledDownload { id, task })
            .collect();
        let mut active = Vec::new();
        let mut all_success = true;

        start_ready_downloads(
            scope,
            &mut pending,
            &mut active,
            &completion_tx,
            task_runner,
            &mut |pending_id, pending_path, active_id, active_path| {
                recorder.record_conflict(pending_id, pending_path, active_id, active_path);
            },
        );

        while !active.is_empty() {
            let completion = match completion_rx.recv() {
                Ok(completion) => completion,
                Err(e) => {
                    log_error!(LOG_TAG, "Download scheduler failed: {e}");
                    return false;
                }
            };

            active.retain(|download| download.id != completion.id);

            match completion.outcome {
                DownloadOutcome::Finished(success) => {
                    if !success {
                        all_success = false;
                    }
                }
                DownloadOutcome::Panicked(msg) => {
                    log_error!(LOG_TAG, "Thread panicked: {msg}");
                    all_success = false;
                }
            }

            start_ready_downloads(
                scope,
                &mut pending,
                &mut active,
                &completion_tx,
                task_runner,
                &mut |pending_id, pending_path, active_id, active_path| {
                    recorder.record_conflict(pending_id, pending_path, active_id, active_path);
                },
            );
        }

        all_success && pending.is_empty()
    });
    recorder.finish();
    success
}

fn start_ready_downloads<'scope, 'env: 'scope>(
    scope: &'scope thread::Scope<'scope, 'env>,
    pending: &mut VecDeque<ScheduledDownload>,
    active: &mut Vec<ActiveDownload>,
    completion_tx: &mpsc::Sender<DownloadCompletion>,
    task_runner: TaskRunner,
    on_conflict: &mut impl FnMut(usize, &Path, usize, &Path),
) {
    while active.len() < MAX_CONCURRENT {
        let Some((index, mount_path)) = find_startable_download(pending, active, on_conflict)
        else {
            break;
        };
        let Some(download) = pending.remove(index) else {
            log_error!(LOG_TAG, "Download scheduler selected a missing task");
            break;
        };
        let id = download.id;
        let task = download.task;
        active.push(ActiveDownload { id, mount_path });

        let completion_tx = completion_tx.clone();
        scope.spawn(move || {
            let outcome = std::panic::catch_unwind(|| task_runner(task))
                .map(DownloadOutcome::Finished)
                .unwrap_or_else(|e| DownloadOutcome::Panicked(panic_message(e.as_ref())));

            let _ = completion_tx.send(DownloadCompletion { id, outcome });
        });
    }
}

fn find_startable_download(
    pending: &VecDeque<ScheduledDownload>,
    active: &[ActiveDownload],
    on_conflict: &mut impl FnMut(usize, &Path, usize, &Path),
) -> Option<(usize, PathBuf)> {
    // Scan the pending queue instead of using strict FIFO so an active
    // parent/child mount-path conflict does not leave a slot idle when a later
    // independent task can start.
    for (index, download) in pending.iter().enumerate() {
        let mount_path = normalize_mount_path(download.task.mount_path());

        if let Some(blocking) = active.iter().find(|active_download| {
            mount_paths_conflict(mount_path.as_path(), active_download.mount_path.as_path())
        }) {
            on_conflict(
                download.id,
                mount_path.as_path(),
                blocking.id,
                blocking.mount_path.as_path(),
            );
            continue;
        }

        return Some((index, mount_path));
    }

    None
}

fn normalize_mount_path(path: &str) -> PathBuf {
    let mut components = Vec::new();

    for component in Path::new(path).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match components.last() {
                Some(Component::Normal(_)) => {
                    components.pop();
                }
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => components.push(component),
            },
            _ => components.push(component),
        }
    }

    let mut normalized = PathBuf::new();
    for component in components {
        normalized.push(component.as_os_str());
    }
    normalized
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

fn run_download_task(task: DownloadTask) -> bool {
    let start = Instant::now();
    log_info!(LOG_TAG, "Downloading {} to {}", task.label, task.mount_path);
    let mut recorder = telemetry::TaskRecorder::new(task.telemetry);

    match download_with_retry(&task.url, &task.mount_path, &mut recorder) {
        Ok(()) => {
            let elapsed = start.elapsed();
            recorder.finish(elapsed, true, None);
            log_info!(
                LOG_TAG,
                "{} downloaded in {}ms",
                task.label,
                elapsed.as_millis()
            );
            true
        }
        Err(e) => {
            let failure_detail = task.failure_detail(&e);
            recorder.finish(start.elapsed(), false, Some(&failure_detail));
            log_error!(LOG_TAG, "{failure_detail}");
            false
        }
    }
}

/// Download and extract an archive, retrying retriable failures.
///
/// Every attempt uses the same `target_path`. The retry loop neither clears the
/// target nor rolls back files written by a failed extraction attempt, so later
/// attempts run against any filesystem state left by earlier ones.
fn download_with_retry(
    url: &str,
    target_path: &str,
    recorder: &mut telemetry::TaskRecorder,
) -> Result<(), DownloadError> {
    let mut last_error = None;

    for attempt in 1..=MAX_RETRIES {
        let attempt_metrics = recorder.begin_attempt();
        let attempt_start = Instant::now();
        match download_and_extract(url, target_path, attempt_metrics, recorder) {
            Ok(()) => return Ok(()),
            Err(e) => {
                log_warn!(
                    LOG_TAG,
                    "Attempt {attempt}/{MAX_RETRIES} failed after {}ms: {e}",
                    attempt_start.elapsed().as_millis()
                );
                let should_break = !e.retriable;
                last_error = Some(e);
                if should_break {
                    break;
                }
                if attempt < MAX_RETRIES {
                    thread::sleep(RETRY_DELAY);
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| DownloadError::fatal("download failed with no error")))
}

fn download_and_extract(
    url: &str,
    target_path: &str,
    attempt_metrics: Option<source::RemoteArchiveAttemptMetrics>,
    recorder: &mut telemetry::TaskRecorder,
) -> Result<(), DownloadError> {
    fs::create_dir_all(target_path).map_err(|e| {
        DownloadError::fatal(format!("Failed to create directory {target_path}: {e}"))
    })?;

    let reader = match source::open_archive(url, attempt_metrics.as_ref()) {
        Ok(reader) => reader,
        Err(error) => {
            if let Some(attempt_metrics) = attempt_metrics.as_ref() {
                recorder.record_attempt(attempt_metrics, Duration::ZERO);
            }
            return Err(error);
        }
    };
    let extract_start = Instant::now();
    let result = archive::extract_tar_gz(reader, target_path);
    let extract_wall = extract_start.elapsed();
    if let Some(attempt_metrics) = attempt_metrics.as_ref() {
        recorder.record_attempt(attempt_metrics, extract_wall);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scheduled_at(id: usize, path: &str) -> ScheduledDownload {
        ScheduledDownload {
            id,
            task: DownloadTask::test_storage(
                format!("task {path}"),
                "file:///tmp/archive.tar.gz".to_owned(),
                path.to_owned(),
            ),
        }
    }

    #[test]
    fn mount_paths_conflict_for_exact_and_parent_child_paths() {
        assert!(mount_paths_conflict(
            &normalize_mount_path("/tmp/mount"),
            &normalize_mount_path("/tmp/mount")
        ));
        assert!(mount_paths_conflict(
            &normalize_mount_path("/tmp/mount"),
            &normalize_mount_path("/tmp/mount/child")
        ));
        assert!(mount_paths_conflict(
            &normalize_mount_path("/tmp/mount/child"),
            &normalize_mount_path("/tmp/mount")
        ));
    }

    #[test]
    fn mount_paths_do_not_conflict_for_siblings_or_prefix_traps() {
        assert!(!mount_paths_conflict(
            &normalize_mount_path("/tmp/mount-a"),
            &normalize_mount_path("/tmp/mount-b")
        ));
        assert!(!mount_paths_conflict(
            &normalize_mount_path("/tmp/foo/bar"),
            &normalize_mount_path("/tmp/foo/barista")
        ));
    }

    #[test]
    fn mount_path_conflicts_use_lexical_normalization() {
        assert!(mount_paths_conflict(
            &normalize_mount_path("/tmp//foo/./bar/baz/.."),
            &normalize_mount_path("/tmp/foo/bar")
        ));
        assert!(!mount_paths_conflict(
            &normalize_mount_path("/tmp/foo/bar/../barista"),
            &normalize_mount_path("/tmp/foo/bar")
        ));
    }

    #[test]
    fn task_panic_returns_false_without_unwinding() {
        guest_common::log::clear_system_log_file();

        fn runner(task: DownloadTask) -> bool {
            if task.url == "panic" {
                panic!("expected panic");
            }
            true
        }

        let result = std::panic::catch_unwind(|| {
            download_all_parallel_with_runner(
                vec![
                    DownloadTask::test_storage(
                        "panic".to_owned(),
                        "panic".to_owned(),
                        "/tmp/panic".to_owned(),
                    ),
                    DownloadTask::test_storage(
                        "success".to_owned(),
                        "success".to_owned(),
                        "/tmp/success".to_owned(),
                    ),
                ],
                runner,
            )
        });

        assert!(matches!(result, Ok(false)));
    }

    #[test]
    fn find_startable_download_observes_conflict_and_selects_later_task() {
        let pending = VecDeque::from(vec![
            scheduled_at(3, "/tmp/mount/child"),
            scheduled_at(4, "/tmp/other"),
        ]);
        let active = vec![ActiveDownload {
            id: 2,
            mount_path: normalize_mount_path("/tmp/mount"),
        }];
        let mut conflicts = Vec::new();

        let selected =
            find_startable_download(&pending, &active, &mut |pending_id, _, active_id, _| {
                conflicts.push((pending_id, active_id));
            });

        assert_eq!(conflicts, [(3, 2)]);
        assert_eq!(selected.map(|(index, _)| index), Some(1));
    }

    #[test]
    fn find_startable_download_reports_only_first_active_conflict() {
        let pending = VecDeque::from([scheduled_at(4, "/tmp/mount/child")]);
        let active = vec![
            ActiveDownload {
                id: 2,
                mount_path: normalize_mount_path("/tmp/mount"),
            },
            ActiveDownload {
                id: 3,
                mount_path: normalize_mount_path("/tmp/mount/child"),
            },
        ];
        let mut conflicts = Vec::new();

        let selected =
            find_startable_download(&pending, &active, &mut |pending_id, _, active_id, _| {
                conflicts.push((pending_id, active_id));
            });

        assert_eq!(selected, None);
        assert_eq!(conflicts, [(4, 2)]);
    }

    #[test]
    fn download_task_failure_detail_includes_entry_metadata() {
        let task = DownloadTask::test_storage(
            "storage 1 mountPath=/workspace vasStorageName=repo vasVersionId=v1 urlScheme=file cached=false"
                .into(),
            "file:///tmp/archive.tar.gz".into(),
            "/workspace".into(),
        );
        let error = DownloadError::fatal("Failed to read archive entries: invalid gzip header");

        let detail = task.failure_detail(&error);

        assert!(detail.contains("storage 1"));
        assert!(detail.contains("mountPath=/workspace"));
        assert!(detail.contains("vasStorageName=repo"));
        assert!(detail.contains("vasVersionId=v1"));
        assert!(detail.contains("urlScheme=file"));
        assert!(detail.contains("Failed to read archive entries"));
    }
}
