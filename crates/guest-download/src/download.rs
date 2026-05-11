use crate::LOG_TAG;
use crate::archive;
use crate::error::DownloadError;
use crate::source;
use guest_common::{log_error, log_info, log_warn, telemetry::record_sandbox_op};
use std::fs;
use std::thread;
use std::time::{Duration, Instant};

const MAX_RETRIES: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_secs(1);
const MAX_CONCURRENT: usize = 4;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct DownloadTask {
    label: String,
    op_name: &'static str,
    url: String,
    mount_path: String,
    /// When true, HTTP 404 is treated as success (artifact/memory may not exist on first run).
    allow_404: bool,
}

impl DownloadTask {
    pub(crate) fn new(
        label: String,
        op_name: &'static str,
        url: String,
        mount_path: String,
        allow_404: bool,
    ) -> Self {
        Self {
            label,
            op_name,
            url,
            mount_path,
            allow_404,
        }
    }

    pub(crate) fn mount_path(&self) -> &str {
        &self.mount_path
    }
}

/// Download all tasks in parallel using std::thread.
/// Limits concurrency to MAX_CONCURRENT to avoid spawning too many threads.
/// Returns true if all downloads succeeded, false if any failed.
pub(crate) fn download_all_parallel(tasks: Vec<DownloadTask>) -> bool {
    if tasks.is_empty() {
        return true;
    }

    log_info!(
        LOG_TAG,
        "Downloading {} items (max {} concurrent)",
        tasks.len(),
        MAX_CONCURRENT
    );

    let mut all_success = true;
    let mut tasks = tasks;

    // Process in chunks to limit concurrency
    while !tasks.is_empty() {
        let chunk: Vec<_> = tasks.drain(..tasks.len().min(MAX_CONCURRENT)).collect();

        let handles: Vec<_> = chunk
            .into_iter()
            .map(|task| {
                thread::spawn(move || {
                    let start = Instant::now();
                    log_info!(
                        LOG_TAG,
                        "Downloading {} from {} to {}",
                        task.label,
                        task.url,
                        task.mount_path
                    );

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
                        Err(e) if e.status_code == Some(404) && task.allow_404 => {
                            record_sandbox_op(task.op_name, start.elapsed(), true, None);
                            log_info!(LOG_TAG, "{} not found, skipping (first run)", task.label);
                            true
                        }
                        Err(e) => {
                            record_sandbox_op(
                                task.op_name,
                                start.elapsed(),
                                false,
                                Some(&e.message),
                            );
                            log_error!(LOG_TAG, "{} download failed: {}", task.label, e);
                            false
                        }
                    }
                })
            })
            .collect();

        // Wait for this chunk to complete before starting next
        for handle in handles {
            match handle.join() {
                Ok(success) => {
                    if !success {
                        all_success = false;
                    }
                }
                Err(e) => {
                    let msg = e
                        .downcast_ref::<String>()
                        .map(String::as_str)
                        .or_else(|| e.downcast_ref::<&str>().copied())
                        .unwrap_or("unknown");
                    log_error!(LOG_TAG, "Thread panicked: {msg}");
                    all_success = false;
                }
            }
        }
    }

    all_success
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
