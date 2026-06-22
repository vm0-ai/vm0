use super::test_support::WorkspacePromotionFixture;
use super::*;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use sandbox::{
    CopyFileOptions, CopyFileResult, ExecRequest, ExecResult, GuestProcessHandle, ProcessExit,
    Sandbox, SandboxFactory, SandboxId, StartProcessRequest,
};
use sandbox_mock::{ExecMatcher, MockSandboxFactory, MockSandboxOverrides};
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

use crate::workspace_image_cache::WorkspaceCacheCheckoutResult;

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
async fn parked_workspace_promotion_warning_uses_session_fingerprint() {
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
    assert_captured_events_do_not_contain(&events, raw_session_id);
    let event = captured_event(
        &events,
        "workspace image cache promotion skipped because idle sandbox unpark failed",
    );
    assert_eq!(
        event.fields.get("session_fingerprint").map(String::as_str),
        Some(crate::paths::diagnostic_session_fingerprint(raw_session_id).as_str())
    );
    assert!(
        !event.fields.contains_key("session_id"),
        "promotion diagnostic must not include raw session_id field: {event:#?}"
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

fn assert_captured_events_do_not_contain(events: &[CapturedEvent], raw: &str) {
    for event in events {
        for (field, value) in &event.fields {
            assert!(
                !value.contains(raw),
                "captured field {field} leaked raw session id {raw:?}: {event:#?}"
            );
        }
    }
}
