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

    run_manifest(manifest)
}

/// Run the download process for a manifest supplied as JSON bytes.
/// Returns `true` if all downloads succeeded, `false` otherwise.
pub fn run_manifest_bytes(manifest_json: &[u8]) -> bool {
    let manifest = match Manifest::parse(manifest_json) {
        Ok(manifest) => manifest,
        Err(e) => {
            log_error!(LOG_TAG, "Failed to parse manifest: {e}");
            return false;
        }
    };

    run_manifest(manifest)
}

fn run_manifest(manifest: Manifest) -> bool {
    let RunPlan {
        cleanup_paths,
        instruction_cleanups,
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
    if !instruction_cleanups.is_empty() {
        instructions::cleanup_instruction_files(&instruction_cleanups);
    }

    // Pre-create all target directories before downloads. This keeps directory
    // creation independent from scheduler order; overlapping mount paths are
    // serialized by the download scheduler during extraction.
    for task in &download_tasks {
        let mount_path = task.mount_path();
        if let Err(e) = fs::create_dir_all(mount_path) {
            log_error!(LOG_TAG, "Failed to create directory {}: {e}", mount_path);
            instructions::cleanup_staged_instruction_sources(&instruction_files);
            return false;
        }
    }

    let success = download::download_all_parallel(download_tasks);
    if success {
        instructions::normalize_instruction_files(&instruction_files);
    } else {
        instructions::cleanup_staged_instruction_sources(&instruction_files);
    }
    success
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn run_manifest_removes_staged_instruction_source_when_download_fails() {
        let dir = tempfile::tempdir().unwrap();
        let extract_path = dir
            .path()
            .join("runtime")
            .join("storage-instructions")
            .join("0");
        let missing_archive = dir.path().join("missing.tar.gz");
        let manifest = json!({
            "storages": [{
                "mountPath": dir.path().join(".codex"),
                "extractPath": extract_path,
                "archiveUrl": format!("file://{}", missing_archive.display()),
                "instructionsTargetFilename": "AGENTS.md"
            }]
        });

        let success = super::run_manifest_bytes(&serde_json::to_vec(&manifest).unwrap());

        assert!(!success);
        assert!(!extract_path.exists());
    }

    #[test]
    fn run_manifest_removes_created_staged_instruction_sources_when_precreate_fails() {
        let dir = tempfile::tempdir().unwrap();
        let first_extract_path = dir
            .path()
            .join("runtime")
            .join("storage-instructions")
            .join("0");
        let blocker = dir.path().join("blocker");
        let blocked_extract_path = blocker.join("storage-instructions").join("1");
        std::fs::write(&blocker, "not a directory").unwrap();
        let archive = dir.path().join("archive.tar.gz");
        let manifest = json!({
            "storages": [
                {
                    "mountPath": dir.path().join(".codex"),
                    "extractPath": first_extract_path,
                    "archiveUrl": format!("file://{}", archive.display()),
                    "instructionsTargetFilename": "AGENTS.md"
                },
                {
                    "mountPath": dir.path().join(".claude"),
                    "extractPath": blocked_extract_path,
                    "archiveUrl": format!("file://{}", archive.display()),
                    "instructionsTargetFilename": "CLAUDE.md"
                }
            ]
        });

        let success = super::run_manifest_bytes(&serde_json::to_vec(&manifest).unwrap());

        assert!(!success);
        assert!(!first_extract_path.exists());
    }
}
