use std::collections::HashMap;

use crate::ids::RunId;
use crate::types::{ExecutionContext, SESSION_WORKSPACE_IMAGE_CACHE_FEATURE_FLAG};

pub(in crate::executor::tests) fn minimal_context() -> ExecutionContext {
    ExecutionContext {
        run_id: RunId::nil(),
        prompt: "test prompt".into(),
        append_system_prompt: None,
        _agent_compose_version_id: None,
        vars: None,
        checkpoint_id: None,
        sandbox_token: "tok".into(),
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

pub(in crate::executor::tests) fn context_with_env(
    environment: HashMap<String, String>,
) -> ExecutionContext {
    let mut ctx = minimal_context();
    ctx.environment = Some(environment);
    ctx
}

pub(in crate::executor::tests) fn set_session_workspace_image_cache_flag(
    ctx: &mut ExecutionContext,
    enabled: bool,
) {
    ctx.feature_flags
        .get_or_insert_with(HashMap::new)
        .insert(SESSION_WORKSPACE_IMAGE_CACHE_FEATURE_FLAG.into(), enabled);
}
