use super::*;

use std::sync::Arc;
use std::time::Duration;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use async_trait::async_trait;
use sandbox::{
    CopyFileOptions, CopyFileResult, ExecRequest, ExecResult, GuestProcessHandle, ProcessExit,
    Sandbox, SandboxFactory, SandboxId, StartProcessRequest,
};
use sandbox_mock::{ExecMatcher, MockSandboxFactory, MockSandboxOverrides};

use crate::ids::RunId;
use crate::paths::RunnerPaths;
use crate::storage_fingerprints::StorageFingerprints;
use crate::workspace_image_cache::{
    SessionWorkspaceCache, WorkspaceCacheTerminalStatus, WorkspaceImagePrepareRequest,
    WorkspaceImagePromotionContext, WorkspaceImagePromotionRequest,
};

const TEST_COMPLETED_AT: &str = "2026-06-03T00:00:00.000Z";

struct WorkspacePromotionFixture {
    _dir: tempfile::TempDir,
    cache: SessionWorkspaceCache,
    promotion: WorkspaceImagePromotionContext,
    sandbox_id: SandboxId,
    session_id: String,
}

impl WorkspacePromotionFixture {
    async fn new(session_id: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let image = b"workspace image";
        let workspace_image = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                session_id: Some(session_id),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: image.len() as u64,
                workspace_drive_required: true,
            })
            .await;
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_workspace_image(&sandbox_id), image)
            .await
            .unwrap();
        let promotion = workspace_image
            .into_promotion_context(WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                session_id_override: Some(session_id),
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: TEST_COMPLETED_AT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                promotable: true,
            })
            .expect("workspace image should be promotable");

        Self {
            _dir: dir,
            cache,
            promotion,
            sandbox_id,
            session_id: session_id.into(),
        }
    }
}

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
        Some(&fixture.promotion),
        "test",
    )
    .await;

    assert!(promoted);
    assert_eq!(overrides.unpark_call_count(), 1);
    let exec_calls = overrides.exec_calls();
    assert_eq!(exec_calls.len(), 1);
    assert!(exec_calls[0].sudo);
    assert!(exec_calls[0].cmd.contains("umount -- \"$workspace_dir\""));
    drop(fixture.promotion);
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
        Some(&fixture.promotion),
        "test",
    )
    .await;

    assert!(!promoted);
    assert_eq!(overrides.unpark_call_count(), 1);
    assert!(overrides.exec_calls().is_empty());
    drop(fixture.promotion);
    assert!(fixture.cache.held_session_states().await.is_empty());
}

#[tokio::test]
async fn parked_workspace_promotion_unpark_panic_skips_cache() {
    let fixture = WorkspacePromotionFixture::new("sess-parked-unpark-panic").await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_unpark_panic("simulated unpark panic");
    let mut sandbox = mock_sandbox_with_overrides(fixture.sandbox_id, Arc::clone(&overrides)).await;

    let promoted = promote_workspace_image_from_parked_sandbox(
        sandbox.as_mut(),
        Some(&fixture.promotion),
        "test",
    )
    .await;

    assert!(!promoted);
    assert_eq!(overrides.unpark_call_count(), 1);
    assert!(overrides.exec_calls().is_empty());
    drop(fixture.promotion);
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
        Some(&fixture.promotion),
        "test",
    )
    .await;

    assert!(!promoted);
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.exec_calls().len(), 1);
    drop(fixture.promotion);
    assert!(fixture.cache.held_session_states().await.is_empty());
}

#[tokio::test]
async fn parked_workspace_promotion_guest_exec_panic_skips_cache() {
    let fixture = WorkspacePromotionFixture::new("sess-parked-exec-panic").await;
    let mut sandbox = PanicExecSandbox::new("parked-exec-panic");

    let promoted =
        promote_workspace_image_from_parked_sandbox(&mut sandbox, Some(&fixture.promotion), "test")
            .await;

    assert!(!promoted);
    drop(fixture.promotion);
    assert!(fixture.cache.held_session_states().await.is_empty());
}
