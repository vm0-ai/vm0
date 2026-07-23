use crate::session;
use chrono::Utc;
use serde_json::{Value, json};
use std::io;
use uuid::Uuid;

pub(super) struct InputEventContext<'a> {
    pub(super) artifact_thread_id: &'a str,
    pub(super) thread_id: &'a str,
    pub(super) turn_id: &'a str,
    pub(super) kind: &'a str,
    pub(super) thread_request_has_runtime_workspace_roots: bool,
    pub(super) thread_request_path: Option<&'a str>,
    pub(super) thread_request_model: Option<&'a str>,
    pub(super) thread_request_model_provider: Option<&'a str>,
    pub(super) turn_params: &'a Value,
}

pub(super) fn persist_input_events(
    context: &InputEventContext<'_>,
    inputs: &[String],
) -> io::Result<()> {
    let events = inputs
        .iter()
        .map(|text| {
            json!({
                "type": "mock.app_server.input",
                "kind": context.kind,
                "thread_id": context.thread_id,
                "turn_id": context.turn_id,
                "text": text,
                "thread_request_has_runtime_workspace_roots": context.thread_request_has_runtime_workspace_roots,
                "thread_request_path": context.thread_request_path,
                "thread_request_model": context.thread_request_model,
                "thread_request_model_provider": context.thread_request_model_provider,
                "turn_request_has_runtime_workspace_roots": context.turn_params.get("runtimeWorkspaceRoots").is_some(),
                "turn_request_cwd": context.turn_params.get("cwd"),
                "turn_request_approval_policy": context.turn_params.get("approvalPolicy"),
                "turn_request_approvals_reviewer": context.turn_params.get("approvalsReviewer"),
                "turn_request_sandbox_policy": context.turn_params.get("sandboxPolicy"),
                "turn_request_client_user_message_id": context.turn_params.get("clientUserMessageId"),
                "child_env_home": std::env::var("HOME").ok(),
                "child_env_api_url": std::env::var("VM0_API_BACKEND_URL").ok(),
                "child_env_custom_user_env": std::env::var("CUSTOM_USER_ENV").ok(),
                "child_env_openai_model": std::env::var("OPENAI_MODEL").ok(),
                "child_env_openai_base_url": std::env::var("OPENAI_BASE_URL").ok(),
            })
        })
        .collect::<Vec<_>>();
    let home = session::codex_home();
    session::persist_resume_session(
        &home,
        Utc::now().date_naive(),
        context.artifact_thread_id,
        &events,
    )
}

pub(super) fn session_artifact_thread_id(thread_id: &str) -> String {
    match Uuid::parse_str(thread_id) {
        Ok(uuid) if uuid.to_string() == thread_id => thread_id.to_string(),
        _ => Uuid::now_v7().to_string(),
    }
}
