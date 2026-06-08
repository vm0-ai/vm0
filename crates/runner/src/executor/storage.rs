//! Storage manifest filtering and guest download helpers.

use sandbox::{EXEC_OUTPUT_LIMIT_1_MIB, ExecRequest, Sandbox};
use tracing::info;

use super::{
    DEFAULT_EXEC_TIMEOUT, GUEST_DOWNLOAD_FAILURE_OUTPUT_BYTES, RunnerError, RunnerResult,
    guest_runtime_dir,
};
use crate::idle_pool::StorageFingerprints;
use crate::paths::guest;
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
                !StorageFingerprints::fingerprint_is_tainted(fingerprint)
                    && fingerprint.0.as_str() == s.vas_storage_name.as_str()
                    && fingerprint.1.as_str() == s.vas_version_id.as_str()
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
                           prev_ver: Option<&(String, String)>,
                           skipped: &mut usize,
                           cleanup: &mut Vec<String>| {
        let same = prev_ver.is_some_and(|fingerprint| {
            !StorageFingerprints::fingerprint_is_tainted(fingerprint)
                && fingerprint.0.as_str() == a.vas_storage_name.as_str()
                && fingerprint.1.as_str() == a.vas_version_id.as_str()
        });
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

/// Download storage volumes into the guest.
pub(super) fn guest_download_command() -> String {
    format!("{} {}", guest::DOWNLOAD_BIN, guest::STORAGE_MANIFEST)
}

pub(super) fn guest_download_env<'a>(
    run_id: &'a str,
    runtime_dir: &'a str,
) -> [(&'static str, &'a str); 2] {
    [
        ("VM0_RUN_ID", run_id),
        (guest_runtime_paths::GUEST_RUNTIME_DIR_ENV, runtime_dir),
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

    if result.exit_code != 0 {
        return Err(RunnerError::Internal(format_guest_download_failure(
            &result,
        )));
    }
    Ok(())
}

pub(super) fn format_guest_download_failure(result: &sandbox::ExecResult) -> String {
    format_guest_exec_failure("storage download", result)
}

pub(super) fn format_guest_exec_failure(operation: &str, result: &sandbox::ExecResult) -> String {
    let mut message = format!("{operation} failed (exit code {})", result.exit_code);

    if let Some(stderr) =
        format_command_output_excerpt("stderr", &result.stderr, result.stderr_truncated)
    {
        message.push_str("; ");
        message.push_str(&stderr);
    }
    if let Some(stdout) =
        format_command_output_excerpt("stdout", &result.stdout, result.stdout_truncated)
    {
        message.push_str("; ");
        message.push_str(&stdout);
    }

    message
}

pub(super) fn format_command_output_excerpt(
    label: &str,
    bytes: &[u8],
    sandbox_truncated: bool,
) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }

    let omitted_prefix = bytes.len() > GUEST_DOWNLOAD_FAILURE_OUTPUT_BYTES;
    let excerpt_start = if omitted_prefix {
        bytes.len() - GUEST_DOWNLOAD_FAILURE_OUTPUT_BYTES
    } else {
        0
    };
    let excerpt_bytes = bytes.get(excerpt_start..)?;
    let excerpt = String::from_utf8_lossy(excerpt_bytes);
    let excerpt = redact_url_query_strings(excerpt.trim());
    if excerpt.is_empty() {
        return None;
    }

    let mut qualifiers = Vec::new();
    if omitted_prefix {
        qualifiers.push("last 8192 bytes");
    } else {
        qualifiers.push("captured");
    }
    if sandbox_truncated {
        qualifiers.push("sandbox-truncated");
    }

    Some(format!("{label} ({}): {excerpt}", qualifiers.join(", ")))
}

pub(super) fn redact_url_query_strings(input: &str) -> String {
    input
        .split_whitespace()
        .map(redact_url_query_token)
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn redact_url_query_token(token: &str) -> String {
    for scheme in ["https://", "http://"] {
        if let Some((prefix, candidate)) = token.split_once(scheme)
            && let Some((base_url, _)) = candidate.split_once('?')
        {
            return format!("{prefix}{scheme}{base_url}?<redacted>");
        }
    }

    token.to_owned()
}
