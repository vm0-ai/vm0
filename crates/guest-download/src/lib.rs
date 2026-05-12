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

use guest_common::log_error;
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

    let success = download::download_all_parallel(download_tasks);
    if success {
        instructions::normalize_instruction_files(&instruction_files);
    }
    success
}
