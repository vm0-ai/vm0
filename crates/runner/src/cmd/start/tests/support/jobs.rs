use super::super::super::*;
use super::env::MockRunEnv;
use crate::provider::JobCandidate;

pub(in super::super) fn minimal_context(run_id: RunId) -> crate::types::ExecutionContext {
    crate::types::ExecutionContext {
        run_id,
        prompt: "test".into(),
        append_system_prompt: None,
        _agent_compose_version_id: None,
        vars: None,
        checkpoint_id: None,
        sandbox_token: "tok".into(),
        working_dir: "/workspace".into(),
        storage_manifest: None,
        environment: None,
        resume_session: None,
        secret_values: None,
        encrypted_secrets: None,
        secret_connector_map: None,
        secret_connector_metadata_map: None,
        cli_agent_type: String::new(),
        debug_no_mock_claude: None,
        debug_no_mock_codex: None,
        api_start_time: None,
        user_timezone: None,
        capture_network_bodies: None,
        firewalls: None,
        network_policies: None,
        disallowed_tools: None,
        tools: None,
        settings: None,
        experimental_profile: None,
        feature_flags: None,
        billable_firewalls: vec![],
        model_usage_provider: None,
    }
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
    let result = tokio::time::timeout(Duration::from_secs(10), run_handle)
        .await
        .expect("run should finish within 10s")
        .expect("task should not panic");
    assert!(result.is_ok());
}

/// ExecutionContext with a resume_session for idle pool testing.
pub(in super::super) fn context_with_session(
    run_id: RunId,
    session_id: &str,
) -> crate::types::ExecutionContext {
    let mut ctx = minimal_context(run_id);
    ctx.resume_session = Some(crate::types::ResumeSession {
        session_id: session_id.into(),
        session_history: String::new(),
    });
    ctx
}
