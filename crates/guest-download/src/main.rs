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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let manifest_path = match args.get(1) {
        Some(p) => p,
        None => {
            log_error!(LOG_TAG, "Usage: guest-download <manifest_path>");
            std::process::exit(1);
        }
    };

    let start = Instant::now();
    let success = run(manifest_path);
    let elapsed = start.elapsed();

    if success {
        record_sandbox_op("download_total", elapsed, true, None);
        log_info!(LOG_TAG, "Download completed in {}ms", elapsed.as_millis());
    } else {
        record_sandbox_op("download_total", elapsed, false, None);
        log_error!(LOG_TAG, "Download failed");
        std::process::exit(1);
    }
}

fn run(manifest_path: &str) -> bool {
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

    let mut all_success = true;

    // Download storages in parallel
    if !download_storages_parallel(&manifest.storages) {
        all_success = false;
    }

    // Download artifact if present (after storages complete)
    if let Some(artifact) = &manifest.artifact
        && let Some(url) = &artifact.archive_url
        && url != "null"
    {
        let start = Instant::now();
        log_info!(LOG_TAG, "Downloading artifact to {}", artifact.mount_path);

        match download_with_retry(url, &artifact.mount_path) {
            Ok(()) => {
                let elapsed = start.elapsed();
                record_sandbox_op("artifact_download", elapsed, true, None);
                log_info!(LOG_TAG, "Artifact downloaded in {}ms", elapsed.as_millis());
            }
            Err(e) => {
                record_sandbox_op("artifact_download", start.elapsed(), false, Some(&e));
                log_error!(LOG_TAG, "Artifact download failed: {e}");
                all_success = false;
            }
        }
    }

    all_success
}

/// Download all storages in parallel using std::thread.
/// Limits concurrency to MAX_CONCURRENT to avoid spawning too many threads.
/// Returns true if all downloads succeeded, false if any failed.
fn download_storages_parallel(storages: &[Storage]) -> bool {
    // Collect storages that need downloading (have valid archive_url)
    let download_tasks: Vec<_> = storages
        .iter()
        .enumerate()
        .filter(|(_, s)| is_valid_url(&s.archive_url))
        .filter_map(|(i, s)| {
            s.archive_url
                .clone()
                .map(|url| (i, url, s.mount_path.clone()))
        })
        .collect();

    if download_tasks.is_empty() {
        return true;
    }

    log_info!(
        LOG_TAG,
        "Downloading {} storages (max {} concurrent)",
        download_tasks.len(),
        MAX_CONCURRENT
    );

    let mut all_success = true;
    let mut download_tasks = download_tasks;

    // Process in chunks to limit concurrency
    while !download_tasks.is_empty() {
        let chunk: Vec<_> = download_tasks
            .drain(..download_tasks.len().min(MAX_CONCURRENT))
            .collect();

        let handles: Vec<_> = chunk
            .into_iter()
            .map(|(idx, url, mount_path)| {
                thread::spawn(move || {
                    let start = Instant::now();
                    log_info!(LOG_TAG, "Downloading storage {} to {}", idx + 1, mount_path);

                    let result = download_with_retry(&url, &mount_path);
                    let elapsed = start.elapsed();

                    match &result {
                        Ok(()) => {
                            record_sandbox_op("storage_download", elapsed, true, None);
                            log_info!(
                                LOG_TAG,
                                "Storage {} downloaded in {}ms",
                                idx + 1,
                                elapsed.as_millis()
                            );
                        }
                        Err(e) => {
                            record_sandbox_op("storage_download", elapsed, false, Some(e));
                            log_error!(LOG_TAG, "Storage {} download failed: {}", idx + 1, e);
                        }
                    }

                    result.is_ok()
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
                Err(_) => {
                    log_error!(LOG_TAG, "Thread panicked");
                    all_success = false;
                }
            }
        }
    }

    all_success
}

fn download_with_retry(url: &str, target_path: &str) -> Result<(), String> {
    let mut last_error = String::new();

    for attempt in 1..=MAX_RETRIES {
        match download_and_extract(url, target_path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                log_warn!(LOG_TAG, "Attempt {attempt}/{MAX_RETRIES} failed: {e}");
                last_error = e;
                if attempt < MAX_RETRIES {
                    thread::sleep(RETRY_DELAY);
                }
            }
        }
    }

    Err(last_error)
}

fn download_and_extract(url: &str, target_path: &str) -> Result<(), String> {
    // Create target directory
    fs::create_dir_all(target_path)
        .map_err(|e| format!("Failed to create directory {target_path}: {e}"))?;

    // Make HTTP request using global agent
    let response = HTTP_AGENT
        .get(url)
        .call()
        .map_err(|e| format!("HTTP request failed: {e}"))?;

    // Stream: HTTP response -> GzDecoder -> tar::Archive
    let reader = response.into_body().into_reader();
    let decoder = flate2::read::GzDecoder::new(reader);
    let mut archive = tar::Archive::new(decoder);

    // Extract to target path
    // Note: tar crate handles empty archives gracefully (returns Ok with 0 entries)
    archive
        .unpack(target_path)
        .map_err(|e| format!("Failed to extract archive: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_manifest_basic() {
        let json = r#"{"storages":[{"mountPath":"/data"}]}"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.storages.len(), 1);
        assert_eq!(manifest.storages[0].mount_path, "/data");
        assert!(manifest.storages[0].archive_url.is_none());
    }

    #[test]
    fn test_parse_manifest_with_url() {
        let json = r#"{"storages":[{"mountPath":"/data","archiveUrl":"https://example.com/file.tar.gz"}]}"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert!(manifest.storages[0].archive_url.is_some());
    }

    #[test]
    fn test_parse_manifest_with_artifact() {
        let json = r#"{
            "storages": [],
            "artifact": {
                "mountPath": "/artifact",
                "archiveUrl": "https://example.com/artifact.tar.gz"
            }
        }"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert!(manifest.artifact.is_some());
        assert_eq!(manifest.artifact.unwrap().mount_path, "/artifact");
    }

    #[test]
    fn test_parse_manifest_empty_storages() {
        let json = r#"{"storages":[]}"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert!(manifest.storages.is_empty());
        assert!(manifest.artifact.is_none());
    }

    #[test]
    fn test_parse_manifest_missing_storages() {
        // storages field is optional due to #[serde(default)]
        let json = r#"{}"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert!(manifest.storages.is_empty());
    }

    #[test]
    fn test_is_valid_url_none() {
        assert!(!is_valid_url(&None));
    }

    #[test]
    fn test_is_valid_url_null_string() {
        assert!(!is_valid_url(&Some("null".to_string())));
    }

    #[test]
    fn test_is_valid_url_valid() {
        assert!(is_valid_url(&Some(
            "https://example.com/file.tar.gz".to_string()
        )));
    }
}
