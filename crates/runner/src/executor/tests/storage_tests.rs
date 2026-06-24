use std::collections::HashMap;

use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;
use sandbox::{ExecResult, ExecTermination};
use sandbox_mock::MockSandbox;

use super::super::guest_runtime_dir;
use super::super::storage::{
    apply_storage_fingerprint_reuse, download_storages, format_guest_download_failure,
    guest_download_command, guest_download_env, guest_download_has_work,
    guest_download_stdin_command,
};
use super::support::{minimal_context, sandbox_write_file_error};
use crate::helper_exec::{HELPER_EXEC_OUTPUT_EXCERPT_BYTES, format_command_output_excerpt};
use crate::paths::guest;
use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};
use crate::types::{GuestDownloadArtifactEntry, GuestDownloadManifest, GuestDownloadStorageEntry};

#[tokio::test]
async fn download_storages_success() {
    let sandbox = MockSandbox::new("test");
    // exec returns exit 0 by default.
    let ctx = minimal_context();
    let manifest = GuestDownloadManifest {
        storages: vec![guest_storage(
            "/data",
            "data",
            "v1",
            Some("https://s3/archive.tar.gz"),
        )],
        artifacts: vec![],
        cleanup_paths: vec![],
    };
    let manifest_json = serde_json::to_vec(&manifest).unwrap();
    download_storages(&sandbox, &ctx, &manifest).await.unwrap();

    assert!(sandbox.write_file_calls().is_empty());
    let exec_calls = sandbox.exec_calls();
    assert_eq!(exec_calls.len(), 1);
    assert_eq!(exec_calls[0].cmd, guest_download_stdin_command());
    assert_eq!(
        exec_calls[0].stdin_bytes.as_deref(),
        Some(manifest_json.as_slice())
    );
}

#[test]
fn guest_download_command_uses_guest_common_system_log_without_shell_redirect() {
    let cmd = guest_download_command();

    assert_eq!(
        cmd,
        "/usr/local/bin/guest-download /tmp/storage-manifest.json"
    );
    assert!(!cmd.contains(">>"));
    assert!(!cmd.contains("2>&1"));
    assert!(!cmd.contains("--system-log"));
}

#[test]
fn guest_download_stdin_command_uses_explicit_stdin_mode_without_shell_redirect() {
    let cmd = guest_download_stdin_command();

    assert_eq!(cmd, "/usr/local/bin/guest-download --manifest-stdin");
    assert!(!cmd.contains(">>"));
    assert!(!cmd.contains("2>&1"));
    assert!(!cmd.contains("--system-log"));
}

#[test]
fn guest_download_env_includes_run_id_for_guest_common_logs() {
    let ctx = minimal_context();
    let run_id = ctx.run_id.to_string();
    let runtime_dir = guest_runtime_dir(ctx.run_id).unwrap();
    let env = guest_download_env(&run_id, &runtime_dir);

    assert_eq!(env[0].0, "VM0_RUN_ID");
    assert_eq!(env[0].1, run_id);
    assert_eq!(
        env[1].0,
        guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV
    );
    assert_eq!(env[1].1, runtime_dir);
}

#[tokio::test]
async fn download_storages_exact_stdin_limit_uses_fast_path() {
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();
    let manifest = manifest_with_serialized_len(vsock_proto::MAX_EXEC_STDIN_BYTES);
    let manifest_json = serde_json::to_vec(&manifest).unwrap();
    assert_eq!(manifest_json.len(), vsock_proto::MAX_EXEC_STDIN_BYTES);

    download_storages(&sandbox, &ctx, &manifest).await.unwrap();

    assert!(sandbox.write_file_calls().is_empty());
    let exec_calls = sandbox.exec_calls();
    assert_eq!(exec_calls.len(), 1);
    assert_eq!(exec_calls[0].cmd, guest_download_stdin_command());
    assert_eq!(
        exec_calls[0].stdin_bytes.as_deref(),
        Some(manifest_json.as_slice())
    );
}

#[tokio::test]
async fn download_storages_oversized_manifest_falls_back_to_write_file() {
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();
    let manifest = manifest_with_serialized_len(vsock_proto::MAX_EXEC_STDIN_BYTES + 1);
    let manifest_json = serde_json::to_vec(&manifest).unwrap();

    download_storages(&sandbox, &ctx, &manifest).await.unwrap();

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, guest::STORAGE_MANIFEST);
    assert_eq!(writes[0].content, manifest_json);
    let exec_calls = sandbox.exec_calls();
    assert_eq!(exec_calls.len(), 1);
    assert_eq!(exec_calls[0].cmd, guest_download_command());
    assert!(exec_calls[0].stdin_bytes.is_none());
}

#[tokio::test]
async fn download_storages_nonzero_exit_code() {
    let sandbox = MockSandbox::new("test");
    // Exec returns non-zero so failure formatting includes helper output.
    sandbox.push_exec_result(Ok(ExecResult::new(
            1,
            b"stdout clue".to_vec(),
            b"[2026-05-20T18:03:00Z] [ERROR] [sandbox:guest-download] storage 1 mountPath=/workspace vasStorageName=repo vasVersionId=v1 urlScheme=file cached=false download failed: Failed to read archive entries: invalid gzip header".to_vec(),
        )));
    let ctx = minimal_context();
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![],
        cleanup_paths: vec![],
    };
    let err = download_storages(&sandbox, &ctx, &manifest)
        .await
        .unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("storage download failed (exit code 1)"));
    assert!(msg.contains("stderr (captured)"));
    assert!(msg.contains("mountPath=/workspace"));
    assert!(msg.contains("vasStorageName=repo"));
    assert!(msg.contains("Failed to read archive entries"));
    assert!(msg.contains("stdout (captured): stdout clue"));
}

#[tokio::test]
async fn download_storages_fails_on_non_exited_result() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult {
        termination: ExecTermination::TimedOut,
        stdout: b"partial stdout".to_vec(),
        stderr: b"Timeout".to_vec(),
        diagnostic: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    }));
    let ctx = minimal_context();
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![],
        cleanup_paths: vec![],
    };

    let err = download_storages(&sandbox, &ctx, &manifest)
        .await
        .unwrap_err();
    let msg = err.to_string();

    assert!(msg.contains("storage download failed (timed out)"));
    assert!(msg.contains("stderr (captured): Timeout"));
    assert!(msg.contains("stdout (captured): partial stdout"));
}

#[test]
fn guest_download_failure_output_redacts_url_queries() {
    let result = ExecResult {
        termination: ExecTermination::Exited { exit_code: 1 },
        stdout: Vec::new(),
        stderr: b"HTTP transport error for archiveUrl=https://storage.example/archive.tar.gz?X-Amz-Signature=secret"
            .to_vec(),
        diagnostic: String::new(),
        stdout_truncated: false,
        stderr_truncated: true,
    };

    let msg = format_guest_download_failure(&result);

    assert!(msg.contains("stderr (captured, sandbox-truncated)"));
    assert!(msg.contains("archiveUrl=https://storage.example/archive.tar.gz?<redacted>"));
    assert!(!msg.contains("secret"));
}

#[test]
fn guest_download_failure_redacts_url_query_before_excerpting() {
    let prefix = "HTTP transport error for archiveUrl=https://storage.example/archive.tar.gz?";
    let query_key = "X-Amz-Signature=";
    let secret_value = "secret-value-that-must-not-leak";
    let suffix = " download failed";
    let boundary_offset = "X-Amz-".len();
    let padding_len = HELPER_EXEC_OUTPUT_EXCERPT_BYTES + boundary_offset
        - query_key.len()
        - secret_value.len()
        - suffix.len();
    let query = format!("{query_key}{secret_value}{}", "a".repeat(padding_len));
    let result = ExecResult {
        termination: ExecTermination::Exited { exit_code: 1 },
        stdout: Vec::new(),
        stderr: format!("{prefix}{query}{suffix}").into_bytes(),
        diagnostic: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    };

    let msg = format_guest_download_failure(&result);

    assert!(msg.contains("storage download failed (exit code 1)"));
    assert!(msg.contains("stderr ("));
    assert!(msg.contains("archive.tar.gz?<redacted>"));
    assert!(!msg.contains("X-Amz-Signature"));
    assert!(!msg.contains(secret_value));
}

#[test]
fn command_output_redaction_preserves_whitespace_between_urls() {
    let msg = format_command_output_excerpt(
        "stderr",
        b"first=https://a.example/archive.tar.gz?token=secret\n\tsecond=http://b.example/logs?key=hidden plain=https://c.example/no-query",
        false,
    )
    .unwrap();

    assert!(msg.contains(
        "first=https://a.example/archive.tar.gz?<redacted>\n\tsecond=http://b.example/logs?<redacted> plain=https://c.example/no-query"
    ));
    assert!(!msg.contains("secret"));
    assert!(!msg.contains("hidden"));
}

#[test]
fn command_output_redaction_handles_case_insensitive_url_schemes() {
    let msg = format_command_output_excerpt(
        "stderr",
        b"archiveUrl=HTTPS://storage.example/archive.tar.gz?token=secret",
        false,
    )
    .unwrap();

    assert!(msg.contains("archiveUrl=HTTPS://storage.example/archive.tar.gz?<redacted>"));
    assert!(!msg.contains("secret"));
}

#[tokio::test]
async fn download_storages_fails_on_write_file_error() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_write_file_result(Err(sandbox_write_file_error("vsock write failed")));
    let ctx = minimal_context();
    let manifest = manifest_with_serialized_len(vsock_proto::MAX_EXEC_STDIN_BYTES + 1);
    let err = download_storages(&sandbox, &ctx, &manifest)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("vsock write failed"), "got: {err}");
    assert!(sandbox.exec_calls().is_empty());
}

// -----------------------------------------------------------------------
// apply_storage_fingerprint_reuse tests
// -----------------------------------------------------------------------

fn guest_art(name: &str, ver: &str, url: Option<&str>) -> GuestDownloadArtifactEntry {
    guest_art_with_policy(name, ver, url, None)
}

fn manifest_with_serialized_len(len: usize) -> GuestDownloadManifest {
    let mut manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![],
        cleanup_paths: vec![String::new()],
    };
    let empty_len = serde_json::to_vec(&manifest).unwrap().len();
    assert!(len >= empty_len);
    manifest.cleanup_paths[0] = "x".repeat(len - empty_len);
    assert_eq!(serde_json::to_vec(&manifest).unwrap().len(), len);
    manifest
}

fn guest_art_with_policy(
    name: &str,
    ver: &str,
    url: Option<&str>,
    missing_root_policy: Option<ArtifactEntryMissingRootPolicy>,
) -> GuestDownloadArtifactEntry {
    GuestDownloadArtifactEntry {
        mount_path: "/workspace".into(),
        archive_url: url.map(str::to_string),
        cached: false,
        vas_storage_name: name.into(),
        vas_storage_id: String::new(),
        vas_version_id: ver.into(),
        missing_root_policy,
    }
}

fn guest_storage(
    mount_path: &str,
    name: &str,
    ver: &str,
    url: Option<&str>,
) -> GuestDownloadStorageEntry {
    GuestDownloadStorageEntry {
        mount_path: mount_path.into(),
        archive_url: url.map(str::to_string),
        instructions_target_filename: None,
        cached: false,
        vas_storage_name: name.into(),
        vas_version_id: ver.into(),
    }
}

fn fp(name: &str, ver: &str) -> StorageFingerprint {
    StorageFingerprint::new(name, ver)
}

fn art_fp(mount: &str, name: &str, ver: &str) -> HashMap<String, StorageFingerprint> {
    let mut m = HashMap::new();
    m.insert(mount.into(), fp(name, ver));
    m
}

// -----------------------------------------------------------------------
// guest_download_has_work tests
// -----------------------------------------------------------------------

#[test]
fn guest_download_has_work_detects_instruction_normalization_without_archives() {
    let mut storage = guest_storage("/home/user/.codex", "instructions", "v1", None);
    storage.instructions_target_filename = Some("AGENTS.md".into());
    let manifest = GuestDownloadManifest {
        storages: vec![storage],
        artifacts: vec![],
        cleanup_paths: vec![],
    };

    assert!(guest_download_has_work(&manifest));
}

#[test]
fn guest_download_has_work_skips_fully_empty_cached_manifest() {
    let mut storage = guest_storage("/home/user/.codex", "instructions", "v1", None);
    storage.cached = true;
    let manifest = GuestDownloadManifest {
        storages: vec![storage],
        artifacts: vec![],
        cleanup_paths: vec![],
    };

    assert!(!guest_download_has_work(&manifest));
}

#[test]
fn guest_download_has_work_detects_archive_urls_and_cleanup_paths() {
    let storage_work = GuestDownloadManifest {
        storages: vec![guest_storage(
            "/data",
            "data",
            "v1",
            Some("https://s3/data"),
        )],
        artifacts: vec![],
        cleanup_paths: vec![],
    };
    assert!(guest_download_has_work(&storage_work));

    let artifact_work = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![guest_art("workspace", "v1", Some("https://s3/workspace"))],
        cleanup_paths: vec![],
    };
    assert!(guest_download_has_work(&artifact_work));

    let cleanup_work = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![],
        cleanup_paths: vec!["/old".into()],
    };
    assert!(guest_download_has_work(&cleanup_work));
}

#[test]
fn filter_same_artifact_version_keeps_url_for_mount_repair() {
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![guest_art("my-art", "v1", Some("https://s3/v1"))],
        cleanup_paths: vec![],
    };
    let prev = StorageFingerprints {
        storages: HashMap::new(),
        artifacts: art_fp("/workspace", "my-art", "v1"),
    };
    let result = apply_storage_fingerprint_reuse(&manifest, &prev);
    assert_eq!(
        result.artifacts[0].archive_url.as_deref(),
        Some("https://s3/v1")
    );
    assert!(result.artifacts[0].cached);
    assert!(!result.cleanup_paths.contains(&"/workspace".to_string()));
}

#[test]
fn filter_different_artifact_version_keeps_url() {
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![guest_art("my-art", "v2", Some("https://s3/v2"))],
        cleanup_paths: vec![],
    };
    let prev = StorageFingerprints {
        storages: HashMap::new(),
        artifacts: art_fp("/workspace", "my-art", "v1"),
    };
    let result = apply_storage_fingerprint_reuse(&manifest, &prev);
    assert_eq!(
        result.artifacts[0].archive_url.as_deref(),
        Some("https://s3/v2"),
    );
}

#[test]
fn filter_different_artifact_name_keeps_url() {
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![guest_art("other-art", "v1", Some("https://s3/v1"))],
        cleanup_paths: vec![],
    };
    let prev = StorageFingerprints {
        storages: HashMap::new(),
        artifacts: art_fp("/workspace", "my-art", "v1"),
    };
    let result = apply_storage_fingerprint_reuse(&manifest, &prev);
    assert!(result.artifacts[0].archive_url.is_some());
}

#[test]
fn filter_new_artifact_not_in_prev_keeps_url() {
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![guest_art("my-art", "v1", Some("https://s3/v1"))],
        cleanup_paths: vec![],
    };
    let prev = StorageFingerprints::default();
    let result = apply_storage_fingerprint_reuse(&manifest, &prev);
    assert!(result.artifacts[0].archive_url.is_some());
}

#[test]
fn filter_empty_prev_downloads_everything() {
    let manifest = GuestDownloadManifest {
        storages: vec![guest_storage(
            "/data",
            "vol-1",
            "v1",
            Some("https://s3/data"),
        )],
        artifacts: vec![guest_art("my-art", "v1", Some("https://s3/v1"))],
        cleanup_paths: vec![],
    };
    let prev = StorageFingerprints::default();
    let result = apply_storage_fingerprint_reuse(&manifest, &prev);
    assert!(result.storages[0].archive_url.is_some());
    assert!(result.artifacts[0].archive_url.is_some());
}

#[test]
fn filter_all_unchanged_nulls_storage_urls_and_keeps_artifact_urls() {
    let manifest = GuestDownloadManifest {
        storages: vec![guest_storage(
            "/data",
            "vol-1",
            "v1",
            Some("https://s3/same-url"),
        )],
        artifacts: vec![guest_art("my-art", "v1", Some("https://s3/v1"))],
        cleanup_paths: vec![],
    };
    let mut storages = HashMap::new();
    storages.insert("/data".into(), fp("vol-1", "v1"));
    let prev = StorageFingerprints {
        storages,
        artifacts: art_fp("/workspace", "my-art", "v1"),
    };
    let result = apply_storage_fingerprint_reuse(&manifest, &prev);
    assert!(result.storages[0].archive_url.is_none());
    assert!(result.storages[0].cached);
    assert_eq!(
        result.artifacts[0].archive_url.as_deref(),
        Some("https://s3/v1")
    );
    assert!(result.artifacts[0].cached);
}

#[test]
fn filter_two_artifacts_at_different_mount_paths() {
    let art_a = GuestDownloadArtifactEntry {
        mount_path: "/workspace".into(),
        archive_url: Some("https://s3/a-v2".into()),
        cached: false,
        vas_storage_name: "art-a".into(),
        vas_storage_id: String::new(),
        vas_version_id: "v2".into(),
        missing_root_policy: None,
    };
    let art_b = GuestDownloadArtifactEntry {
        mount_path: "/data".into(),
        archive_url: Some("https://s3/b-v1".into()),
        cached: false,
        vas_storage_name: "art-b".into(),
        vas_storage_id: String::new(),
        vas_version_id: "v1".into(),
        missing_root_policy: None,
    };
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![art_a, art_b],
        cleanup_paths: vec![],
    };
    // Previous fingerprints: art-a was v1 (changed), art-b was v1 (unchanged).
    let mut artifacts = HashMap::new();
    artifacts.insert("/workspace".into(), fp("art-a", "v1"));
    artifacts.insert("/data".into(), fp("art-b", "v1"));
    let prev = StorageFingerprints {
        storages: HashMap::new(),
        artifacts,
    };
    let result = apply_storage_fingerprint_reuse(&manifest, &prev);
    assert_eq!(result.artifacts.len(), 2);
    // art-a changed → keeps URL, not cached, cleanup path added
    assert!(result.artifacts[0].archive_url.is_some());
    assert!(!result.artifacts[0].cached);
    assert!(result.cleanup_paths.contains(&"/workspace".to_string()));
    // art-b unchanged -> URL retained for missing-root repair, still cached.
    assert_eq!(
        result.artifacts[1].archive_url.as_deref(),
        Some("https://s3/b-v1")
    );
    assert!(result.artifacts[1].cached);
}

#[test]
fn filter_detects_removed_artifacts() {
    // Current manifest has only one artifact; previous had two.
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![guest_art("kept", "v1", Some("https://s3/kept"))],
        cleanup_paths: vec![],
    };
    let mut artifacts = HashMap::new();
    artifacts.insert("/workspace".into(), fp("kept", "v1"));
    artifacts.insert("/old".into(), fp("removed", "v1"));
    let prev = StorageFingerprints {
        storages: HashMap::new(),
        artifacts,
    };
    let result = apply_storage_fingerprint_reuse(&manifest, &prev);
    // Removed artifact path must appear in cleanup_paths.
    assert!(result.cleanup_paths.contains(&"/old".to_string()));
}

#[test]
fn filter_cleanup_paths_keep_broad_phase_order() {
    let manifest = GuestDownloadManifest {
        storages: vec![guest_storage(
            "/storage-changed",
            "storage",
            "v2",
            Some("https://s3/storage"),
        )],
        artifacts: vec![GuestDownloadArtifactEntry {
            mount_path: "/artifact-changed".into(),
            archive_url: Some("https://s3/artifact".into()),
            cached: false,
            vas_storage_name: "artifact".into(),
            vas_storage_id: String::new(),
            vas_version_id: "v2".into(),
            missing_root_policy: None,
        }],
        cleanup_paths: vec![],
    };
    let prev = StorageFingerprints {
        storages: HashMap::from([
            ("/storage-changed".into(), fp("storage", "v1")),
            ("/storage-removed".into(), fp("removed-storage", "v1")),
        ]),
        artifacts: HashMap::from([
            ("/artifact-changed".into(), fp("artifact", "v1")),
            ("/artifact-removed".into(), fp("removed-artifact", "v1")),
        ]),
    };

    let result = apply_storage_fingerprint_reuse(&manifest, &prev);

    assert_eq!(
        result.cleanup_paths,
        vec![
            "/storage-changed",
            "/storage-removed",
            "/artifact-changed",
            "/artifact-removed"
        ]
    );
}

#[test]
fn filter_computes_cleanup_for_changed_storages() {
    let manifest = GuestDownloadManifest {
        storages: vec![
            guest_storage(
                "/home/user/.claude",
                "instructions",
                "v2",
                Some("https://s3/instructions"),
            ),
            guest_storage(
                "/home/user/.claude/skills/foo",
                "skill-foo",
                "v1",
                Some("https://s3/foo"),
            ),
        ],
        artifacts: vec![],
        cleanup_paths: vec![],
    };
    let mut storages = HashMap::new();
    storages.insert("/home/user/.claude".into(), fp("instructions", "v1"));
    storages.insert(
        "/home/user/.claude/skills/foo".into(),
        fp("skill-foo", "v1"),
    );
    let prev = StorageFingerprints {
        storages,
        artifacts: HashMap::new(),
    };
    let result = apply_storage_fingerprint_reuse(&manifest, &prev);
    // Instructions changed (v1→v2), skill-foo unchanged
    assert!(result.storages[0].archive_url.is_some());
    assert!(!result.storages[0].cached);
    assert!(result.storages[1].archive_url.is_none());
    assert!(result.storages[1].cached);
    // Only changed storage in cleanup_paths
    assert_eq!(result.cleanup_paths, vec!["/home/user/.claude"]);
}

#[test]
fn filter_detects_removed_storages() {
    let manifest = GuestDownloadManifest {
        storages: vec![guest_storage(
            "/home/user/.claude",
            "instructions",
            "v1",
            Some("https://s3/instructions"),
        )],
        artifacts: vec![],
        cleanup_paths: vec![],
    };
    let mut storages = HashMap::new();
    storages.insert("/home/user/.claude".into(), fp("instructions", "v1"));
    storages.insert(
        "/home/user/.claude/skills/old-skill".into(),
        fp("old-skill", "v1"),
    );
    let prev = StorageFingerprints {
        storages,
        artifacts: HashMap::new(),
    };
    let result = apply_storage_fingerprint_reuse(&manifest, &prev);
    // instructions unchanged, old-skill removed
    assert!(result.storages[0].archive_url.is_none());
    assert!(
        result
            .cleanup_paths
            .contains(&"/home/user/.claude/skills/old-skill".to_string())
    );
}

#[test]
fn filter_changed_artifact_adds_cleanup_path() {
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![guest_art("my-art", "v2", Some("https://s3/v2"))],
        cleanup_paths: vec![],
    };
    let prev = StorageFingerprints {
        storages: HashMap::new(),
        artifacts: art_fp("/workspace", "my-art", "v1"),
    };
    let result = apply_storage_fingerprint_reuse(&manifest, &prev);
    assert!(result.artifacts[0].archive_url.is_some());
    assert!(
        result
            .cleanup_paths
            .contains(&result.artifacts[0].mount_path)
    );
}

#[test]
fn filter_changed_artifact_with_null_url_adds_cleanup_path() {
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![guest_art("my-art", "v2", None)],
        cleanup_paths: vec![],
    };
    let prev = StorageFingerprints {
        storages: HashMap::new(),
        artifacts: art_fp("/workspace", "my-art", "v1"),
    };
    let result = apply_storage_fingerprint_reuse(&manifest, &prev);
    // Version changed → must be in cleanup_paths even though URL is absent.
    assert!(result.cleanup_paths.contains(&"/workspace".to_string()));
    assert!(!result.artifacts[0].cached);
}

#[test]
fn filter_unchanged_artifact_policy_does_not_force_redownload() {
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![guest_art_with_policy(
            "memory",
            "v1",
            Some("https://s3/memory"),
            Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion),
        )],
        cleanup_paths: vec![],
    };
    let prev = StorageFingerprints {
        storages: HashMap::new(),
        artifacts: art_fp("/workspace", "memory", "v1"),
    };

    let result = apply_storage_fingerprint_reuse(&manifest, &prev);

    assert_eq!(
        result.artifacts[0].archive_url.as_deref(),
        Some("https://s3/memory")
    );
    assert!(result.artifacts[0].cached);
    assert!(!result.cleanup_paths.contains(&"/workspace".to_string()));
}

#[test]
fn filter_changed_storage_with_null_url_adds_cleanup_path() {
    let manifest = GuestDownloadManifest {
        storages: vec![guest_storage("/data", "vol-1", "v2", None)],
        artifacts: vec![],
        cleanup_paths: vec![],
    };
    let mut storages = HashMap::new();
    storages.insert("/data".into(), fp("vol-1", "v1"));
    let prev = StorageFingerprints {
        storages,
        artifacts: HashMap::new(),
    };
    let result = apply_storage_fingerprint_reuse(&manifest, &prev);
    // Version changed → must be in cleanup_paths even though URL is absent.
    assert!(result.cleanup_paths.contains(&"/data".to_string()));
    assert!(!result.storages[0].cached);
}

#[test]
fn filter_unchanged_storage_sets_cached_true() {
    let manifest = GuestDownloadManifest {
        storages: vec![guest_storage(
            "/data",
            "vol-1",
            "v1",
            Some("https://s3/data"),
        )],
        artifacts: vec![],
        cleanup_paths: vec![],
    };
    let mut storages = HashMap::new();
    storages.insert("/data".into(), fp("vol-1", "v1"));
    let prev = StorageFingerprints {
        storages,
        artifacts: HashMap::new(),
    };
    let result = apply_storage_fingerprint_reuse(&manifest, &prev);
    assert!(result.storages[0].cached);
    assert!(result.storages[0].archive_url.is_none());
}

#[test]
fn filter_unchanged_storage_leaves_instruction_normalization_work() {
    let mut storage = guest_storage(
        "/home/user/.codex",
        "instructions",
        "v1",
        Some("https://s3/instructions"),
    );
    storage.instructions_target_filename = Some("AGENTS.md".into());
    let manifest = GuestDownloadManifest {
        storages: vec![storage],
        artifacts: vec![],
        cleanup_paths: vec![],
    };
    let prev = StorageFingerprints {
        storages: HashMap::from([("/home/user/.codex".into(), fp("instructions", "v1"))]),
        artifacts: HashMap::new(),
    };

    let result = apply_storage_fingerprint_reuse(&manifest, &prev);

    assert!(result.storages[0].cached);
    assert!(result.storages[0].archive_url.is_none());
    assert_eq!(
        result.storages[0].instructions_target_filename.as_deref(),
        Some("AGENTS.md")
    );
    assert!(result.cleanup_paths.is_empty());
    assert!(guest_download_has_work(&result));
}

#[test]
fn filter_tainted_paths_force_download_even_when_versions_match() {
    let manifest = GuestDownloadManifest {
        storages: vec![guest_storage(
            "/workspace/repo",
            "repo",
            "v1",
            Some("https://s3/repo"),
        )],
        artifacts: vec![GuestDownloadArtifactEntry {
            mount_path: "/workspace/artifact".into(),
            archive_url: Some("https://s3/artifact".into()),
            cached: false,
            vas_storage_name: "artifact".into(),
            vas_storage_id: String::new(),
            vas_version_id: "v1".into(),
            missing_root_policy: None,
        }],
        cleanup_paths: vec![],
    };
    let prev = StorageFingerprints {
        storages: HashMap::from([("/workspace/repo".into(), fp("repo", "v1"))]),
        artifacts: HashMap::from([("/workspace/artifact".into(), fp("artifact", "v1"))]),
    }
    .tainted_paths();

    let result = apply_storage_fingerprint_reuse(&manifest, &prev);

    assert_eq!(
        result.storages[0].archive_url.as_deref(),
        Some("https://s3/repo")
    );
    assert!(!result.storages[0].cached);
    assert_eq!(
        result.artifacts[0].archive_url.as_deref(),
        Some("https://s3/artifact")
    );
    assert!(!result.artifacts[0].cached);
    assert!(
        result
            .cleanup_paths
            .contains(&"/workspace/repo".to_string())
    );
    assert!(
        result
            .cleanup_paths
            .contains(&"/workspace/artifact".to_string())
    );
}

#[test]
fn filter_tainted_removed_paths_are_cleaned() {
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![],
        cleanup_paths: vec![],
    };
    let prev = StorageFingerprints {
        storages: HashMap::from([("/workspace/removed-storage".into(), fp("repo", "v1"))]),
        artifacts: HashMap::from([("/workspace/removed-artifact".into(), fp("artifact", "v1"))]),
    }
    .tainted_paths();

    let result = apply_storage_fingerprint_reuse(&manifest, &prev);

    assert!(
        result
            .cleanup_paths
            .contains(&"/workspace/removed-storage".to_string())
    );
    assert!(
        result
            .cleanup_paths
            .contains(&"/workspace/removed-artifact".to_string())
    );
}
