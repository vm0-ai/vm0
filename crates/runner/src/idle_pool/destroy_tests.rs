use super::*;

use std::sync::Arc;

use crate::resource_budget::ResourceBudget;
use crate::workspace_image_cache::WorkspaceImagePromotionContext;
use crate::workspace_promotion::test_support::WorkspacePromotionFixture;
use sandbox::{ResourceLimits, SandboxConfig};
use sandbox_mock::{MockSandboxFactory, MockSandboxOverrides};

fn reserved_budget_lease() -> (Arc<ResourceBudget>, BudgetLease) {
    let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    (budget, lease)
}

async fn make_idle_destroy_payload(overrides: Arc<MockSandboxOverrides>) -> IdleDestroyPayload {
    make_idle_destroy_payload_for(SandboxId::new_v4(), overrides, None).await
}

async fn make_idle_destroy_payload_for(
    sandbox_id: SandboxId,
    overrides: Arc<MockSandboxOverrides>,
    workspace_promotion: Option<WorkspaceImagePromotionContext>,
) -> IdleDestroyPayload {
    let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
        MockSandboxFactory::with_overrides(Arc::clone(&overrides)),
    ));
    let sandbox = factory
        .create(SandboxConfig {
            id: sandbox_id,
            resources: ResourceLimits {
                cpu_count: 2,
                memory_mb: 4096,
            },
            device_rate_limits: None,
            workspace_drive: None,
        })
        .await
        .expect("create sandbox");

    IdleDestroyPayload {
        resources: IdleSandboxResources {
            sandbox,
            factory,
            workspace_promotion,
        },
    }
}

async fn make_idle_destroy_job(
    overrides: Arc<MockSandboxOverrides>,
    budget_lease: BudgetLease,
) -> IdleDestroyJob {
    make_idle_destroy_job_for(SandboxId::new_v4(), overrides, budget_lease, None).await
}

async fn make_idle_destroy_job_for(
    sandbox_id: SandboxId,
    overrides: Arc<MockSandboxOverrides>,
    budget_lease: BudgetLease,
    workspace_promotion: Option<WorkspaceImagePromotionContext>,
) -> IdleDestroyJob {
    IdleDestroyJob {
        payload: make_idle_destroy_payload_for(sandbox_id, overrides, workspace_promotion).await,
        budget_lease,
        session_id: "sess-destroy".into(),
        profile_name: "vm0/default".into(),
    }
}

#[tokio::test]
async fn idle_destroy_payload_stop_error_completes_after_destroy() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_stop_result(Err(sandbox::SandboxError::Start {
        message: "simulated idle stop failure".into(),
    }));
    let payload = make_idle_destroy_payload(Arc::clone(&overrides)).await;

    let outcome = payload.stop_and_destroy().await;

    assert_eq!(outcome, DestroyOutcome::Completed);
    assert_eq!(overrides.destroy_call_count(), 1);
}

#[tokio::test]
async fn idle_destroy_payload_stop_panic_is_uncertain_after_destroy() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_stop_panic("simulated idle stop panic");
    let payload = make_idle_destroy_payload(Arc::clone(&overrides)).await;

    let outcome = payload.stop_and_destroy().await;

    assert_eq!(outcome, DestroyOutcome::Uncertain);
    assert_eq!(overrides.destroy_call_count(), 1);
}

#[tokio::test]
async fn idle_destroy_job_destroy_panic_releases_budget_lease() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_destroy_panic("simulated destroy panic");
    let (budget, lease) = reserved_budget_lease();
    let job = make_idle_destroy_job(Arc::clone(&overrides), lease).await;

    let promoted = job.run_with_context("test_destroy_panic").await;

    assert!(!promoted);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn idle_destroy_job_stop_panic_still_attempts_destroy_and_releases_budget_lease() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_stop_panic("simulated idle stop panic");
    let (budget, lease) = reserved_budget_lease();
    let job = make_idle_destroy_job(Arc::clone(&overrides), lease).await;

    let promoted = job.run_with_context("test_stop_panic").await;

    assert!(!promoted);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn idle_destroy_job_stop_error_still_attempts_destroy_and_releases_budget_lease() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_stop_result(Err(sandbox::SandboxError::Start {
        message: "simulated idle stop failure".into(),
    }));
    let (budget, lease) = reserved_budget_lease();
    assert_eq!(budget.allocated(), (2, 4096, 1));
    let job = make_idle_destroy_job(Arc::clone(&overrides), lease).await;

    let promoted = job.run_with_context("test_stop_error").await;

    assert!(!promoted);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn idle_destroy_job_unpark_error_skips_workspace_cache_and_still_destroys() {
    assert_idle_destroy_job_unpark_failure_skips_workspace_cache_and_still_destroys(
        "sess-idle-destroy-unpark-error",
        |overrides| {
            overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
                transition: sandbox::SandboxIdleTransition::Unpark,
                message: "simulated unpark failure".into(),
            }));
        },
    )
    .await;
}

#[tokio::test]
async fn idle_destroy_job_unpark_panic_skips_workspace_cache_and_still_destroys() {
    assert_idle_destroy_job_unpark_failure_skips_workspace_cache_and_still_destroys(
        "sess-idle-destroy-unpark-panic",
        |overrides| overrides.push_unpark_panic("simulated unpark panic"),
    )
    .await;
}

async fn assert_idle_destroy_job_unpark_failure_skips_workspace_cache_and_still_destroys(
    session_id: &str,
    configure_overrides: impl FnOnce(&MockSandboxOverrides),
) {
    let fixture = WorkspacePromotionFixture::new(session_id).await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    configure_overrides(&overrides);
    let (budget, lease) = reserved_budget_lease();
    let job = make_idle_destroy_job_for(
        fixture.sandbox_id,
        Arc::clone(&overrides),
        lease,
        Some(fixture.promotion),
    )
    .await;

    let promoted = job.run_with_context("test_idle_destroy_unpark_error").await;

    assert!(!promoted);
    assert_eq!(overrides.unpark_call_count(), 1);
    assert!(overrides.exec_calls().is_empty());
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert!(fixture.cache.held_session_states().await.is_empty());
}
