use super::test_support::{TEST_WORKSPACE_IMAGE_SIZE_BYTES, WorkspacePromotionFixture};
use super::*;

use std::sync::Arc;
use std::time::Duration;

use api_contracts::generated::constants::runners::{
    RESUME_SESSION_HISTORY_MAX_BYTES, paths::CANONICAL_WORKING_DIR,
};
use async_trait::async_trait;
use guest_contracts::session_history_identity::{
    FinalSessionHistoryFramework, FinalSessionHistoryIdentity, FinalSessionHistoryRefKind,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ, SessionHistorySidecarExportMetadata,
    SessionHistorySidecarRepresentation,
};
use sandbox::{
    CopyFileOptions, CopyFileResult, ExecRequest, ExecResult, GuestProcessHandle, ProcessExit,
    Sandbox, SandboxFactory, SandboxId, StartProcessRequest,
};
use sandbox_mock::{ExecMatcher, MockSandbox, MockSandboxFactory, MockSandboxOverrides};
use sha2::{Digest, Sha256};
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

use crate::ids::RunId;
use crate::restored_session_identity::RestoredSessionIdentity;
use crate::workspace_image_cache::{
    WorkspaceCacheCheckoutResult, WorkspaceImageLeaseIdentity, WorkspaceImagePrepareRequest,
};

async fn mock_sandbox_with_overrides(
    sandbox_id: SandboxId,
    overrides: Arc<MockSandboxOverrides>,
) -> Box<dyn Sandbox> {
    let factory = MockSandboxFactory::with_overrides(overrides);
    factory
        .create(sandbox::SandboxConfig {
            id: sandbox_id,
            resources: sandbox::ResourceLimits {
                cpu_count: 2,
                memory_mb: 4096,
            },
            device_rate_limits: None,
            workspace_drive: None,
        })
        .await
        .expect("create sandbox")
}

fn test_restored_session_identity(session_id: &str, history: &[u8]) -> RestoredSessionIdentity {
    let metadata = FinalSessionHistoryIdentity::new(
        FinalSessionHistoryFramework::ClaudeCode,
        hex::encode(Sha256::digest(session_id.as_bytes())),
        FinalSessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
        format!("/home/user/.claude/projects/-home-user-workspace/{session_id}.jsonl"),
    )
    .unwrap();
    RestoredSessionIdentity::from_final_metadata(
        metadata,
        "/home/user/.vm0/guest-agent/runs/run-1/final-session-history-identity.json",
        "/home/user/.vm0/guest-agent/runs/run-1",
    )
    .unwrap()
}

async fn prepare_and_publish_workspace_image(
    sandbox: &dyn Sandbox,
    promotion: WorkspaceImagePromotionContext,
) -> bool {
    match prepare_workspace_image_from_active_sandbox(sandbox, Some(promotion), "test").await {
        Some(prepared) => prepared.publish().await,
        None => false,
    }
}

struct PostCopyGateSandbox {
    inner: MockSandbox,
    copy_completed: Arc<tokio::sync::Barrier>,
    copy_release: Arc<tokio::sync::Notify>,
}

impl PostCopyGateSandbox {
    fn new(id: impl Into<String>) -> Self {
        Self {
            inner: MockSandbox::new(id),
            copy_completed: Arc::new(tokio::sync::Barrier::new(2)),
            copy_release: Arc::new(tokio::sync::Notify::new()),
        }
    }

    async fn wait_for_copy(&self) {
        self.copy_completed.wait().await;
    }

    fn release_copy(&self) {
        self.copy_release.notify_one();
    }
}

#[async_trait]
impl Sandbox for PostCopyGateSandbox {
    fn id(&self) -> &str {
        self.inner.id()
    }

    fn source_ip(&self) -> &str {
        self.inner.source_ip()
    }

    async fn start(&mut self) -> sandbox::Result<()> {
        self.inner.start().await
    }

    async fn stop(&mut self) -> sandbox::Result<()> {
        self.inner.stop().await
    }

    async fn kill(&mut self) -> sandbox::Result<()> {
        self.inner.kill().await
    }

    async fn park(&mut self) -> sandbox::Result<sandbox::SandboxParkOutcome> {
        self.inner.park().await
    }

    async fn unpark(&mut self) -> sandbox::Result<()> {
        self.inner.unpark().await
    }

    async fn exec(&self, request: &ExecRequest<'_>) -> sandbox::Result<ExecResult> {
        self.inner.exec(request).await
    }

    async fn read_file(&self, path: &str, max_bytes: u64) -> sandbox::Result<Option<Vec<u8>>> {
        self.inner.read_file(path, max_bytes).await
    }

    async fn copy_file(
        &self,
        path: &str,
        host_path: &std::path::Path,
        options: CopyFileOptions,
    ) -> sandbox::Result<CopyFileResult> {
        let result = self.inner.copy_file(path, host_path, options).await;
        self.copy_completed.wait().await;
        self.copy_release.notified().await;
        result
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        self.inner.write_file(path, content).await
    }

    async fn write_private_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        self.inner.write_private_file(path, content).await
    }

    async fn start_process(
        &self,
        request: &StartProcessRequest<'_>,
    ) -> sandbox::Result<GuestProcessHandle> {
        self.inner.start_process(request).await
    }

    async fn wait_process(
        &self,
        handle: GuestProcessHandle,
        timeout: Duration,
    ) -> sandbox::Result<ProcessExit> {
        self.inner.wait_process(handle, timeout).await
    }
}

struct PanicExecSandbox {
    id: String,
}

impl PanicExecSandbox {
    fn new(id: impl Into<String>) -> Self {
        Self { id: id.into() }
    }
}

#[async_trait]
impl Sandbox for PanicExecSandbox {
    fn id(&self) -> &str {
        &self.id
    }

    fn source_ip(&self) -> &str {
        "10.0.0.1"
    }

    async fn start(&mut self) -> sandbox::Result<()> {
        Ok(())
    }

    async fn stop(&mut self) -> sandbox::Result<()> {
        Ok(())
    }

    async fn kill(&mut self) -> sandbox::Result<()> {
        Ok(())
    }

    async fn park(&mut self) -> sandbox::Result<sandbox::SandboxParkOutcome> {
        Ok(sandbox::SandboxParkOutcome::Reusable)
    }

    async fn unpark(&mut self) -> sandbox::Result<()> {
        Ok(())
    }

    async fn exec(&self, _request: &ExecRequest<'_>) -> sandbox::Result<ExecResult> {
        panic!("simulated exec panic");
    }

    async fn read_file(&self, _path: &str, _max_bytes: u64) -> sandbox::Result<Option<Vec<u8>>> {
        Ok(None)
    }

    async fn copy_file(
        &self,
        _path: &str,
        _host_path: &std::path::Path,
        _options: CopyFileOptions,
    ) -> sandbox::Result<CopyFileResult> {
        panic!("unused copy_file");
    }

    async fn write_file(&self, _path: &str, _content: &[u8]) -> sandbox::Result<()> {
        Ok(())
    }

    async fn write_private_file(&self, _path: &str, _content: &[u8]) -> sandbox::Result<()> {
        panic!("unused write_private_file");
    }

    async fn start_process(
        &self,
        _request: &StartProcessRequest<'_>,
    ) -> sandbox::Result<GuestProcessHandle> {
        panic!("unused start_process");
    }

    async fn wait_process(
        &self,
        _handle: GuestProcessHandle,
        _timeout: Duration,
    ) -> sandbox::Result<ProcessExit> {
        panic!("unused wait_process");
    }
}

#[tokio::test]
async fn parked_workspace_promotion_unparks_and_freezes_before_publish() {
    let fixture = WorkspacePromotionFixture::new("sess-parked-promote").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let mut sandbox = mock_sandbox_with_overrides(fixture.sandbox_id, Arc::clone(&overrides)).await;

    let prepared = prepare_workspace_image_from_parked_sandbox(
        sandbox.as_mut(),
        Some(fixture.promotion),
        "test",
    )
    .await
    .expect("workspace promotion should prepare");

    assert_eq!(overrides.unpark_call_count(), 1);
    let exec_calls = overrides.exec_calls();
    assert_eq!(exec_calls.len(), 1);
    assert!(exec_calls[0].sudo);
    let freeze_command = &exec_calls[0].cmd;
    assert!(freeze_command.contains("workspace_dir='/home/user/workspace'"));
    assert!(freeze_command.contains("workspace_device='/dev/vdb'"));
    assert!(freeze_command.contains("refuse_workspace_symlink_path"));
    assert!(freeze_command.contains("mountpoint -q -- \"$workspace_dir\""));
    assert!(freeze_command.contains("exec 3< \"$workspace_dir\""));
    assert!(freeze_command.contains("mountpoint -d -- \"$workspace_fd_path\""));
    assert!(freeze_command.contains("fsfreeze --freeze \"$workspace_fd_path\""));
    assert!(!freeze_command.contains("--unfreeze"));
    assert!(!freeze_command.contains("umount"));
    assert!(!freeze_command.contains("kill "));
    assert!(!freeze_command.contains("pkill"));
    assert!(!freeze_command.contains("killall"));
    assert!(
        fixture.cache.held_workspace_states().await.is_empty(),
        "a frozen image must not be published before the caller stops the sandbox"
    );

    let promoted = prepared.publish().await;

    assert!(promoted);
    let states = fixture.cache.held_workspace_states().await;
    assert_eq!(states.len(), 1);
    assert_eq!(states[0].reuse_key, fixture.reuse_key);
}

#[tokio::test]
async fn active_workspace_promotion_exports_session_history_sidecar() {
    let reuse_key = "thread:active-sidecar-promote";
    let session_id = "sess-active-sidecar-promote";
    let history = br#"{"type":"message","content":"cached"}"#;
    let restored_identity = test_restored_session_identity(session_id, history);
    let fixture = WorkspacePromotionFixture::new_with_restored_session_identity(
        reuse_key,
        Some(&restored_identity),
    )
    .await;
    assert!(fixture.promotion.restored_session_identity().is_some());
    let sandbox = sandbox_mock::MockSandbox::new(fixture.sandbox_id.to_string());
    let export_metadata = SessionHistorySidecarExportMetadata {
        representation: SessionHistorySidecarRepresentation::Raw,
        encoded_size: history.len() as u64,
    };
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&export_metadata).unwrap(),
        Vec::new(),
    )));
    sandbox.push_copy_file_result(Ok(history.to_vec()));

    let (promoted, events) = capture_promotion_events(async {
        prepare_workspace_image_from_active_sandbox(&sandbox, Some(fixture.promotion), "test")
            .await
            .expect("workspace promotion should prepare")
            .publish()
            .await
    })
    .await;

    assert!(promoted);
    let promotion_event = captured_event(&events, "workspace image cache promoted");
    assert_eq!(
        promotion_event
            .fields
            .get("transfer_mode")
            .map(String::as_str),
        Some("rename")
    );
    assert_eq!(
        promotion_event.fields.get("outcome").map(String::as_str),
        Some("promoted")
    );
    assert_eq!(
        promotion_event
            .fields
            .get("logical_image_size_bytes")
            .and_then(|value| value.parse::<u64>().ok()),
        Some(TEST_WORKSPACE_IMAGE_SIZE_BYTES)
    );
    for field in ["transfer_ms", "promotion_ms"] {
        promotion_event.fields[field]
            .parse::<u64>()
            .unwrap_or_else(|error| panic!("invalid {field}: {error}; event={promotion_event:#?}"));
    }
    let exec_calls = sandbox.exec_calls();
    assert_eq!(exec_calls.len(), 3);
    assert!(exec_calls[0].cmd.contains("export-session-history-sidecar"));
    assert!(exec_calls[1].cmd.contains("rm -f --"));
    assert!(exec_calls[1].cmd.contains("/session-history-sidecar"));
    assert!(exec_calls[2].sudo);
    let copy_calls = sandbox.copy_file_calls();
    assert_eq!(copy_calls.len(), 1);
    assert!(copy_calls[0].path.ends_with("/session-history-sidecar"));
    assert_eq!(copy_calls[0].max_bytes, RESUME_SESSION_HISTORY_MAX_BYTES);
    let sidecar_entry_dir = copy_calls[0].host_path.parent().unwrap();
    let sidecar_metadata_path = sidecar_entry_dir.join("session-history.metadata.json");
    if !sidecar_metadata_path.is_file() {
        let entries = std::fs::read_dir(sidecar_entry_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        panic!("missing sidecar metadata; entries={entries:?}; events={events:#?}");
    }

    let lease = fixture
        .cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default",
                reuse_key: Some(reuse_key),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: TEST_WORKSPACE_IMAGE_SIZE_BYTES,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Hit);
    let sidecar = lease
        .probe_session_history_sidecar(&restored_identity)
        .await
        .unwrap();
    assert_eq!(tokio::fs::read(sidecar.path).await.unwrap(), history);
}

#[tokio::test(flavor = "current_thread")]
async fn active_workspace_promotion_keeps_history_read_failure_warning() {
    let reuse_key = "thread:active-sidecar-read-failure";
    let session_id = "sess-active-sidecar-read-failure";
    let history = br#"{"type":"message","content":"read failure"}"#;
    let restored_identity = test_restored_session_identity(session_id, history);
    let fixture = WorkspacePromotionFixture::new_with_restored_session_identity(
        reuse_key,
        Some(&restored_identity),
    )
    .await;
    let sandbox = MockSandbox::new(fixture.sandbox_id.to_string());
    sandbox.push_exec_result(Ok(ExecResult::new(
        SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ,
        Vec::new(),
        Vec::new(),
    )));

    let (promoted, events) = capture_promotion_events(prepare_and_publish_workspace_image(
        &sandbox,
        fixture.promotion,
    ))
    .await;

    assert!(promoted);
    assert!(sandbox.copy_file_calls().is_empty());
    captured_event(
        &events,
        "workspace image cache session history sidecar export failed",
    );
    let exec_calls = sandbox.exec_calls();
    assert_eq!(exec_calls.len(), 3);
    assert!(exec_calls[0].expected_exit_codes.is_empty());
}

#[tokio::test]
async fn session_history_sidecar_staging_is_protected_from_gc() {
    let reuse_key = "thread:late-sidecar-gc";
    let session_id = "sess-late-sidecar-gc";
    let history = br#"{"type":"message","content":"late cached"}"#;
    let restored_identity = test_restored_session_identity(session_id, history);
    let fixture = WorkspacePromotionFixture::new_with_restored_session_identity(
        reuse_key,
        Some(&restored_identity),
    )
    .await;
    let cache = fixture.cache.clone();
    let sandbox = PostCopyGateSandbox::new(fixture.sandbox_id.to_string());
    let export_metadata = SessionHistorySidecarExportMetadata {
        representation: SessionHistorySidecarRepresentation::Raw,
        encoded_size: history.len() as u64,
    };
    sandbox.inner.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&export_metadata).unwrap(),
        Vec::new(),
    )));
    sandbox.inner.push_copy_file_result(Ok(history.to_vec()));

    let (promoted, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(
            prepare_and_publish_workspace_image(&sandbox, fixture.promotion),
            async {
                sandbox.wait_for_copy().await;
                let copy_calls = sandbox.inner.copy_file_calls();
                assert_eq!(copy_calls.len(), 1);
                let tmp_path = &copy_calls[0].host_path;
                let entry_dir = tmp_path.parent().unwrap();
                assert!(tmp_path.is_file());
                assert!(entry_dir.is_dir());

                let freed = cache.gc(false).await.unwrap();

                assert_eq!(freed, 0);
                assert!(tmp_path.is_file());
                assert!(entry_dir.is_dir());
                sandbox.release_copy();
            },
        )
    })
    .await
    .expect("sidecar promotion and GC interleaving must complete");

    assert!(promoted);
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default",
                reuse_key: Some(reuse_key),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: TEST_WORKSPACE_IMAGE_SIZE_BYTES,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Hit);
    let sidecar = lease
        .probe_session_history_sidecar(&restored_identity)
        .await
        .unwrap();
    assert_eq!(tokio::fs::read(sidecar.path).await.unwrap(), history);
}

#[tokio::test]
async fn session_history_sidecar_staging_cleans_source_and_unlocks_when_cancelled() {
    let reuse_key = "thread:late-sidecar-cancelled";
    let session_id = "sess-late-sidecar-cancelled";
    let history = br#"{"type":"message","content":"cancelled"}"#;
    let restored_identity = test_restored_session_identity(session_id, history);
    let fixture = WorkspacePromotionFixture::new_with_restored_session_identity(
        reuse_key,
        Some(&restored_identity),
    )
    .await;
    let cache = fixture.cache.clone();
    let sandbox = Arc::new(PostCopyGateSandbox::new(fixture.sandbox_id.to_string()));
    let export_metadata = SessionHistorySidecarExportMetadata {
        representation: SessionHistorySidecarRepresentation::Raw,
        encoded_size: history.len() as u64,
    };
    sandbox.inner.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&export_metadata).unwrap(),
        Vec::new(),
    )));
    sandbox.inner.push_copy_file_result(Ok(history.to_vec()));
    let promotion = fixture.promotion;
    let promotion_sandbox = Arc::clone(&sandbox);
    let promotion_task = tokio::spawn(async move {
        prepare_and_publish_workspace_image(promotion_sandbox.as_ref(), promotion).await
    });

    tokio::time::timeout(Duration::from_secs(5), sandbox.wait_for_copy())
        .await
        .expect("sidecar host copy must complete before cancellation");
    let copy_calls = sandbox.inner.copy_file_calls();
    assert_eq!(copy_calls.len(), 1);
    let tmp_path = copy_calls[0].host_path.clone();
    assert!(tmp_path.is_file());

    promotion_task.abort();
    let join_error = promotion_task
        .await
        .expect_err("cancelled promotion task must not complete normally");

    assert!(join_error.is_cancelled());
    assert!(!tmp_path.exists());
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default",
                reuse_key: Some(reuse_key),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: TEST_WORKSPACE_IMAGE_SIZE_BYTES,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn session_history_sidecar_staging_cleans_source_and_unlocks_after_freeze_failure() {
    let reuse_key = "thread:late-sidecar-freeze-failure";
    let session_id = "sess-late-sidecar-freeze-failure";
    let history = br#"{"type":"message","content":"freeze"}"#;
    let restored_identity = test_restored_session_identity(session_id, history);
    let fixture = WorkspacePromotionFixture::new_with_restored_session_identity(
        reuse_key,
        Some(&restored_identity),
    )
    .await;
    let cache = fixture.cache.clone();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.add_exec_matcher(ExecMatcher {
        pattern: "fsfreeze --freeze".into(),
        exit_code: 64,
        stdout: Vec::new(),
        stderr: b"not mounted".to_vec(),
    });
    let sandbox =
        MockSandbox::with_overrides(fixture.sandbox_id.to_string(), Arc::clone(&overrides));
    let export_metadata = SessionHistorySidecarExportMetadata {
        representation: SessionHistorySidecarRepresentation::Raw,
        encoded_size: history.len() as u64,
    };
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        serde_json::to_vec(&export_metadata).unwrap(),
        Vec::new(),
    )));
    sandbox.push_copy_file_result(Ok(history.to_vec()));

    let promoted = prepare_and_publish_workspace_image(&sandbox, fixture.promotion).await;

    assert!(!promoted);
    let copy_calls = sandbox.copy_file_calls();
    assert_eq!(copy_calls.len(), 1);
    assert!(!copy_calls[0].host_path.exists());
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default",
                reuse_key: Some(reuse_key),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: TEST_WORKSPACE_IMAGE_SIZE_BYTES,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn parked_workspace_promotion_unpark_error_skips_cache() {
    let fixture = WorkspacePromotionFixture::new("sess-parked-unpark-error").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Unpark,
        message: "simulated unpark failure".into(),
    }));
    let mut sandbox = mock_sandbox_with_overrides(fixture.sandbox_id, Arc::clone(&overrides)).await;

    let prepared = prepare_workspace_image_from_parked_sandbox(
        sandbox.as_mut(),
        Some(fixture.promotion),
        "test",
    )
    .await;

    assert!(prepared.is_none());
    assert_eq!(overrides.unpark_call_count(), 1);
    assert!(overrides.exec_calls().is_empty());
    assert!(fixture.cache.held_workspace_states().await.is_empty());
}

#[tokio::test]
async fn parked_workspace_promotion_unpark_error_abandons_consumed_cache_hit() {
    let fixture = WorkspacePromotionFixture::new_from_cache_hit("sess-hit-unpark-error").await;
    let cache = fixture.cache.clone();
    let reuse_key = fixture.reuse_key.clone();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Unpark,
        message: "simulated unpark failure".into(),
    }));
    let mut sandbox = mock_sandbox_with_overrides(fixture.sandbox_id, Arc::clone(&overrides)).await;

    let prepared = prepare_workspace_image_from_parked_sandbox(
        sandbox.as_mut(),
        Some(fixture.promotion),
        "test",
    )
    .await;

    assert!(prepared.is_none());
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(
        WorkspacePromotionFixture::checkout_result(&cache, &reuse_key).await,
        WorkspaceCacheCheckoutResult::Miss
    );
}

#[tokio::test(flavor = "current_thread")]
async fn parked_workspace_promotion_warning_hashes_and_classifies_reuse_key() {
    for (reuse_key, expected_kind) in [
        ("thread:sensitive-promotion-17975", "thread"),
        ("opaque-sensitive-promotion-17975", "other"),
    ] {
        let fixture = WorkspacePromotionFixture::new(reuse_key).await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
            transition: sandbox::SandboxIdleTransition::Unpark,
            message: "simulated unpark failure".into(),
        }));
        let mut sandbox =
            mock_sandbox_with_overrides(fixture.sandbox_id, Arc::clone(&overrides)).await;

        let (prepared, events) =
            capture_promotion_events(prepare_workspace_image_from_parked_sandbox(
                sandbox.as_mut(),
                Some(fixture.promotion),
                "test",
            ))
            .await;

        assert!(prepared.is_none());
        let event = captured_event(
            &events,
            "workspace image cache promotion skipped because idle sandbox unpark failed",
        );
        assert_eq!(
            event
                .fields
                .get("reuse_key_fingerprint")
                .map(String::as_str),
            Some(crate::paths::short_digest(reuse_key).as_str())
        );
        assert_eq!(
            event.fields.get("reuse_key_kind").map(String::as_str),
            Some(expected_kind)
        );
        assert!(
            event
                .fields
                .values()
                .all(|value| !value.contains(reuse_key)),
            "workspace promotion logs must not contain the raw reuse key"
        );
    }
}

#[tokio::test]
async fn parked_workspace_promotion_unpark_panic_skips_cache() {
    let fixture = WorkspacePromotionFixture::new("sess-parked-unpark-panic").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_unpark_panic("simulated unpark panic");
    let mut sandbox = mock_sandbox_with_overrides(fixture.sandbox_id, Arc::clone(&overrides)).await;

    let prepared = prepare_workspace_image_from_parked_sandbox(
        sandbox.as_mut(),
        Some(fixture.promotion),
        "test",
    )
    .await;

    assert!(prepared.is_none());
    assert_eq!(overrides.unpark_call_count(), 1);
    assert!(overrides.exec_calls().is_empty());
    assert!(fixture.cache.held_workspace_states().await.is_empty());
}

#[tokio::test]
async fn parked_workspace_promotion_guest_freeze_failure_skips_cache() {
    let fixture = WorkspacePromotionFixture::new("sess-parked-freeze-fail").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.add_exec_matcher(ExecMatcher {
        pattern: "fsfreeze --freeze".into(),
        exit_code: 64,
        stdout: Vec::new(),
        stderr: b"not mounted".to_vec(),
    });
    let mut sandbox = mock_sandbox_with_overrides(fixture.sandbox_id, Arc::clone(&overrides)).await;

    let (prepared, events) = capture_promotion_events(prepare_workspace_image_from_parked_sandbox(
        sandbox.as_mut(),
        Some(fixture.promotion),
        "test",
    ))
    .await;

    assert!(prepared.is_none());
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.exec_calls().len(), 1);
    assert!(fixture.cache.held_workspace_states().await.is_empty());
    let event = captured_event(
        &events,
        "workspace image cache promotion skipped because guest freeze failed",
    );
    assert!(
        event
            .fields
            .get("error")
            .is_some_and(|error| error.contains("not mounted"))
    );
}

#[tokio::test]
async fn parked_workspace_promotion_guest_exec_panic_skips_cache() {
    let fixture = WorkspacePromotionFixture::new("sess-parked-exec-panic").await;
    let mut sandbox = PanicExecSandbox::new("parked-exec-panic");

    let prepared =
        prepare_workspace_image_from_parked_sandbox(&mut sandbox, Some(fixture.promotion), "test")
            .await;

    assert!(prepared.is_none());
    assert!(fixture.cache.held_workspace_states().await.is_empty());
}

async fn capture_promotion_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
where
    F: std::future::Future,
{
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    let output = future.await;
    drop(guard);
    (output, captured.entries())
}

fn captured_event<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
    events
        .iter()
        .find(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|actual| actual == message)
        })
        .unwrap_or_else(|| panic!("missing event {message:?}; captured={events:#?}"))
}
