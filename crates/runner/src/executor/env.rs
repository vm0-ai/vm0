use std::collections::HashMap;

use api_contracts::generated::constants::model_provider_env::placeholders as model_provider_placeholders;
use sandbox::Sandbox;

use super::cli_framework::{
    EffectiveCliFramework, effective_cli_framework, normalized_cli_agent_type,
};
use super::session_id::{canonical_codex_thread_id, is_valid_session_id};
use super::{
    GUEST_USER_ENV_DIR_NAME, GUEST_USER_ENV_FILENAME, RunnerError, RunnerResult, guest_runtime_dir,
    guest_runtime_path,
};
use crate::ids::RunId;
use crate::types::{ExecutionContext, SandboxReuseResult};

pub(super) struct ProtectedModelProviderEnvKey {
    name: &'static str,
    placeholder: Option<&'static str>,
}

pub(super) const CLAUDE_MODEL_PROVIDER_PLACEHOLDER_ENV_KEYS: &[ProtectedModelProviderEnvKey] = &[
    ProtectedModelProviderEnvKey {
        name: "ANTHROPIC_API_KEY",
        placeholder: Some(model_provider_placeholders::ANTHROPIC_API_KEY),
    },
    ProtectedModelProviderEnvKey {
        name: "ANTHROPIC_AUTH_TOKEN",
        placeholder: Some(model_provider_placeholders::ANTHROPIC_AUTH_TOKEN),
    },
    ProtectedModelProviderEnvKey {
        name: "CLAUDE_CODE_OAUTH_TOKEN",
        placeholder: Some(model_provider_placeholders::CLAUDE_CODE_OAUTH_TOKEN),
    },
];

pub(super) const CODEX_MODEL_PROVIDER_PLACEHOLDER_ENV_KEYS: &[ProtectedModelProviderEnvKey] = &[
    ProtectedModelProviderEnvKey {
        name: "OPENAI_API_KEY",
        placeholder: Some(model_provider_placeholders::OPENAI_API_KEY),
    },
    ProtectedModelProviderEnvKey {
        name: "CHATGPT_ACCESS_TOKEN",
        placeholder: Some(model_provider_placeholders::CHATGPT_ACCESS_TOKEN),
    },
    ProtectedModelProviderEnvKey {
        name: "CHATGPT_ACCOUNT_ID",
        placeholder: Some(model_provider_placeholders::CHATGPT_ACCOUNT_ID),
    },
    ProtectedModelProviderEnvKey {
        name: "CHATGPT_REFRESH_TOKEN",
        placeholder: Some(model_provider_placeholders::CHATGPT_REFRESH_TOKEN),
    },
    ProtectedModelProviderEnvKey {
        name: "CHATGPT_ID_TOKEN",
        placeholder: None,
    },
];

pub(super) const MODEL_PROVIDER_PLACEHOLDER_ENV_KEYS: &[&[ProtectedModelProviderEnvKey]] = &[
    CLAUDE_MODEL_PROVIDER_PLACEHOLDER_ENV_KEYS,
    CODEX_MODEL_PROVIDER_PLACEHOLDER_ENV_KEYS,
];

pub(super) fn validate_model_provider_env_placeholders(
    context: &ExecutionContext,
) -> Result<(), String> {
    let Some(environment) = &context.environment else {
        return Ok(());
    };

    let invalid_keys: Vec<&str> = MODEL_PROVIDER_PLACEHOLDER_ENV_KEYS
        .iter()
        .flat_map(|protected_keys| protected_keys.iter())
        .filter_map(|protected_key| {
            let value = environment.get(protected_key.name)?;
            if value.is_empty()
                || protected_key
                    .placeholder
                    .is_some_and(|placeholder| value == placeholder)
                || context
                    .local_secret_env_keys
                    .as_ref()
                    .is_some_and(|keys| keys.contains(protected_key.name))
            {
                None
            } else {
                Some(protected_key.name)
            }
        })
        .collect();

    if invalid_keys.is_empty() {
        return Ok(());
    }

    Err(format!(
        "model provider environment contains non-placeholder values for: {}",
        invalid_keys.join(", ")
    ))
}

pub(super) fn validate_execution_context_before_sandbox(
    context: &ExecutionContext,
    api_url: &str,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
) -> Result<(), String> {
    let host_env = HostEnv::from_process();
    validate_execution_context_before_sandbox_with_host_env(
        context,
        api_url,
        sandbox_id,
        reuse_result,
        &host_env,
    )
}

pub(super) fn validate_execution_context_before_sandbox_with_host_env(
    context: &ExecutionContext,
    api_url: &str,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
    host_env: &HostEnv,
) -> Result<(), String> {
    validate_resume_session_id(context)?;
    validate_model_provider_env_placeholders(context)?;
    validate_user_environment_for_guest(context)?;
    validate_claude_tool_lists(context)?;
    validate_run_payload_fields_before_sandbox(context)?;
    let bootstrap_env =
        build_env_json_with_host_env(context, api_url, sandbox_id, reuse_result, host_env)
            .map_err(|error| error.to_string())?;
    validate_bootstrap_environment_for_guest(&bootstrap_env)?;
    Ok(())
}

fn validate_user_environment_for_guest(context: &ExecutionContext) -> Result<(), String> {
    let mut entries: Vec<(&str, &str)> = Vec::new();
    for_each_guest_user_env_entry(context, |key, value| entries.push((key, value)));
    entries.sort_by_key(|(key, _)| *key);

    for (key, value) in entries {
        if !guest_contracts::env::is_shell_identifier_env_key(key) {
            return Err(format!(
                "user environment contains invalid env key {:?}",
                guest_contracts::env::sanitize_user_env_key_for_diagnostic(key)
            ));
        }
        if value.contains('\0') {
            return Err(format!(
                "user environment contains NUL byte for env key {:?}",
                guest_contracts::env::sanitize_user_env_key_for_diagnostic(key)
            ));
        }
    }

    Ok(())
}

fn validate_run_payload_fields_before_sandbox(context: &ExecutionContext) -> Result<(), String> {
    validate_run_payload_field(guest_contracts::env::PROMPT_ENV, &context.prompt)?;
    validate_run_payload_field(
        guest_contracts::env::APPEND_SYSTEM_PROMPT_ENV,
        context.append_system_prompt.as_deref().unwrap_or_default(),
    )?;

    if effective_cli_framework(&context.cli_agent_type) == EffectiveCliFramework::ClaudeCode
        && let Some(settings) = &context.settings
        && !settings.is_empty()
    {
        validate_run_payload_field(guest_contracts::env::SETTINGS_ENV, settings)?;
    }

    Ok(())
}

fn validate_run_payload_field(name: &str, value: &str) -> Result<(), String> {
    if value.contains('\0') {
        return Err(format!("run payload contains NUL byte for {name}"));
    }
    Ok(())
}

fn validate_bootstrap_environment_for_guest(
    environment: &HashMap<String, String>,
) -> Result<(), String> {
    let mut entries: Vec<(&String, &String)> = environment.iter().collect();
    entries.sort_by_key(|(key, _)| *key);

    for (key, value) in entries {
        if !guest_contracts::env::is_shell_identifier_env_key(key) {
            return Err(format!(
                "bootstrap environment contains invalid env key {:?}",
                guest_contracts::env::sanitize_user_env_key_for_diagnostic(key)
            ));
        }
        if value.contains('\0') {
            return Err(format!(
                "bootstrap environment contains NUL byte for env key {:?}",
                guest_contracts::env::sanitize_user_env_key_for_diagnostic(key)
            ));
        }
    }

    Ok(())
}

pub(crate) fn validate_resume_session_id(context: &ExecutionContext) -> Result<(), String> {
    let Some(session) = &context.resume_session else {
        return Ok(());
    };
    match effective_cli_framework(&context.cli_agent_type) {
        EffectiveCliFramework::Codex => canonical_codex_thread_id(&session.cli_agent_session_id)
            .map(|_| ())
            .ok_or_else(|| "invalid codex session_id".to_string()),
        EffectiveCliFramework::ClaudeCode => {
            if is_valid_session_id(&session.cli_agent_session_id) {
                Ok(())
            } else {
                Err("invalid session_id".to_string())
            }
        }
    }
}

pub(super) fn validate_claude_tool_lists(context: &ExecutionContext) -> Result<(), String> {
    if effective_cli_framework(&context.cli_agent_type) != EffectiveCliFramework::ClaudeCode {
        return Ok(());
    }

    if let Some(tools) = &context.disallowed_tools {
        validate_claude_tool_env_entries(guest_contracts::env::DISALLOWED_TOOLS_ENV, tools)?;
    }
    if let Some(tools) = &context.tools {
        validate_claude_tool_env_entries(guest_contracts::env::TOOLS_ENV, tools)?;
    }

    Ok(())
}

pub(super) fn build_user_env_json(context: &ExecutionContext) -> HashMap<String, String> {
    let mut env = HashMap::new();

    for_each_guest_user_env_entry(context, |key, value| {
        env.insert(key.to_string(), value.to_string());
    });

    env
}

fn for_each_guest_user_env_entry<'a>(
    context: &'a ExecutionContext,
    mut visit: impl FnMut(&'a str, &'a str),
) {
    if let Some(user_env) = &context.environment {
        for (key, value) in user_env {
            if !is_runner_owned_env_key(key) {
                visit(key, value);
            }
        }
    }

    if let Some(tz) = &context.user_timezone {
        let has_tz = context
            .environment
            .as_ref()
            .is_some_and(|env| env.contains_key("TZ"));
        if !has_tz {
            visit("TZ", tz);
        }
    }
}

pub(super) fn guest_user_env_file_path(run_id: RunId) -> RunnerResult<String> {
    guest_runtime_path(run_id, |dir| {
        dir.join(GUEST_USER_ENV_DIR_NAME)
            .join(GUEST_USER_ENV_FILENAME)
    })
}

pub(super) fn guest_run_payload_file_path(run_id: RunId) -> RunnerResult<String> {
    guest_runtime_path(run_id, |dir| {
        dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME)
            .join(guest_contracts::env::RUN_PAYLOAD_FILENAME)
    })
}

pub(super) async fn write_user_env_file(
    sandbox: &dyn Sandbox,
    run_id: RunId,
    user_env: &HashMap<String, String>,
) -> RunnerResult<Option<String>> {
    if user_env.is_empty() {
        return Ok(None);
    }

    let file_path = guest_user_env_file_path(run_id)?;
    let payload = serde_json::to_vec(user_env)
        .map_err(|e| RunnerError::Internal(format!("serialize user env: {e}")))?;
    sandbox.write_private_file(&file_path, &payload).await?;

    Ok(Some(file_path))
}

pub(super) async fn write_run_payload_file(
    sandbox: &dyn Sandbox,
    run_id: RunId,
    run_payload: &guest_contracts::env::RunPayload,
) -> RunnerResult<String> {
    let file_path = guest_run_payload_file_path(run_id)?;
    let payload = serde_json::to_vec(run_payload)
        .map_err(|e| RunnerError::Internal(format!("serialize run payload: {e}")))?;
    sandbox.write_private_file(&file_path, &payload).await?;

    Ok(file_path)
}

pub(super) fn build_env_json_with_host_env(
    context: &ExecutionContext,
    api_url: &str,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
    host_env: &HostEnv,
) -> RunnerResult<HashMap<String, String>> {
    build_env_json_with_host_env_for_run(
        context,
        api_url,
        sandbox_id,
        reuse_result,
        false,
        host_env,
    )
}

/// Build the guest-agent bootstrap environment.
///
/// This intentionally excludes `context.environment`. User/model/connector
/// environment is transferred separately and injected only into the CLI child.
pub(super) fn build_env_json_for_run(
    context: &ExecutionContext,
    api_url: &str,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
    has_active_input_source: bool,
) -> RunnerResult<HashMap<String, String>> {
    let host_env = HostEnv::from_process();
    build_env_json_with_host_env_for_run(
        context,
        api_url,
        sandbox_id,
        reuse_result,
        has_active_input_source,
        &host_env,
    )
}

pub(super) fn build_env_json_with_host_env_for_run(
    context: &ExecutionContext,
    api_url: &str,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
    has_active_input_source: bool,
    host_env: &HostEnv,
) -> RunnerResult<HashMap<String, String>> {
    let mut env = HashMap::new();

    env.insert(guest_contracts::env::API_URL_ENV.into(), api_url.into());
    env.insert(
        guest_contracts::env::RUN_ID_ENV.into(),
        context.run_id.to_string(),
    );
    env.insert(
        guest_contracts::env::API_TOKEN_ENV.into(),
        context.sandbox_token.clone(),
    );
    env.insert(
        guest_contracts::env::SANDBOX_ID_ENV.into(),
        sandbox_id.into(),
    );
    env.insert(
        guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV.into(),
        guest_runtime_dir(context.run_id)?,
    );
    env.insert(
        guest_contracts::env::SANDBOX_REUSE_RESULT_ENV.into(),
        reuse_result.as_wire().into(),
    );
    insert_guest_agent_tuning_env(&mut env, context);
    env.insert(
        guest_contracts::env::API_START_TIME_ENV.into(),
        context
            .api_start_time
            .map(|t| t.to_string())
            .unwrap_or_default(),
    );
    // The API omits cli_agent_type for claude-code agents (the default).
    env.insert(
        guest_contracts::env::CLI_AGENT_TYPE_ENV.into(),
        normalized_cli_agent_type(&context.cli_agent_type).into(),
    );

    // Vercel bypass
    if let Some(bypass) = &host_env.vercel_automation_bypass_secret {
        env.insert(
            guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV.into(),
            bypass.clone(),
        );
    }

    // Resume session ID
    if let Some(session) = &context.resume_session {
        let session_id =
            if effective_cli_framework(&context.cli_agent_type) == EffectiveCliFramework::Codex {
                canonical_codex_thread_id(&session.cli_agent_session_id)
                    .ok_or_else(|| RunnerError::Internal("invalid codex session_id".into()))?
            } else {
                session.cli_agent_session_id.clone()
            };
        env.insert(
            guest_contracts::env::RESUME_SESSION_ID_ENV.into(),
            session_id,
        );
    }

    // Note: Connector placeholder env vars (e.g., GITHUB_TOKEN=gho_CoffeeSafeLocal...)
    // are injected by the web API into `context.environment` directly.

    match effective_cli_framework(&context.cli_agent_type) {
        EffectiveCliFramework::ClaudeCode => insert_claude_code_env(&mut env, context, host_env),
        EffectiveCliFramework::Codex => {
            insert_codex_env(&mut env, context, host_env, has_active_input_source);
        }
    }

    Ok(env)
}

pub(super) fn build_run_payload_for_run(
    context: &ExecutionContext,
) -> RunnerResult<guest_contracts::env::RunPayload> {
    let mut payload = guest_contracts::env::RunPayload {
        prompt: context.prompt.clone(),
        append_system_prompt: context.append_system_prompt.clone().unwrap_or_default(),
        secret_values: serialize_secret_values(context),
        artifacts: serialize_artifacts_payload(context)?,
        feature_flags: serialize_feature_flags_payload(context)?,
        ..guest_contracts::env::RunPayload::default()
    };

    if effective_cli_framework(&context.cli_agent_type) == EffectiveCliFramework::ClaudeCode {
        if let Some(tools) = &context.disallowed_tools
            && let Some(serialized) =
                serialize_claude_tool_env(guest_contracts::env::DISALLOWED_TOOLS_ENV, tools)?
        {
            payload.disallowed_tools = serialized;
        }
        if let Some(tools) = &context.tools
            && let Some(serialized) =
                serialize_claude_tool_env(guest_contracts::env::TOOLS_ENV, tools)?
        {
            payload.tools = serialized;
        }
        if let Some(settings) = &context.settings
            && !settings.is_empty()
        {
            payload.settings = settings.clone();
        }
    }

    validate_run_payload_for_guest(&payload).map_err(RunnerError::Internal)?;
    Ok(payload)
}

fn serialize_secret_values(context: &ExecutionContext) -> String {
    use base64::Engine as _;
    let mut encoded: Vec<String> =
        vec![base64::engine::general_purpose::STANDARD.encode(&context.sandbox_token)];
    if let Some(secret_values) = &context.secret_values {
        encoded.extend(
            secret_values
                .iter()
                .map(|s| base64::engine::general_purpose::STANDARD.encode(s)),
        );
    }
    encoded.join(",")
}

fn serialize_artifacts_payload(context: &ExecutionContext) -> RunnerResult<String> {
    let Some(manifest) = &context.storage_manifest else {
        return Ok(String::new());
    };
    if manifest.artifacts.is_empty() {
        return Ok(String::new());
    }

    let payload: Vec<serde_json::Value> = manifest
        .artifacts
        .iter()
        .map(|a| {
            let mut entry = serde_json::json!({
                "name": a.vas_storage_name,
                "mountPath": a.mount_path,
                "storageId": a.vas_storage_id,
                "versionId": a.vas_version_id,
            });
            if let Some(policy) = a.missing_root_policy
                && let Some(object) = entry.as_object_mut()
            {
                object.insert("missingRootPolicy".to_string(), serde_json::json!(policy));
            }
            entry
        })
        .collect();

    serde_json::to_string(&payload)
        .map_err(|e| RunnerError::Internal(format!("serialize artifact payload: {e}")))
}

fn serialize_feature_flags_payload(context: &ExecutionContext) -> RunnerResult<String> {
    let Some(flags) = &context.feature_flags else {
        return Ok(String::new());
    };
    if flags.is_empty() {
        return Ok(String::new());
    }
    serde_json::to_string(flags)
        .map_err(|e| RunnerError::Internal(format!("serialize feature flags payload: {e}")))
}

fn validate_run_payload_for_guest(
    payload: &guest_contracts::env::RunPayload,
) -> Result<(), String> {
    if let Some(name) = payload.first_nul_field() {
        return Err(format!("run payload contains NUL byte for {name}"));
    }

    Ok(())
}

pub(super) fn insert_guest_agent_tuning_env(
    env: &mut HashMap<String, String>,
    context: &ExecutionContext,
) {
    let Some(user_env) = &context.environment else {
        return;
    };
    for key in guest_contracts::env::GUEST_AGENT_TUNING_ENV_KEYS {
        if let Some(value) = user_env.get(*key) {
            env.insert((*key).into(), value.clone());
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct HostEnv {
    pub(super) vercel_automation_bypass_secret: Option<String>,
    pub(super) use_mock_claude: Option<String>,
    pub(super) use_mock_codex: Option<String>,
}

impl HostEnv {
    pub(super) fn from_process() -> Self {
        Self {
            vercel_automation_bypass_secret: std::env::var("VERCEL_AUTOMATION_BYPASS_SECRET").ok(),
            use_mock_claude: std::env::var(guest_contracts::env::USE_MOCK_CLAUDE_ENV).ok(),
            use_mock_codex: std::env::var(guest_contracts::env::USE_MOCK_CODEX_ENV).ok(),
        }
    }
}

pub(super) fn is_runner_owned_env_key(key: &str) -> bool {
    // The entire VM0_ namespace is runner-owned, including retired keys such
    // as VM0_WORKING_DIR. Non-VM0 keys must stay explicit.
    guest_contracts::env::is_runner_owned_env_key(key)
}

pub(super) fn insert_claude_code_env(
    env: &mut HashMap<String, String>,
    context: &ExecutionContext,
    host_env: &HostEnv,
) {
    // Pass USE_MOCK_CLAUDE from host environment for testing
    // (skip if debugNoMockClaude is set in execution context)
    if let Some(val) = &host_env.use_mock_claude
        && !context.debug_no_mock_claude.unwrap_or(false)
    {
        env.insert(
            guest_contracts::env::USE_MOCK_CLAUDE_ENV.into(),
            val.clone(),
        );
    }
}

pub(super) fn serialize_claude_tool_env(
    env_name: &str,
    tools: &[String],
) -> RunnerResult<Option<String>> {
    if tools.is_empty() {
        return Ok(None);
    }

    validate_claude_tool_env_entries(env_name, tools).map_err(RunnerError::Internal)?;

    Ok(Some(tools.join(",")))
}

pub(super) fn validate_claude_tool_env_entries(
    env_name: &str,
    tools: &[String],
) -> Result<(), String> {
    for (index, tool) in tools.iter().enumerate() {
        if tool.trim().is_empty() {
            return Err(format!(
                "{env_name} entry at index {index} must not be empty"
            ));
        }
        if tool.contains(',') {
            return Err(format!(
                "{env_name} entry at index {index} must not contain commas"
            ));
        }
        if tool.contains('\0') {
            return Err(format!(
                "{env_name} entry at index {index} must not contain NUL bytes"
            ));
        }
        if tool.trim_start().starts_with('-') {
            return Err(format!(
                "{env_name} entry at index {index} must not start with a hyphen"
            ));
        }
    }

    Ok(())
}

pub(super) fn insert_codex_env(
    env: &mut HashMap<String, String>,
    context: &ExecutionContext,
    host_env: &HostEnv,
    has_active_input_source: bool,
) {
    if has_active_input_source {
        env.insert(
            guest_contracts::env::CODEX_APP_SERVER_BACKEND_ENV.into(),
            "1".into(),
        );
    }

    // Pass USE_MOCK_CODEX from host environment for testing
    // (skip if debugNoMockCodex is set in execution context).
    if let Some(val) = &host_env.use_mock_codex
        && !context.debug_no_mock_codex.unwrap_or(false)
    {
        env.insert(guest_contracts::env::USE_MOCK_CODEX_ENV.into(), val.clone());
    }
}
