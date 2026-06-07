use super::*;

#[tokio::test]
async fn download_storages_success() {
    let sandbox = MockSandbox::new("test");
    // write_file succeeds by default, exec returns exit 0 by default.
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
    download_storages(&sandbox, &ctx, &manifest).await.unwrap();
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
fn guest_download_env_includes_run_id_for_guest_common_logs() {
    let ctx = minimal_context();
    let run_id = ctx.run_id.to_string();
    let runtime_dir = guest_runtime_dir(ctx.run_id).unwrap();
    let env = guest_download_env(&run_id, &runtime_dir);

    assert_eq!(env[0].0, "VM0_RUN_ID");
    assert_eq!(env[0].1, run_id);
    assert_eq!(env[1].0, guest_runtime_paths::GUEST_RUNTIME_DIR_ENV);
    assert_eq!(env[1].1, runtime_dir);
}

#[tokio::test]
async fn download_storages_nonzero_exit_code() {
    let sandbox = MockSandbox::new("test");
    // write_file succeeds, but exec returns non-zero.
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

#[test]
fn guest_download_failure_output_redacts_url_queries() {
    let result = ExecResult {
            exit_code: 1,
            stdout: Vec::new(),
            stderr: b"HTTP transport error for archiveUrl=https://storage.example/archive.tar.gz?X-Amz-Signature=secret"
                .to_vec(),
            stdout_truncated: false,
            stderr_truncated: true,
        };

    let msg = format_guest_download_failure(&result);

    assert!(msg.contains("stderr (captured, sandbox-truncated)"));
    assert!(msg.contains("archiveUrl=https://storage.example/archive.tar.gz?<redacted>"));
    assert!(!msg.contains("secret"));
}

#[tokio::test]
async fn download_storages_fails_on_write_file_error() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_write_file_result(Err(sandbox_write_file_error("vsock write failed")));
    let ctx = minimal_context();
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![],
        cleanup_paths: vec![],
    };
    let err = download_storages(&sandbox, &ctx, &manifest)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("vsock write failed"), "got: {err}");
}

// -----------------------------------------------------------------------
// filter_unchanged_storages tests
// -----------------------------------------------------------------------

fn guest_art(name: &str, ver: &str, url: Option<&str>) -> GuestDownloadArtifactEntry {
    guest_art_with_policy(name, ver, url, None)
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

fn art_fp(mount: &str, name: &str, ver: &str) -> HashMap<String, (String, String)> {
    let mut m = HashMap::new();
    m.insert(mount.into(), (name.into(), ver.into()));
    m
}

#[test]
fn filter_same_artifact_version_keeps_url_for_mount_repair() {
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![guest_art("my-art", "v1", Some("https://s3/v1"))],
        cleanup_paths: vec![],
    };
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::new(),
        artifacts: art_fp("/workspace", "my-art", "v1"),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
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
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::new(),
        artifacts: art_fp("/workspace", "my-art", "v1"),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
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
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::new(),
        artifacts: art_fp("/workspace", "my-art", "v1"),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
    assert!(result.artifacts[0].archive_url.is_some());
}

#[test]
fn filter_new_artifact_not_in_prev_keeps_url() {
    let manifest = GuestDownloadManifest {
        storages: vec![],
        artifacts: vec![guest_art("my-art", "v1", Some("https://s3/v1"))],
        cleanup_paths: vec![],
    };
    let prev = crate::idle_pool::StorageFingerprints::default();
    let result = filter_unchanged_storages(&manifest, &prev);
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
    let prev = crate::idle_pool::StorageFingerprints::default();
    let result = filter_unchanged_storages(&manifest, &prev);
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
    storages.insert("/data".into(), ("vol-1".into(), "v1".into()));
    let prev = crate::idle_pool::StorageFingerprints {
        storages,
        artifacts: art_fp("/workspace", "my-art", "v1"),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
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
    artifacts.insert("/workspace".into(), ("art-a".into(), "v1".into()));
    artifacts.insert("/data".into(), ("art-b".into(), "v1".into()));
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::new(),
        artifacts,
    };
    let result = filter_unchanged_storages(&manifest, &prev);
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
    artifacts.insert("/workspace".into(), ("kept".into(), "v1".into()));
    artifacts.insert("/old".into(), ("removed".into(), "v1".into()));
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::new(),
        artifacts,
    };
    let result = filter_unchanged_storages(&manifest, &prev);
    // Removed artifact path must appear in cleanup_paths.
    assert!(result.cleanup_paths.contains(&"/old".to_string()));
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
    storages.insert(
        "/home/user/.claude".into(),
        ("instructions".into(), "v1".into()),
    );
    storages.insert(
        "/home/user/.claude/skills/foo".into(),
        ("skill-foo".into(), "v1".into()),
    );
    let prev = crate::idle_pool::StorageFingerprints {
        storages,
        artifacts: HashMap::new(),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
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
    storages.insert(
        "/home/user/.claude".into(),
        ("instructions".into(), "v1".into()),
    );
    storages.insert(
        "/home/user/.claude/skills/old-skill".into(),
        ("old-skill".into(), "v1".into()),
    );
    let prev = crate::idle_pool::StorageFingerprints {
        storages,
        artifacts: HashMap::new(),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
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
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::new(),
        artifacts: art_fp("/workspace", "my-art", "v1"),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
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
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::new(),
        artifacts: art_fp("/workspace", "my-art", "v1"),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
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
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::new(),
        artifacts: art_fp("/workspace", "memory", "v1"),
    };

    let result = filter_unchanged_storages(&manifest, &prev);

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
    storages.insert("/data".into(), ("vol-1".into(), "v1".into()));
    let prev = crate::idle_pool::StorageFingerprints {
        storages,
        artifacts: HashMap::new(),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
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
    storages.insert("/data".into(), ("vol-1".into(), "v1".into()));
    let prev = crate::idle_pool::StorageFingerprints {
        storages,
        artifacts: HashMap::new(),
    };
    let result = filter_unchanged_storages(&manifest, &prev);
    assert!(result.storages[0].cached);
    assert!(result.storages[0].archive_url.is_none());
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
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::from([("/workspace/repo".into(), ("repo".into(), "v1".into()))]),
        artifacts: HashMap::from([(
            "/workspace/artifact".into(),
            ("artifact".into(), "v1".into()),
        )]),
    }
    .tainted_paths();

    let result = filter_unchanged_storages(&manifest, &prev);

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
    let prev = crate::idle_pool::StorageFingerprints {
        storages: HashMap::from([(
            "/workspace/removed-storage".into(),
            ("repo".into(), "v1".into()),
        )]),
        artifacts: HashMap::from([(
            "/workspace/removed-artifact".into(),
            ("artifact".into(), "v1".into()),
        )]),
    }
    .tainted_paths();

    let result = filter_unchanged_storages(&manifest, &prev);

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
