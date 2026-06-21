//! Storage manifest filtering and guest download helpers.

use sandbox::{EXEC_OUTPUT_LIMIT_1_MIB, ExecRequest, Sandbox};
use tracing::info;

use super::{DEFAULT_EXEC_TIMEOUT, RunnerError, RunnerResult, guest_runtime_dir};
use crate::helper_exec::{format_helper_exec_failure, helper_exec_succeeded};
use crate::paths::guest;
use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};
use crate::types::{
    ExecutionContext, GuestDownloadArtifactEntry, GuestDownloadManifest, GuestDownloadStorageEntry,
};

pub(super) fn filter_unchanged_storages(
    manifest: &GuestDownloadManifest,
    prev: &StorageFingerprints,
) -> GuestDownloadManifest {
    let mut skipped: usize = 0;
    let mut cleanup_paths: Vec<String> = Vec::new();

    let storages: Vec<GuestDownloadStorageEntry> = manifest
        .storages
        .iter()
        .map(|s| {
            let unchanged = prev.storages.get(&s.mount_path).is_some_and(|fingerprint| {
                fingerprint.matches(&s.vas_storage_name, &s.vas_version_id)
            });
            if unchanged {
                skipped += 1;
            } else {
                cleanup_paths.push(s.mount_path.clone());
            }
            GuestDownloadStorageEntry {
                archive_url: if unchanged {
                    None
                } else {
                    s.archive_url.clone()
                },
                instructions_target_filename: s.instructions_target_filename.clone(),
                cached: unchanged,
                ..s.clone()
            }
        })
        .collect();

    // Detect removed storages: paths in previous fingerprints not in current manifest.
    let current_paths: std::collections::HashSet<&str> = manifest
        .storages
        .iter()
        .map(|s| s.mount_path.as_str())
        .collect();
    for prev_path in prev.storages.keys() {
        if !current_paths.contains(prev_path.as_str()) {
            cleanup_paths.push(prev_path.clone());
        }
    }

    let filter_artifact = |a: &GuestDownloadArtifactEntry,
                           prev_ver: Option<&StorageFingerprint>,
                           skipped: &mut usize,
                           cleanup: &mut Vec<String>| {
        let same = prev_ver
            .is_some_and(|fingerprint| fingerprint.matches(&a.vas_storage_name, &a.vas_version_id));
        if same {
            *skipped += 1;
        } else {
            cleanup.push(a.mount_path.clone());
        }
        GuestDownloadArtifactEntry {
            archive_url: a.archive_url.clone(),
            cached: same,
            ..a.clone()
        }
    };

    let artifacts: Vec<GuestDownloadArtifactEntry> = manifest
        .artifacts
        .iter()
        .map(|a| {
            let prev_ver = prev.artifacts.get(&a.mount_path);
            filter_artifact(a, prev_ver, &mut skipped, &mut cleanup_paths)
        })
        .collect();
    // Detect removed artifacts: previous artifact mount_paths not in current manifest.
    let current_artifact_paths: std::collections::HashSet<&str> = manifest
        .artifacts
        .iter()
        .map(|a| a.mount_path.as_str())
        .collect();
    for prev_path in prev.artifacts.keys() {
        if !current_artifact_paths.contains(prev_path.as_str()) {
            cleanup_paths.push(prev_path.clone());
        }
    }
    if skipped > 0 {
        let total = manifest.storages.len() + manifest.artifacts.len();
        info!(skipped, total, "filtered unchanged storage entries");
    }

    if !cleanup_paths.is_empty() {
        info!(
            count = cleanup_paths.len(),
            "computed cleanup paths for stale file removal"
        );
    }

    GuestDownloadManifest {
        storages,
        artifacts,
        cleanup_paths,
    }
}

pub(super) fn guest_download_has_work(manifest: &GuestDownloadManifest) -> bool {
    manifest.storages.iter().any(|s| s.archive_url.is_some())
        || manifest.artifacts.iter().any(|a| a.archive_url.is_some())
        || !manifest.cleanup_paths.is_empty()
        || manifest
            .storages
            .iter()
            .any(|s| s.instructions_target_filename.is_some())
}

/// Download storage volumes into the guest.
pub(super) fn guest_download_command() -> String {
    format!("{} {}", guest::DOWNLOAD_BIN, guest::STORAGE_MANIFEST)
}

pub(super) fn guest_download_env<'a>(
    run_id: &'a str,
    runtime_dir: &'a str,
) -> [(&'static str, &'a str); 2] {
    [
        (guest_contracts::env::RUN_ID_ENV, run_id),
        (
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            runtime_dir,
        ),
    ]
}

pub(super) async fn download_storages(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    manifest: &GuestDownloadManifest,
) -> RunnerResult<()> {
    let manifest_json = serde_json::to_vec(manifest)
        .map_err(|e| RunnerError::Internal(format!("manifest json: {e}")))?;
    sandbox
        .write_file(guest::STORAGE_MANIFEST, &manifest_json)
        .await?;

    let download_cmd = guest_download_command();
    let run_id = context.run_id.to_string();
    let runtime_dir = guest_runtime_dir(context.run_id)?;
    let download_env = guest_download_env(&run_id, &runtime_dir);
    info!(run_id = %context.run_id, "downloading storages");
    let result = sandbox
        .exec(&ExecRequest {
            cmd: &download_cmd,
            timeout: DEFAULT_EXEC_TIMEOUT,
            env: &download_env,
            sudo: false,
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
        })
        .await?;

    if !helper_exec_succeeded(&result) {
        return Err(RunnerError::Internal(format_guest_download_failure(
            &result,
        )));
    }
    Ok(())
}

pub(super) fn format_guest_download_failure(result: &sandbox::SandboxExecResult) -> String {
    format_helper_exec_failure("storage download", result)
}
