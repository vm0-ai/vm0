use super::test_support::{TEST_WORKSPACE_IMAGE_SIZE_BYTES, WorkspacePromotionFixture};
use super::*;

use std::sync::Arc;
use std::time::Duration;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use async_trait::async_trait;
use guest_contracts::session_history_identity::{
    FinalSessionHistoryFramework, FinalSessionHistoryIdentity, FinalSessionHistoryRefKind,
    SessionHistorySidecarExportMetadata, SessionHistorySidecarRepresentation,
};
use sandbox::{
    CopyFileOptions, CopyFileResult, ExecRequest, ExecResult, GuestProcessHandle, ProcessExit,
    Sandbox, SandboxFactory, SandboxId, StartProcessRequest,
};
use sandbox_mock::{ExecMatcher, MockSandboxFactory, MockSandboxOverrides};
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

    async fn park(&mut self) -> sandbox::Result<()> {
        Ok(())
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
async fn parked_workspace_promotion_unparks_unmounts_and_promotes_cache_entry() {
    let fixture = WorkspacePromotionFixture::new("sess-parked-promote").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let mut sandbox = mock_sandbox_with_overrides(fixture.sandbox_id, Arc::clone(&overrides)).await;

    let promoted = promote_workspace_image_from_parked_sandbox(
        sandbox.as_mut(),
        Some(fixture.promotion),
        "test",
    )
    .await;

    assert!(promoted);
    assert_eq!(overrides.unpark_call_count(), 1);
    let exec_calls = overrides.exec_calls();
    assert_eq!(exec_calls.len(), 1);
    assert!(exec_calls[0].sudo);
    assert!(exec_calls[0].cmd.contains("umount -- \"$workspace_dir\""));
    let states = fixture.cache.held_session_states().await;
    assert_eq!(states.len(), 1);
    assert_eq!(states[0].session_id, fixture.session_id);
}

#[tokio::test]
async fn active_workspace_promotion_exports_session_history_sidecar() {
    let session_id = "sess-active-sidecar-promote";
    let history = br#"{"type":"message","content":"cached"}"#;
    let metadata = FinalSessionHistoryIdentity::new(
        FinalSessionHistoryFramework::ClaudeCode,
        hex::encode(Sha256::digest(session_id.as_bytes())),
        FinalSessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
        format!("/home/user/.claude/projects/-home-user-workspace/{session_id}.jsonl"),
    )
    .unwrap();
    let restored_identity = RestoredSessionIdentity::from_final_metadata(
        metadata,
        "/home/user/.vm0/guest-agent/runs/run-1/final-session-history-identity.json",
        "/home/user/.vm0/guest-agent/runs/run-1",
    )
    .unwrap();
    let fixture = WorkspacePromotionFixture::new_with_restored_session_identity(
        session_id,
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

    let (promoted, events) = capture_promotion_events(promote_workspace_image_from_active_sandbox(
        &sandbox,
        Some(fixture.promotion),
        "test",
    ))
    .await;

    assert!(promoted);
    let exec_calls = sandbox.exec_calls();
    assert_eq!(exec_calls.len(), 3);
    assert!(exec_calls[0].cmd.contains("export-session-history-sidecar"));
    assert!(exec_calls[1].cmd.contains("rm -f --"));
    assert!(exec_calls[1].cmd.contains("/session-history-sidecar"));
    assert!(exec_calls[2].sudo);
    let copy_calls = sandbox.copy_file_calls();
    assert_eq!(copy_calls.len(), 1);
    assert!(copy_calls[0].path.ends_with("/session-history-sidecar"));
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
        .prepare_for_test(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: SandboxId::new_v4(),
                profile_name: "vm0/default",
                cli_agent_session_id: Some(session_id),
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
async fn parked_workspace_promotion_unpark_error_skips_cache() {
    let fixture = WorkspacePromotionFixture::new("sess-parked-unpark-error").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Unpark,
        message: "simulated unpark failure".into(),
    }));
    let mut sandbox = mock_sandbox_with_overrides(fixture.sandbox_id, Arc::clone(&overrides)).await;

    let promoted = promote_workspace_image_from_parked_sandbox(
        sandbox.as_mut(),
        Some(fixture.promotion),
        "test",
    )
    .await;

    assert!(!promoted);
    assert_eq!(overrides.unpark_call_count(), 1);
    assert!(overrides.exec_calls().is_empty());
    assert!(fixture.cache.held_session_states().await.is_empty());
}

#[tokio::test]
async fn parked_workspace_promotion_unpark_error_abandons_consumed_cache_hit() {
    let fixture = WorkspacePromotionFixture::new_from_cache_hit("sess-hit-unpark-error").await;
    let cache = fixture.cache.clone();
    let session_id = fixture.session_id.clone();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Unpark,
        message: "simulated unpark failure".into(),
    }));
    let mut sandbox = mock_sandbox_with_overrides(fixture.sandbox_id, Arc::clone(&overrides)).await;

    let promoted = promote_workspace_image_from_parked_sandbox(
        sandbox.as_mut(),
        Some(fixture.promotion),
        "test",
    )
    .await;

    assert!(!promoted);
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(
        WorkspacePromotionFixture::checkout_result(&cache, &session_id).await,
        WorkspaceCacheCheckoutResult::Miss
    );
}

#[tokio::test(flavor = "current_thread")]
async fn parked_workspace_promotion_warning_uses_session_id() {
    let raw_session_id = "sess-sensitive-promotion-17975";
    let fixture = WorkspacePromotionFixture::new(raw_session_id).await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Unpark,
        message: "simulated unpark failure".into(),
    }));
    let mut sandbox = mock_sandbox_with_overrides(fixture.sandbox_id, Arc::clone(&overrides)).await;

    let (promoted, events) = capture_promotion_events(promote_workspace_image_from_parked_sandbox(
        sandbox.as_mut(),
        Some(fixture.promotion),
        "test",
    ))
    .await;

    assert!(!promoted);
    let event = captured_event(
        &events,
        "workspace image cache promotion skipped because idle sandbox unpark failed",
    );
    assert_eq!(
        event.fields.get("session_id").map(String::as_str),
        Some(raw_session_id)
    );
}

#[tokio::test]
async fn parked_workspace_promotion_unpark_panic_skips_cache() {
    let fixture = WorkspacePromotionFixture::new("sess-parked-unpark-panic").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_unpark_panic("simulated unpark panic");
    let mut sandbox = mock_sandbox_with_overrides(fixture.sandbox_id, Arc::clone(&overrides)).await;

    let promoted = promote_workspace_image_from_parked_sandbox(
        sandbox.as_mut(),
        Some(fixture.promotion),
        "test",
    )
    .await;

    assert!(!promoted);
    assert_eq!(overrides.unpark_call_count(), 1);
    assert!(overrides.exec_calls().is_empty());
    assert!(fixture.cache.held_session_states().await.is_empty());
}

#[tokio::test]
async fn parked_workspace_promotion_guest_unmount_failure_skips_cache() {
    let fixture = WorkspacePromotionFixture::new("sess-parked-unmount-fail").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.add_exec_matcher(ExecMatcher {
        pattern: "umount -- \"$workspace_dir\"".into(),
        exit_code: 64,
        stdout: Vec::new(),
        stderr: b"not mounted".to_vec(),
    });
    let mut sandbox = mock_sandbox_with_overrides(fixture.sandbox_id, Arc::clone(&overrides)).await;

    let promoted = promote_workspace_image_from_parked_sandbox(
        sandbox.as_mut(),
        Some(fixture.promotion),
        "test",
    )
    .await;

    assert!(!promoted);
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.exec_calls().len(), 1);
    assert!(fixture.cache.held_session_states().await.is_empty());
}

#[tokio::test]
async fn parked_workspace_promotion_guest_exec_panic_skips_cache() {
    let fixture = WorkspacePromotionFixture::new("sess-parked-exec-panic").await;
    let mut sandbox = PanicExecSandbox::new("parked-exec-panic");

    let promoted =
        promote_workspace_image_from_parked_sandbox(&mut sandbox, Some(fixture.promotion), "test")
            .await;

    assert!(!promoted);
    assert!(fixture.cache.held_session_states().await.is_empty());
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
