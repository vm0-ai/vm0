//! Guest Download Script - Downloads and extracts storage archives.
//!
//! Features:
//! - Parallel downloads using std::thread (max 4 concurrent)
//! - Streaming extraction (no temp files)
//! - Retry logic with 3 attempts

use guest_common::{log_error, log_info, log_warn, telemetry::record_sandbox_op};
use serde::Deserialize;
use std::fs;
use std::sync::LazyLock;
use std::thread;
use std::time::{Duration, Instant};

const LOG_TAG: &str = "sandbox:download";

/// Storage manifest format (matches TypeScript StorageManifest).
#[derive(Deserialize)]
struct Manifest {
    #[serde(default)]
    storages: Vec<Storage>,
    artifact: Option<Artifact>,
    #[serde(default)]
    memory: Option<Artifact>,
}

/// Check if archive URL is valid (not None and not string "null").
fn is_valid_url(url: &Option<String>) -> bool {
    matches!(url, Some(u) if u != "null")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Storage {
    mount_path: String,
    archive_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Artifact {
    mount_path: String,
    archive_url: Option<String>,
}

const MAX_RETRIES: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_secs(1);
const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_CONCURRENT: usize = 4;

/// Global HTTP agent with timeout and system certificate verification.
/// Uses platform verifier to trust system CA certificates (including proxy CA).
static HTTP_AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    use ureq::tls::{RootCerts, TlsConfig};

    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .tls_config(
            TlsConfig::builder()
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .new_agent()
});

/// Run the download process for the given manifest file.
/// Returns `true` if all downloads succeeded, `false` otherwise.
pub fn run(manifest_path: &str) -> bool {
    // Read and parse manifest
    let manifest_json = match fs::read_to_string(manifest_path) {
        Ok(json) => json,
        Err(e) => {
            log_error!(LOG_TAG, "Failed to read manifest: {e}");
            return false;
        }
    };

    let manifest: Manifest = match serde_json::from_str(&manifest_json) {
        Ok(m) => m,
        Err(e) => {
            log_error!(LOG_TAG, "Failed to parse manifest: {e}");
            return false;
        }
    };

    // Build unified task list: storages + artifact + memory, all downloaded in parallel.
    let mut tasks: Vec<DownloadTask> = Vec::new();

    // Storages: 404 is fatal
    for (i, s) in manifest.storages.iter().enumerate() {
        if is_valid_url(&s.archive_url)
            && let Some(url) = s.archive_url.clone()
        {
            tasks.push(DownloadTask {
                label: format!("storage {}", i + 1),
                op_name: "storage_download",
                url,
                mount_path: s.mount_path.clone(),
                allow_404: false,
            });
        }
    }

    // Artifact: 404 is non-fatal (may not exist on first run)
    if let Some(artifact) = &manifest.artifact
        && is_valid_url(&artifact.archive_url)
        && let Some(url) = artifact.archive_url.clone()
    {
        tasks.push(DownloadTask {
            label: "artifact".to_string(),
            op_name: "artifact_download",
            url,
            mount_path: artifact.mount_path.clone(),
            allow_404: true,
        });
    }

    // Memory: 404 is non-fatal (may not exist on first run)
    if let Some(memory) = &manifest.memory
        && is_valid_url(&memory.archive_url)
        && let Some(url) = memory.archive_url.clone()
    {
        tasks.push(DownloadTask {
            label: "memory".to_string(),
            op_name: "memory_download",
            url,
            mount_path: memory.mount_path.clone(),
            allow_404: true,
        });
    }

    download_all_parallel(tasks)
}

struct DownloadTask {
    label: String,
    op_name: &'static str,
    url: String,
    mount_path: String,
    /// When true, HTTP 404 is treated as success (artifact/memory may not exist on first run).
    allow_404: bool,
}

/// Download all tasks in parallel using std::thread.
/// Limits concurrency to MAX_CONCURRENT to avoid spawning too many threads.
/// Returns true if all downloads succeeded, false if any failed.
fn download_all_parallel(tasks: Vec<DownloadTask>) -> bool {
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
                            record_sandbox_op(
                                task.op_name,
                                start.elapsed(),
                                false,
                                Some(&e.message),
                            );
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

struct DownloadError {
    message: String,
    retriable: bool,
    status_code: Option<u16>,
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
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

    Err(last_error.unwrap_or_else(|| DownloadError {
        message: "download failed with no error".into(),
        retriable: false,
        status_code: None,
    }))
}

fn download_and_extract(url: &str, target_path: &str) -> Result<(), DownloadError> {
    // Create target directory
    fs::create_dir_all(target_path).map_err(|e| DownloadError {
        message: format!("Failed to create directory {target_path}: {e}"),
        retriable: false,
        status_code: None,
    })?;

    // Make HTTP request using global agent
    let response = HTTP_AGENT.get(url).call().map_err(|e| {
        let (retriable, status_code) = match &e {
            // Retry on server errors (5xx) and rate limiting (429)
            ureq::Error::StatusCode(code) => (*code >= 500 || *code == 429, Some(*code)),
            _ => (true, None), // network/timeout errors are retriable
        };
        DownloadError {
            message: format!("HTTP {e} url={url}"),
            retriable,
            status_code,
        }
    })?;

    // Stream: HTTP response -> GzDecoder -> tar::Archive
    let reader = response.into_body().into_reader();
    let decoder = flate2::read::GzDecoder::new(reader);
    let mut archive = tar::Archive::new(decoder);

    // Extract to target path
    // Note: tar crate handles empty archives gracefully (returns Ok with 0 entries)
    archive.unpack(target_path).map_err(|e| DownloadError {
        message: format!("Failed to extract archive: {e}"),
        retriable: false,
        status_code: None,
    })?;

    Ok(())
}
