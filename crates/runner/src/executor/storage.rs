//! Storage manifest filtering and guest download helpers.

use std::collections::{HashMap, HashSet};

use sandbox::{EXEC_OUTPUT_LIMIT_1_MIB, ExecRequest, Sandbox};
use tracing::info;

use super::{DEFAULT_EXEC_TIMEOUT, RunnerError, RunnerResult, guest_runtime_dir};
use crate::helper_exec::{format_helper_exec_failure, helper_exec_succeeded};
use crate::paths::guest;
use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};
use crate::types::{
    ExecutionContext, GuestDownloadArtifactEntry, GuestDownloadManifest, GuestDownloadStorageEntry,
};

#[derive(Default)]
struct ManifestReuseFilter {
    skipped: usize,
    cleanup_paths: Vec<String>,
}

impl ManifestReuseFilter {
    fn record_entry(
        &mut self,
        previous: Option<&StorageFingerprint>,
        mount_path: &str,
        vas_storage_name: &str,
        vas_version_id: &str,
    ) -> bool {
        let unchanged = previous
            .is_some_and(|fingerprint| fingerprint.matches(vas_storage_name, vas_version_id));
        if unchanged {
            self.skipped += 1;
        } else {
            self.cleanup_paths.push(mount_path.to_string());
        }
        unchanged
    }

    fn record_removed_paths<'a>(
        &mut self,
        previous: &HashMap<String, StorageFingerprint>,
        current_paths: impl IntoIterator<Item = &'a str>,
    ) {
        let current_paths: HashSet<&str> = current_paths.into_iter().collect();
        for prev_path in previous.keys() {
            if !current_paths.contains(prev_path.as_str()) {
                self.cleanup_paths.push(prev_path.clone());
            }
        }
    }
}

pub(super) fn apply_storage_fingerprint_reuse(
    manifest: &GuestDownloadManifest,
    prev: &StorageFingerprints,
) -> GuestDownloadManifest {
    let mut filter = ManifestReuseFilter::default();

    let storages: Vec<GuestDownloadStorageEntry> = manifest
        .storages
        .iter()
        .map(|s| {
            let unchanged = filter.record_entry(
                prev.storages.get(&s.mount_path),
                &s.mount_path,
                &s.vas_storage_name,
                &s.vas_version_id,
            );
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

    filter.record_removed_paths(
        &prev.storages,
        manifest.storages.iter().map(|s| s.mount_path.as_str()),
    );

    let artifacts: Vec<GuestDownloadArtifactEntry> = manifest
        .artifacts
        .iter()
        .map(|a| {
            let unchanged = filter.record_entry(
                prev.artifacts.get(&a.mount_path),
                &a.mount_path,
                &a.vas_storage_name,
                &a.vas_version_id,
            );
            GuestDownloadArtifactEntry {
                archive_url: a.archive_url.clone(),
                cached: unchanged,
                ..a.clone()
            }
        })
        .collect();

    filter.record_removed_paths(
        &prev.artifacts,
        manifest.artifacts.iter().map(|a| a.mount_path.as_str()),
    );

    let ManifestReuseFilter {
        skipped,
        cleanup_paths,
    } = filter;

    if skipped > 0 {
        let total = manifest.storages.len() + manifest.artifacts.len();
        info!(skipped, total, "filtered unchanged manifest entries");
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

pub(super) fn guest_download_stdin_command() -> String {
    format!("{} --manifest-stdin", guest::DOWNLOAD_BIN)
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
    let use_stdin = manifest_json.len() <= vsock_proto::MAX_EXEC_STDIN_BYTES;
    let download_cmd = if use_stdin {
        guest_download_stdin_command()
    } else {
        sandbox
            .write_file(guest::STORAGE_MANIFEST, &manifest_json)
            .await?;
        guest_download_command()
    };
    let stdin_bytes = use_stdin.then_some(manifest_json.as_slice());

    let run_id = context.run_id.to_string();
    let runtime_dir = guest_runtime_dir(context.run_id)?;
    let download_env = guest_download_env(&run_id, &runtime_dir);
    info!(run_id = %context.run_id, "downloading storages");
    let result = sandbox
        .exec_with_diagnostic_label(
            &ExecRequest {
                cmd: &download_cmd,
                timeout: DEFAULT_EXEC_TIMEOUT,
                env: &download_env,
                sudo: false,
                stdin_bytes,
                output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
            },
            "storage-download",
        )
        .await?;

    if !helper_exec_succeeded(&result) {
        return Err(RunnerError::Internal(format_guest_download_failure(
            &result,
        )));
    }
    Ok(())
}

pub(super) fn format_guest_download_failure(result: &sandbox::ExecResult) -> String {
    format_helper_exec_failure("storage download", result)
}
