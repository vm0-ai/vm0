use crate::LOG_TAG;
use crate::archive;
use crate::error::DownloadError;
use crate::source;
use guest_common::{log_error, log_info, log_warn, telemetry::record_sandbox_op};
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NotFoundPolicy {
    Fail,
    Ignore404,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct DownloadTask {
    label: String,
    op_name: &'static str,
    url: String,
    mount_path: String,
    not_found_policy: NotFoundPolicy,
}

impl DownloadTask {
    pub(crate) fn new(
        label: String,
        op_name: &'static str,
        url: String,
        mount_path: String,
        not_found_policy: NotFoundPolicy,
    ) -> Self {
        Self {
            label,
            op_name,
            url,
            mount_path,
            not_found_policy,
        }
    }

    pub(crate) fn mount_path(&self) -> &str {
        &self.mount_path
    }

    fn is_remote_url(&self) -> bool {
        self.url.starts_with("http://") || self.url.starts_with("https://")
    }

    fn is_file_url(&self) -> bool {
        self.url.starts_with("file://")
    }

    fn failure_detail(&self, error: &DownloadError) -> String {
        format!("{} download failed: {}", self.label, error)
    }
}

struct ActiveDownload {
    id: usize,
    mount_path: PathBuf,
}

struct DownloadCompletion {
    id: usize,
    outcome: DownloadOutcome,
}

#[derive(Default)]
struct DownloadScheduleStats {
    mount_conflict_deferrals: usize,
}

struct StartableDownload {
    selected: Option<(usize, PathBuf)>,
    mount_conflict_deferrals: usize,
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

fn record_download_attribution(tasks: &[DownloadTask]) {
    record_sandbox_op(
        guest_download_task_count_action(tasks.len()),
        Duration::ZERO,
        true,
        None,
    );
    let remote_urls = tasks.iter().filter(|task| task.is_remote_url()).count();
    record_sandbox_op(
        guest_download_remote_url_count_action(remote_urls),
        Duration::ZERO,
        true,
        None,
    );
    let file_urls = tasks.iter().filter(|task| task.is_file_url()).count();
    record_sandbox_op(
        guest_download_file_url_count_action(file_urls),
        Duration::ZERO,
        true,
        None,
    );
}

fn download_all_parallel_with_runner(tasks: Vec<DownloadTask>, task_runner: TaskRunner) -> bool {
    record_download_attribution(&tasks);
    if tasks.is_empty() {
        record_sandbox_op(
            guest_download_mount_conflict_count_action(0),
            Duration::ZERO,
            true,
            None,
        );
        return true;
    }

    log_info!(
        LOG_TAG,
        "Downloading {} items (max {} concurrent)",
        tasks.len(),
        MAX_CONCURRENT
    );

    let mut stats = DownloadScheduleStats::default();
    let success = thread::scope(|scope| {
        let (completion_tx, completion_rx) = mpsc::channel();
        let mut pending = VecDeque::from(tasks);
        let mut active = Vec::new();
        let mut next_id = 0;
        let mut all_success = true;

        start_ready_downloads(
            scope,
            &mut pending,
            &mut active,
            &completion_tx,
            &mut next_id,
            task_runner,
            &mut stats,
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
                &mut next_id,
                task_runner,
                &mut stats,
            );
        }

        all_success && pending.is_empty()
    });
    record_sandbox_op(
        guest_download_mount_conflict_count_action(stats.mount_conflict_deferrals),
        Duration::ZERO,
        success,
        None,
    );
    success
}

fn guest_download_task_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "guest_download_task_count_0",
        CountBucket::One => "guest_download_task_count_1",
        CountBucket::Two => "guest_download_task_count_2",
        CountBucket::ThreeToFour => "guest_download_task_count_3_4",
        CountBucket::FiveToEight => "guest_download_task_count_5_8",
        CountBucket::NineToSixteen => "guest_download_task_count_9_16",
        CountBucket::SeventeenPlus => "guest_download_task_count_17_plus",
    }
}

fn guest_download_remote_url_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "guest_download_remote_url_count_0",
        CountBucket::One => "guest_download_remote_url_count_1",
        CountBucket::Two => "guest_download_remote_url_count_2",
        CountBucket::ThreeToFour => "guest_download_remote_url_count_3_4",
        CountBucket::FiveToEight => "guest_download_remote_url_count_5_8",
        CountBucket::NineToSixteen => "guest_download_remote_url_count_9_16",
        CountBucket::SeventeenPlus => "guest_download_remote_url_count_17_plus",
    }
}

fn guest_download_file_url_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "guest_download_file_url_count_0",
        CountBucket::One => "guest_download_file_url_count_1",
        CountBucket::Two => "guest_download_file_url_count_2",
        CountBucket::ThreeToFour => "guest_download_file_url_count_3_4",
        CountBucket::FiveToEight => "guest_download_file_url_count_5_8",
        CountBucket::NineToSixteen => "guest_download_file_url_count_9_16",
        CountBucket::SeventeenPlus => "guest_download_file_url_count_17_plus",
    }
}

fn guest_download_mount_conflict_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "guest_download_mount_conflict_count_0",
        CountBucket::One => "guest_download_mount_conflict_count_1",
        CountBucket::Two => "guest_download_mount_conflict_count_2",
        CountBucket::ThreeToFour => "guest_download_mount_conflict_count_3_4",
        CountBucket::FiveToEight => "guest_download_mount_conflict_count_5_8",
        CountBucket::NineToSixteen => "guest_download_mount_conflict_count_9_16",
        CountBucket::SeventeenPlus => "guest_download_mount_conflict_count_17_plus",
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

fn start_ready_downloads<'scope, 'env: 'scope>(
    scope: &'scope thread::Scope<'scope, 'env>,
    pending: &mut VecDeque<DownloadTask>,
    active: &mut Vec<ActiveDownload>,
    completion_tx: &mpsc::Sender<DownloadCompletion>,
    next_id: &mut usize,
    task_runner: TaskRunner,
    stats: &mut DownloadScheduleStats,
) {
    while active.len() < MAX_CONCURRENT {
        let startable = find_startable_download(pending, active);
        stats.mount_conflict_deferrals += startable.mount_conflict_deferrals;
        let Some((index, mount_path)) = startable.selected else {
            break;
        };
        let Some(task) = pending.remove(index) else {
            log_error!(LOG_TAG, "Download scheduler selected a missing task");
            break;
        };
        let id = *next_id;
        *next_id += 1;
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
    pending: &VecDeque<DownloadTask>,
    active: &[ActiveDownload],
) -> StartableDownload {
    // Scan the pending queue instead of using strict FIFO so an active
    // parent/child mount-path conflict does not leave a slot idle when a later
    // independent task can start.
    let mut mount_conflict_deferrals = 0;
    for (index, task) in pending.iter().enumerate() {
        let mount_path = normalize_mount_path(task.mount_path());
        let has_conflict = active.iter().any(|download| {
            mount_paths_conflict(mount_path.as_path(), download.mount_path.as_path())
        });

        if has_conflict {
            mount_conflict_deferrals += 1;
            continue;
        }

        return StartableDownload {
            selected: Some((index, mount_path)),
            mount_conflict_deferrals,
        };
    }

    StartableDownload {
        selected: None,
        mount_conflict_deferrals,
    }
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

    match download_with_retry(&task.url, &task.mount_path) {
        Ok(()) => {
            let elapsed = start.elapsed();
            record_sandbox_op(task.op_name, elapsed, true, None);
            log_info!(
                LOG_TAG,
                "{} downloaded in {}ms",
                task.label,
                elapsed.as_millis()
            );
            true
        }
        Err(e)
            if e.status_code == Some(404) && task.not_found_policy == NotFoundPolicy::Ignore404 =>
        {
            record_sandbox_op(task.op_name, start.elapsed(), true, None);
            log_info!(LOG_TAG, "{} not found, skipping (first run)", task.label);
            true
        }
        Err(e) => {
            let failure_detail = task.failure_detail(&e);
            record_sandbox_op(task.op_name, start.elapsed(), false, Some(&failure_detail));
            log_error!(LOG_TAG, "{failure_detail}");
            false
        }
    }
}

fn download_with_retry(url: &str, target_path: &str) -> Result<(), DownloadError> {
    let mut last_error = None;

    for attempt in 1..=MAX_RETRIES {
        match download_and_extract(url, target_path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                log_warn!(LOG_TAG, "Attempt {attempt}/{MAX_RETRIES} failed: {e}");
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

fn download_and_extract(url: &str, target_path: &str) -> Result<(), DownloadError> {
    fs::create_dir_all(target_path).map_err(|e| {
        DownloadError::fatal(format!("Failed to create directory {target_path}: {e}"))
    })?;

    let reader = source::open_archive(url)?;
    archive::extract_tar_gz(reader, target_path)
}

#[cfg(test)]
mod tests {
    use super::*;

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
                    DownloadTask::new(
                        "panic".to_owned(),
                        "storage_download",
                        "panic".to_owned(),
                        "/tmp/panic".to_owned(),
                        NotFoundPolicy::Fail,
                    ),
                    DownloadTask::new(
                        "success".to_owned(),
                        "storage_download",
                        "success".to_owned(),
                        "/tmp/success".to_owned(),
                        NotFoundPolicy::Fail,
                    ),
                ],
                runner,
            )
        });

        assert!(matches!(result, Ok(false)));
    }

    #[test]
    fn find_startable_download_counts_mount_conflict_deferrals() {
        let pending = VecDeque::from(vec![
            DownloadTask::new(
                "blocked child".to_owned(),
                "storage_download",
                "file:///tmp/archive.tar.gz".to_owned(),
                "/tmp/mount/child".to_owned(),
                NotFoundPolicy::Fail,
            ),
            DownloadTask::new(
                "independent".to_owned(),
                "artifact_download",
                "https://example.com/archive.tar.gz".to_owned(),
                "/tmp/other".to_owned(),
                NotFoundPolicy::Fail,
            ),
        ]);
        let active = vec![ActiveDownload {
            id: 0,
            mount_path: normalize_mount_path("/tmp/mount"),
        }];

        let startable = find_startable_download(&pending, &active);

        assert_eq!(startable.mount_conflict_deferrals, 1);
        assert_eq!(startable.selected.map(|(index, _)| index), Some(1));
    }

    #[test]
    fn download_task_failure_detail_includes_entry_metadata() {
        let task = DownloadTask::new(
            "storage 1 mountPath=/workspace vasStorageName=repo vasVersionId=v1 urlScheme=file cached=false"
                .into(),
            "storage_download",
            "file:///tmp/archive.tar.gz".into(),
            "/workspace".into(),
            NotFoundPolicy::Fail,
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
