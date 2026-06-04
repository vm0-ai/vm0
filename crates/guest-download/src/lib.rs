//! Guest Download Script - Downloads and extracts storage archives.
//!
//! Features:
//! - Parallel downloads using std::thread (max 4 concurrent)
//! - Streaming extraction (no temp files)
//! - Retry logic with 3 attempts

mod archive;
mod cleanup;
mod download;
mod error;
mod instructions;
mod manifest;
mod plan;
mod source;

use guest_common::{fs_status, log_error, log_info};
use manifest::{Manifest, ManifestLoadError};
use plan::RunPlan;
use std::fs;

const LOG_TAG: &str = "sandbox:download";

/// Run the download process for the given manifest file.
/// Returns `true` if all downloads succeeded, `false` otherwise.
pub fn run(manifest_path: &str) -> bool {
    let manifest = match Manifest::load(manifest_path) {
        Ok(manifest) => manifest,
        Err(ManifestLoadError::Read(e)) => {
            log_error!(LOG_TAG, "Failed to read manifest: {e}");
            return false;
        }
        Err(ManifestLoadError::Parse(e)) => {
            log_error!(LOG_TAG, "Failed to parse manifest: {e}");
            return false;
        }
    };

    let RunPlan {
        cleanup_paths,
        preserved_paths,
        download_tasks,
        instruction_files,
    } = RunPlan::from_manifest(&manifest);

    // Clean stale files from changed/removed storages before downloading.
    // This must run before parallel downloads to avoid race conditions with
    // parent-child mount path overlaps.
    if !cleanup_paths.is_empty() {
        cleanup::cleanup_stale_paths(&cleanup_paths, &preserved_paths);
    }

    // Pre-create all target directories before downloads. This keeps directory
    // creation independent from scheduler order; overlapping mount paths are
    // serialized by the download scheduler during extraction.
    for task in &download_tasks {
        let mount_path = task.mount_path();
        if let Err(e) = fs::create_dir_all(mount_path) {
            log_error!(LOG_TAG, "Failed to create directory {}: {e}", mount_path);
            return false;
        }
    }

    let download_roots = download_tasks
        .iter()
        .map(|task| (task.label().to_string(), task.mount_path().to_string()))
        .collect::<Vec<_>>();

    let success = download::download_all_parallel(download_tasks);
    if success {
        instructions::normalize_instruction_files(&instruction_files);
        log_download_root_statuses("after instruction normalization", &download_roots);
    }
    success
}

fn log_download_root_statuses(phase: &str, roots: &[(String, String)]) {
    for (label, mount_path) in roots {
        log_info!(
            LOG_TAG,
            "Download root status {phase}: {label} {}",
            fs_status::describe_path(mount_path)
        );
    }
}
