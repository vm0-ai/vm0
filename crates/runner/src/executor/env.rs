use std::collections::HashMap;

use api_contracts::generated::constants::model_provider_env::placeholders as model_provider_placeholders;
use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox};

use super::storage::format_guest_exec_failure;
use super::{
    DEFAULT_EXEC_TIMEOUT, GUEST_AGENT_TUNING_ENV_KEYS, GUEST_USER_ENV_DIR_NAME,
    GUEST_USER_ENV_FILENAME, RunnerError, RunnerResult, USER_ENV_FILE_ENV_KEY, guest_runtime_dir,
    guest_runtime_path,
};
use crate::host_env::{
    RUNNER_CONCURRENCY_FACTOR_ENV, RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV, RUNNER_DISK_IOPS_ENV,
    RUNNER_NET_RX_MIB_PER_SEC_ENV, RUNNER_NET_TX_MIB_PER_SEC_ENV,
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
) -> Result<(), String> {
    validate_model_provider_env_placeholders(context)?;
    validate_claude_tool_lists(context)?;
    Ok(())
}

pub(super) fn validate_claude_tool_lists(context: &ExecutionContext) -> Result<(), String> {
    if effective_cli_framework(&context.cli_agent_type) != EffectiveCliFramework::ClaudeCode {
        return Ok(());
    }

    if let Some(tools) = &context.disallowed_tools {
        validate_claude_tool_env_entries("VM0_DISALLOWED_TOOLS", tools)?;
    }
    if let Some(tools) = &context.tools {
        validate_claude_tool_env_entries("VM0_TOOLS", tools)?;
    }

    Ok(())
}

pub(super) fn build_user_env_json(context: &ExecutionContext) -> HashMap<String, String> {
    let mut env = HashMap::new();

    if let Some(user_env) = &context.environment {
        for (k, v) in user_env {
            env.insert(k.clone(), v.clone());
        }
    }
    scrub_runner_owned_env(&mut env);

    if let Some(tz) = &context.user_timezone {
        let has_tz = context
            .environment
            .as_ref()
            .is_some_and(|e| e.contains_key("TZ"));
        if !has_tz {
            env.insert("TZ".into(), tz.clone());
        }
    }

    env
}

pub(super) fn guest_user_env_dir_path(run_id: RunId) -> RunnerResult<String> {
    guest_runtime_path(run_id, |dir| dir.join(GUEST_USER_ENV_DIR_NAME))
}

pub(super) fn guest_user_env_file_path(run_id: RunId) -> RunnerResult<String> {
    guest_runtime_path(run_id, |dir| {
        dir.join(GUEST_USER_ENV_DIR_NAME)
            .join(GUEST_USER_ENV_FILENAME)
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

    let runtime_dir = guest_runtime_dir(run_id)?;
    let dir_path = guest_user_env_dir_path(run_id)?;
    let file_path = guest_user_env_file_path(run_id)?;
    let mkdir_cmd =
        format!("mkdir -p -m 700 {runtime_dir} {dir_path} && chmod 700 {runtime_dir} {dir_path}");
    let mkdir_result = sandbox
        .exec(&ExecRequest {
            cmd: &mkdir_cmd,
            timeout: DEFAULT_EXEC_TIMEOUT,
            env: &[],
            sudo: false,
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        })
        .await?;
    if mkdir_result.exit_code != 0 {
        return Err(RunnerError::Internal(format_guest_exec_failure(
            "user env directory creation",
            &mkdir_result,
        )));
    }

    let payload = serde_json::to_vec(user_env)
        .map_err(|e| RunnerError::Internal(format!("serialize user env: {e}")))?;
    sandbox.write_file(&file_path, &payload).await?;
    let chmod_cmd = format!("chmod 600 {file_path}");
    let chmod_result = sandbox
        .exec(&ExecRequest {
            cmd: &chmod_cmd,
            timeout: DEFAULT_EXEC_TIMEOUT,
            env: &[],
            sudo: false,
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        })
        .await?;
    if chmod_result.exit_code != 0 {
        return Err(RunnerError::Internal(format_guest_exec_failure(
            "user env file permission update",
            &chmod_result,
        )));
    }

    Ok(Some(file_path))
}

/// Build the guest-agent bootstrap environment.
///
/// This intentionally excludes `context.environment`. User/model/connector
/// environment is transferred separately and injected only into the CLI child.
pub(super) fn build_env_json(
    context: &ExecutionContext,
    api_url: &str,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
) -> RunnerResult<HashMap<String, String>> {
    let host_env = HostEnv::from_process();
    build_env_json_with_host_env(context, api_url, sandbox_id, reuse_result, &host_env)
}

pub(super) fn build_env_json_with_host_env(
    context: &ExecutionContext,
    api_url: &str,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
    host_env: &HostEnv,
) -> RunnerResult<HashMap<String, String>> {
    let mut env = HashMap::new();

    env.insert("VM0_API_URL".into(), api_url.into());
    env.insert("VM0_RUN_ID".into(), context.run_id.to_string());
    env.insert("VM0_API_TOKEN".into(), context.sandbox_token.clone());
    env.insert("VM0_SANDBOX_ID".into(), sandbox_id.into());
    env.insert(
        guest_runtime_paths::GUEST_RUNTIME_DIR_ENV.into(),
        guest_runtime_dir(context.run_id)?,
    );
    env.insert(
        "VM0_SANDBOX_REUSE_RESULT".into(),
        reuse_result.as_wire().into(),
    );
    env.insert("VM0_PROMPT".into(), context.prompt.clone());
    insert_guest_agent_tuning_env(&mut env, context);
    if let Some(asp) = &context.append_system_prompt
        && !asp.is_empty()
    {
        env.insert("VM0_APPEND_SYSTEM_PROMPT".into(), asp.clone());
    }
    env.insert(
        "VM0_API_START_TIME".into(),
        context
            .api_start_time
            .map(|t| t.to_string())
            .unwrap_or_default(),
    );
    // The API omits cli_agent_type for claude-code agents (the default).
    env.insert(
        "CLI_AGENT_TYPE".into(),
        normalized_cli_agent_type(&context.cli_agent_type).into(),
    );

    // Vercel bypass
    if let Some(bypass) = &host_env.vercel_automation_bypass_secret {
        env.insert("VERCEL_PROTECTION_BYPASS".into(), bypass.clone());
    }

    // Artifacts config (multi-mount).
    //
    // Emit a single `VM0_ARTIFACTS` env var containing a JSON array of
    // `{name, mountPath, storageId, versionId, missingRootPolicy?}` objects.
    // Guest-agent parses this on startup and iterates the list when taking
    // snapshots at run end. The required fields here must stay lockstep with
    // guest-agent's `ArtifactEnv` — the two ship as one unit via
    // `include_bytes!`, and required field drops will panic the VM at startup
    // instead of silently producing empty strings.
    //
    // Empty-list case: do not set the env var at all (matches the prior
    // "unset = no artifact" convention).
    if let Some(manifest) = &context.storage_manifest
        && !manifest.artifacts.is_empty()
    {
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
        // Serialization cannot fail — payload is a Vec of String-only JSON
        // objects. Use `.expect` to make the invariant explicit; falling
        // back to an empty string would silently produce a broken env.
        #[allow(clippy::expect_used)]
        let serialized = serde_json::to_string(&payload)
            .expect("VM0_ARTIFACTS payload must serialize (String-only Values)");
        env.insert("VM0_ARTIFACTS".into(), serialized);
    }

    // Resume session ID
    if let Some(session) = &context.resume_session {
        env.insert("VM0_RESUME_SESSION_ID".into(), session.session_id.clone());
    }

    // Note: Connector placeholder env vars (e.g., GITHUB_TOKEN=gho_CoffeeSafeLocal...)
    // are injected by the web API into `context.environment` directly.

    // Plain secret values (base64-encoded, comma-separated) for redaction.
    // These are values, not names; base64 is only transport encoding.
    // Always include the sandbox token so it gets redacted in logs.
    {
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
        env.insert("VM0_SECRET_VALUES".into(), encoded.join(","));
    }

    match effective_cli_framework(&context.cli_agent_type) {
        EffectiveCliFramework::ClaudeCode => insert_claude_code_env(&mut env, context, host_env)?,
        EffectiveCliFramework::Codex => insert_codex_env(&mut env, context, host_env),
    }

    // Feature flags (JSON-encoded map of flag name → enabled)
    if let Some(flags) = &context.feature_flags
        && !flags.is_empty()
        && let Ok(json) = serde_json::to_string(flags)
    {
        env.insert("VM0_FEATURE_FLAGS".into(), json);
    }

    Ok(env)
}

pub(super) fn insert_guest_agent_tuning_env(
    env: &mut HashMap<String, String>,
    context: &ExecutionContext,
) {
    let Some(user_env) = &context.environment else {
        return;
    };
    for key in GUEST_AGENT_TUNING_ENV_KEYS {
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
            use_mock_claude: std::env::var("USE_MOCK_CLAUDE").ok(),
            use_mock_codex: std::env::var("USE_MOCK_CODEX").ok(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum EffectiveCliFramework {
    ClaudeCode,
    Codex,
}

pub(super) fn effective_cli_framework(cli_agent_type: &str) -> EffectiveCliFramework {
    if normalized_cli_agent_type(cli_agent_type) == "codex" {
        EffectiveCliFramework::Codex
    } else {
        // Guest-agent currently falls back unknown CLI_AGENT_TYPE values to
        // Claude Code. Keep runner env gating aligned with that behavior.
        EffectiveCliFramework::ClaudeCode
    }
}

pub(super) const RUNNER_OWNED_ENV_KEYS: &[&str] = &[
    "VM0_API_URL",
    "VM0_RUN_ID",
    "VM0_API_TOKEN",
    "VM0_SANDBOX_ID",
    guest_runtime_paths::GUEST_RUNTIME_DIR_ENV,
    "VM0_SANDBOX_REUSE_RESULT",
    "VM0_PROMPT",
    "VM0_APPEND_SYSTEM_PROMPT",
    // Retired runner-owned key. Keep scrubbing user-provided values so the
    // removed working-dir parameter does not leak into guest CLI processes.
    "VM0_WORKING_DIR",
    "VM0_API_START_TIME",
    "CLI_AGENT_TYPE",
    "VM0_ARTIFACTS",
    "VM0_RESUME_SESSION_ID",
    "VM0_SECRET_VALUES",
    USER_ENV_FILE_ENV_KEY,
    "VM0_FEATURE_FLAGS",
    "VM0_STUCK_TOOL_TIMEOUT_SECS",
    "VM0_POST_RESULT_SIGTERM_GRACE_SECS",
    "VM0_POST_RESULT_SIGKILL_GRACE_SECS",
    RUNNER_CONCURRENCY_FACTOR_ENV,
    RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
    RUNNER_DISK_IOPS_ENV,
    RUNNER_NET_RX_MIB_PER_SEC_ENV,
    RUNNER_NET_TX_MIB_PER_SEC_ENV,
    "USE_MOCK_CLAUDE",
    "USE_MOCK_CODEX",
    "VM0_MOCK_CLAUDE_PATH",
    "VM0_MOCK_CODEX_PATH",
    "VERCEL_PROTECTION_BYPASS",
    "VM0_DISALLOWED_TOOLS",
    "VM0_TOOLS",
    "VM0_SETTINGS",
];

pub(super) fn scrub_runner_owned_env(env: &mut HashMap<String, String>) {
    env.retain(|key, _| !key.starts_with("VM0_"));
    for key in RUNNER_OWNED_ENV_KEYS {
        env.remove(*key);
    }
}

pub(super) fn insert_claude_code_env(
    env: &mut HashMap<String, String>,
    context: &ExecutionContext,
    host_env: &HostEnv,
) -> RunnerResult<()> {
    // Pass USE_MOCK_CLAUDE from host environment for testing
    // (skip if debugNoMockClaude is set in execution context)
    if let Some(val) = &host_env.use_mock_claude
        && !context.debug_no_mock_claude.unwrap_or(false)
    {
        env.insert("USE_MOCK_CLAUDE".into(), val.clone());
    }

    if let Some(tools) = &context.disallowed_tools
        && let Some(serialized) = serialize_claude_tool_env("VM0_DISALLOWED_TOOLS", tools)?
    {
        env.insert("VM0_DISALLOWED_TOOLS".into(), serialized);
    }

    if let Some(tools) = &context.tools
        && let Some(serialized) = serialize_claude_tool_env("VM0_TOOLS", tools)?
    {
        env.insert("VM0_TOOLS".into(), serialized);
    }

    // Settings JSON (passed directly as single string)
    if let Some(settings) = &context.settings
        && !settings.is_empty()
    {
        env.insert("VM0_SETTINGS".into(), settings.clone());
    }

    Ok(())
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
) {
    // Pass USE_MOCK_CODEX from host environment for testing
    // (skip if debugNoMockCodex is set in execution context).
    if let Some(val) = &host_env.use_mock_codex
        && !context.debug_no_mock_codex.unwrap_or(false)
    {
        env.insert("USE_MOCK_CODEX".into(), val.clone());
    }
}

pub(super) fn normalized_cli_agent_type(cli_agent_type: &str) -> &str {
    if cli_agent_type.is_empty() {
        "claude-code"
    } else {
        cli_agent_type
    }
}
