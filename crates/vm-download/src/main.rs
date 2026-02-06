//! VM Download Script - Downloads and extracts storage archives.
//!
//! Features:
//! - Parallel downloads using std::thread (max 4 concurrent)
//! - Streaming extraction (no temp files)
//! - Retry logic with 3 attempts

use serde::Deserialize;
use std::fs;
use std::sync::LazyLock;
use std::thread;
use std::time::{Duration, Instant};
use vm_common::{log_error, log_info, log_warn, telemetry::record_sandbox_op};

const LOG_TAG: &str = "sandbox:download";

/// Storage manifest format (matches TypeScript StorageManifest).
#[derive(Deserialize)]
struct Manifest {
    storages: Vec<Storage>,
    artifact: Option<Artifact>,
}

#[derive(Deserialize, Clone)]
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
    #[allow(dead_code)]
    vas_storage_name: String,
    #[allow(dead_code)]
    vas_version_id: String,
}

const MAX_RETRIES: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_secs(1);
const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_CONCURRENT: usize = 4;

/// Global HTTP agent with timeout configuration (created once, reused).
static HTTP_AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .build();
    config.into()
});

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let manifest_path = match args.get(1) {
        Some(p) => p,
        None => {
            log_error!(LOG_TAG, "Usage: vm-download <manifest_path>");
            std::process::exit(1);
        }
    };

    let start = Instant::now();
    let result = run(manifest_path);
    let duration_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(()) => {
            record_sandbox_op("download_total", duration_ms, true, None);
            log_info!(LOG_TAG, "Download completed in {duration_ms}ms");
        }
        Err(e) => {
            record_sandbox_op("download_total", duration_ms, false, Some(&e));
            log_error!(LOG_TAG, "Download failed: {e}");
            std::process::exit(1);
        }
    }
}

fn run(manifest_path: &str) -> Result<(), String> {
    // Read and parse manifest
    let manifest_json =
        fs::read_to_string(manifest_path).map_err(|e| format!("Failed to read manifest: {e}"))?;
    let manifest: Manifest = serde_json::from_str(&manifest_json)
        .map_err(|e| format!("Failed to parse manifest: {e}"))?;

    // Download storages in parallel
    download_storages_parallel(&manifest.storages)?;

    // Download artifact if present (after storages complete)
    if let Some(artifact) = &manifest.artifact
        && let Some(url) = &artifact.archive_url
    {
        let start = Instant::now();
        log_info!(LOG_TAG, "Downloading artifact to {}", artifact.mount_path);

        match download_with_retry(url, &artifact.mount_path) {
            Ok(()) => {
                let duration_ms = start.elapsed().as_millis() as u64;
                record_sandbox_op("artifact_download", duration_ms, true, None);
                log_info!(LOG_TAG, "Artifact downloaded in {duration_ms}ms");
            }
            Err(e) => {
                let duration_ms = start.elapsed().as_millis() as u64;
                record_sandbox_op("artifact_download", duration_ms, false, Some(&e));
                return Err(format!("Artifact download failed: {e}"));
            }
        }
    }

    Ok(())
}

/// Download all storages in parallel using std::thread.
/// Limits concurrency to MAX_CONCURRENT to avoid spawning too many threads.
fn download_storages_parallel(storages: &[Storage]) -> Result<(), String> {
    // Collect storages that need downloading (have archive_url)
    let download_tasks: Vec<_> = storages
        .iter()
        .enumerate()
        .filter_map(|(i, s)| {
            s.archive_url
                .as_ref()
                .map(|url| (i, url.clone(), s.mount_path.clone()))
        })
        .collect();

    // Create directories for storages without archive_url
    for storage in storages {
        if storage.archive_url.is_none() {
            fs::create_dir_all(&storage.mount_path)
                .map_err(|e| format!("Failed to create directory: {e}"))?;
        }
    }

    if download_tasks.is_empty() {
        return Ok(());
    }

    log_info!(
        LOG_TAG,
        "Downloading {} storages (max {} concurrent)",
        download_tasks.len(),
        MAX_CONCURRENT
    );

    // Process in chunks to limit concurrency
    for chunk in download_tasks.chunks(MAX_CONCURRENT) {
        let handles: Vec<_> = chunk
            .iter()
            .map(|(idx, url, mount_path)| {
                let idx = *idx;
                let url = url.clone();
                let mount_path = mount_path.clone();
                thread::spawn(move || {
                    let start = Instant::now();
                    log_info!(LOG_TAG, "Downloading storage {} to {}", idx + 1, mount_path);

                    let result = download_with_retry(&url, &mount_path);
                    let duration_ms = start.elapsed().as_millis() as u64;

                    match &result {
                        Ok(()) => {
                            record_sandbox_op("storage_download", duration_ms, true, None);
                            log_info!(
                                LOG_TAG,
                                "Storage {} downloaded in {}ms",
                                idx + 1,
                                duration_ms
                            );
                        }
                        Err(e) => {
                            record_sandbox_op("storage_download", duration_ms, false, Some(e));
                        }
                    }

                    result.map_err(|e| format!("Storage {} download failed: {}", idx + 1, e))
                })
            })
            .collect();

        // Wait for this chunk to complete before starting next
        for handle in handles {
            match handle.join() {
                Ok(Ok(())) => {}
                Ok(Err(e)) => return Err(e),
                Err(_) => return Err("Thread panicked".to_string()),
            }
        }
    }

    Ok(())
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
                "archiveUrl": "https://example.com/artifact.tar.gz",
                "vasStorageName": "test",
                "vasVersionId": "v1"
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
}
