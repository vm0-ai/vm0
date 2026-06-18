use super::super::super::*;
use super::env::MockRunEnv;
use super::wait::assert_run_exits_within;
use crate::provider::JobCandidate;
use crate::test_fixtures::execution_context_for_test;

pub(in super::super) const TEST_SESSION_LAST_COMPLETED_AT: &str = "2026-05-28T00:00:00.000Z";

pub(in super::super) fn minimal_context(run_id: RunId) -> crate::types::ExecutionContext {
    execution_context_for_test(run_id)
}

/// Push a job to the mock provider and pre-configure its claim result.
pub(in super::super) fn push_job(
    env: &MockRunEnv,
    run_id: RunId,
    profile: &str,
    ctx: Option<crate::types::ExecutionContext>,
) {
    env.provider.set_claim_result(run_id, ctx);
    env.handle
        .discover_tx
        .send(JobCandidate::new(run_id, profile.into()))
        .unwrap();
}

/// Trigger graceful shutdown and wait for run() to exit.
pub(in super::super) async fn shutdown(
    env: &MockRunEnv,
    run_handle: tokio::task::JoinHandle<RunnerResult<()>>,
) {
    env.drain();
    env.cancel.cancel();
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(10),
        "run should finish within 10s",
    )
    .await;
}

/// ExecutionContext with a resume_session for idle pool testing.
pub(in super::super) fn context_with_session(
    run_id: RunId,
    session_id: &str,
) -> crate::types::ExecutionContext {
    let mut ctx = minimal_context(run_id);
    ctx.resume_session = Some(crate::types::ResumeSession {
        cli_agent_session_id: session_id.into(),
        session_history: String::new(),
    });
    ctx
}
