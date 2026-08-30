//! Runner-to-guest environment variable name contract.
//!
//! The runner uses these names to bootstrap the guest-agent process. User,
//! model-provider, and connector environment is a separate payload loaded
//! through [`USER_ENV_FILE_ENV`], so user-provided keys cannot override runner
//! bootstrap controls directly.
//!
//! The `OKOU_` and `VM0_` namespaces are runner-owned, including keys defined
//! in sibling modules such as
//! [`crate::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV`].
//! User env filtering should treat current and future `OKOU_` keys plus current,
//! future, and retired `VM0_` keys as protected. Bootstrap keys outside those
//! namespaces are listed explicitly below.
//!
//! [`GUEST_AGENT_TUNING_ENV_KEYS`] is the only intentional exception where
//! selected runner-owned keys may cross the local user-env boundary as
//! guest-agent timing overrides.

/// Legacy backend API base URL spelling retained by compatibility readers.
///
/// The production Runner and the guest-agent's curated managed CLI-child
/// environment do not emit this alias.
pub const API_URL_ENV: &str = "VM0_API_BACKEND_URL";

/// Canonical backend API URL spelling written by the production Runner and
/// exposed to managed CLI children.
///
/// The Guest Agent bootstrap reader and Runner operator parser reuse this exact
/// spelling but have independent rollout floors. On the Runner-to-Guest surface,
/// the Runner emits only this canonical alias, while the Guest Agent retains
/// [`API_URL_ENV`] as a rollback reader fallback. On the Guest-to-managed-CLI
/// surface, the curated child environment emits only this canonical alias.
/// Remove the legacy bootstrap reader only after the exact canonical writer
/// production release, complete legacy-writer service and reusable-sandbox
/// drain, supported rollback window, and value-free legacy-source-zero gates in
/// #28914. Runner operator input retains its own independent support floor.
pub const CANONICAL_API_URL_ENV: &str = "OKOU_API_BACKEND_URL";

/// Stable run identifier used by guest-agent logs, telemetry, and runtime
/// file path resolution.
pub const RUN_ID_ENV: &str = "OKOU_RUN_ID";

/// Sensitive backend API bearer token for guest-agent calls.
///
/// This value is runner-owned and must not be exposed through user-provided
/// environment or CLI child env.
pub const CANONICAL_API_TOKEN_ENV: &str = "OKOU_API_TOKEN";

/// Sandbox identifier assigned and written by the runner.
pub const CANONICAL_SANDBOX_ID_ENV: &str = "OKOU_SANDBOX_ID";

/// Wire value for the runner's sandbox-reuse decision.
///
/// `reused` means an idle sandbox was unparked. Other values describe why reuse did
/// not happen, such as `poolMiss` or `noReuseKey`.
pub const CANONICAL_SANDBOX_REUSE_RESULT_ENV: &str = "OKOU_SANDBOX_REUSE_RESULT";

/// Wire value for the runner's final workspace-reuse decision.
pub const CANONICAL_WORKSPACE_REUSE_RESULT_ENV: &str = "OKOU_WORKSPACE_REUSE_RESULT";

/// Logical run-payload field name for the user prompt.
pub const PROMPT_ENV: &str = "VM0_PROMPT";

/// Logical run-payload field name for optional extra system prompt text.
///
/// Unset or empty means there is no extra system prompt.
pub const APPEND_SYSTEM_PROMPT_ENV: &str = "VM0_APPEND_SYSTEM_PROMPT";

/// Sensitive Vercel protection bypass secret for guest API calls.
///
/// This runner-owned bootstrap key intentionally does not use the `VM0_`
/// prefix because the guest-agent HTTP client uses this established name to
/// attach the Vercel bypass header. The runner omits this key when no bypass
/// secret is configured.
pub const VERCEL_PROTECTION_BYPASS_ENV: &str = "VERCEL_PROTECTION_BYPASS";

/// Optional CLI session or thread identifier used when resuming a prior agent
/// session.
///
/// The runner normalizes Codex thread ids before emitting this key.
pub const CANONICAL_RESUME_SESSION_ID_ENV: &str = "OKOU_RESUME_SESSION_ID";

/// Optional Unix epoch millisecond timestamp for when the API accepted the
/// run.
///
/// The runner emits an empty string when the timestamp is unavailable.
pub const CANONICAL_API_START_TIME_ENV: &str = "OKOU_API_START_TIME";

/// Maximum agent execution duration in seconds.
///
/// The runner owns this fixed lifecycle budget. Guest-agent uses it to stop
/// the CLI before the later sandbox supervisor deadline, leaving time for
/// recovery checkpointing and final telemetry. It is intentionally not a
/// local user-tuning key.
pub const AGENT_EXECUTION_TIMEOUT_SECS_ENV: &str = "VM0_AGENT_EXECUTION_TIMEOUT_SECS";

/// Canonical agent execution timeout alias written by the runner.
///
/// Guest readers retain [`AGENT_EXECUTION_TIMEOUT_SECS_ENV`] as a rollback
/// fallback until the canonical writer deployment, supported rollback window,
/// and legacy-read-zero gates in #28914 are complete.
pub const CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV: &str = "OKOU_AGENT_EXECUTION_TIMEOUT_SECS";

/// Logical run-payload field name for sensitive values used by the guest-agent
/// masker.
///
/// The payload is a comma-separated list of base64-encoded secret values, not
/// secret names. The runner includes the sandbox token so event payloads and
/// CLI diagnostics can redact it.
pub const SECRET_VALUES_ENV: &str = "VM0_SECRET_VALUES";

/// Logical run-payload field name for comma-separated Claude Code tool names
/// that should be disallowed.
///
/// Unset or empty means there is no explicit deny list.
pub const DISALLOWED_TOOLS_ENV: &str = "VM0_DISALLOWED_TOOLS";

/// Logical run-payload field name for comma-separated Claude Code tool names
/// that should be allowed.
///
/// Unset or empty means there is no explicit allow list.
pub const TOOLS_ENV: &str = "VM0_TOOLS";

/// Logical run-payload field name for the raw Claude Code settings payload
/// passed to the guest-agent.
///
/// The runner treats this as an opaque string. Unset or empty means there is no
/// settings override.
pub const SETTINGS_ENV: &str = "VM0_SETTINGS";

/// CLI framework selector, for example `claude-code` or `codex`.
///
/// This runner-owned bootstrap key intentionally does not use the `VM0_`
/// prefix because the runner and guest-agent framework selection contract uses
/// this exact name.
pub const CLI_AGENT_TYPE_ENV: &str = "CLI_AGENT_TYPE";

/// Legacy private user-environment file pointer retained by guest readers as a
/// rollback fallback.
///
/// The guest-agent validates that the path points at its per-run private
/// runtime directory, parses it as a `HashMap<String, String>`, and removes the
/// file after loading. Unset or empty means there is no user environment
/// payload.
pub const USER_ENV_FILE_ENV: &str = "VM0_USER_ENV_FILE";

/// Canonical user-environment file pointer written by the runner.
///
/// Guest readers retain [`USER_ENV_FILE_ENV`] until the canonical writer
/// deployment, supported rollback window, and legacy-read-zero gates in #28914
/// are complete.
pub const CANONICAL_USER_ENV_FILE_ENV: &str = "OKOU_USER_ENV_FILE";

/// Private runtime subdirectory used by [`USER_ENV_FILE_ENV`].
pub const USER_ENV_PRIVATE_DIR_NAME: &str = "user-env";

/// Private runtime filename used by [`USER_ENV_FILE_ENV`].
pub const USER_ENV_FILENAME: &str = "env.json";

/// Path to the non-secret connector account context for the current run.
///
/// The runner adds this key to the filtered user environment after removing
/// untrusted runner-owned keys. Managed CLI children may read the referenced
/// file for self-inspection; authorization does not consume it.
pub const CONNECTOR_ACCOUNT_CONTEXT_FILE_ENV: &str = "OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE";

/// Private runtime subdirectory used by [`CONNECTOR_ACCOUNT_CONTEXT_FILE_ENV`].
pub const CONNECTOR_ACCOUNT_CONTEXT_PRIVATE_DIR_NAME: &str = "connector-account-context";

/// Private runtime filename used by [`CONNECTOR_ACCOUNT_CONTEXT_FILE_ENV`].
pub const CONNECTOR_ACCOUNT_CONTEXT_FILENAME: &str = "context.json";

/// Legacy private runner-owned run-payload file pointer retained by guest
/// readers as a rollback fallback.
///
/// Large prompt-like and configuration payloads use this file instead of
/// bootstrap environment values so guest-agent startup does not hit Linux
/// argv/env limits. Production guest-agent startup requires one pointer alias.
pub const RUN_PAYLOAD_FILE_ENV: &str = "VM0_RUN_PAYLOAD_FILE";

/// Canonical run-payload file pointer written by the runner.
///
/// Guest readers retain [`RUN_PAYLOAD_FILE_ENV`] until the canonical writer
/// deployment, supported rollback window, and legacy-read-zero gates in #28914
/// are complete.
pub const CANONICAL_RUN_PAYLOAD_FILE_ENV: &str = "OKOU_RUN_PAYLOAD_FILE";

/// Private runtime subdirectory used by [`RUN_PAYLOAD_FILE_ENV`].
pub const RUN_PAYLOAD_PRIVATE_DIR_NAME: &str = "run-payload";

/// Private runtime filename used by [`RUN_PAYLOAD_FILE_ENV`].
pub const RUN_PAYLOAD_FILENAME: &str = "payload.json";

/// Logical run-payload field name for the JSON array describing artifact mounts
/// prepared by the runner.
///
/// Each entry uses camelCase wire keys: `name`, `mountPath`, `storageId`,
/// `versionId`, and optional `missingRootPolicy`. Unset or empty means there
/// are no artifact mounts.
pub const ARTIFACTS_ENV: &str = "VM0_ARTIFACTS";

/// Logical run-payload field name for the JSON map of feature flag names to
/// enabled states.
///
/// Unset or empty means there are no feature flags.
pub const FEATURE_FLAGS_ENV: &str = "VM0_FEATURE_FLAGS";

/// Logical run-payload field name for API-owned Codex runtime metadata.
pub const CODEX_RUNTIME_CONFIG_ENV: &str = "VM0_CODEX_RUNTIME_CONFIG";

/// Logical run-payload field name for the schema-v2 Pi launch config marker.
///
/// The value is the serialized `{"schemaVersion":2}` version marker. Pi's
/// runtime resources are discovered from canonical filesystem locations by the
/// official loader. The value never reaches the Pi CLI child as an environment
/// value; the guest-agent republishes it through
/// [`PI_LAUNCH_PAYLOAD_FILE_ENV`]. See `piLaunchConfigSchema` in
/// `turbo/packages/api-contracts/src/contracts/runners.ts` for the canonical
/// wire schema.
pub const PI_LAUNCH_CONFIG_ENV: &str = "OKOU_PI_LAUNCH_CONFIG";

/// Path to the private guest-agent-owned Pi launch payload JSON file.
///
/// Prompt-sized Pi launch inputs use this file instead of the child's argv or
/// environment. The guest-agent writes it inside the per-run private runtime
/// directory before spawning its own Pi CLI. See `piLaunchPayloadSchema` in
/// `turbo/packages/api-contracts/src/contracts/runners.ts` for the reader side.
pub const PI_LAUNCH_PAYLOAD_FILE_ENV: &str = "OKOU_PI_LAUNCH_PAYLOAD_FILE";

/// Private runtime subdirectory used by [`PI_LAUNCH_PAYLOAD_FILE_ENV`].
pub const PI_LAUNCH_PAYLOAD_PRIVATE_DIR_NAME: &str = "pi-launch-payload";

/// Private runtime filename used by [`PI_LAUNCH_PAYLOAD_FILE_ENV`].
pub const PI_LAUNCH_PAYLOAD_FILENAME: &str = "payload.json";

/// Logical run-payload field name for non-secret Pi model metadata.
pub const PI_MODEL_CONFIG_ENV: &str = "OKOU_PI_MODEL_CONFIG";

/// Logical run-payload field name for the Chat Thread-owned Pi session id.
pub const PI_SESSION_ID_ENV: &str = "OKOU_PI_SESSION_ID";

/// Runner-owned variable-length run payload sent through
/// [`RUN_PAYLOAD_FILE_ENV`].
///
/// Empty strings mean "no value" for optional fields.
#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPayload {
    /// User prompt payload sent to the guest-agent.
    pub prompt: String,
    /// Optional extra system prompt text.
    #[serde(default)]
    pub append_system_prompt: String,
    /// Sensitive values used by the guest-agent masker.
    #[serde(default)]
    pub secret_values: String,
    /// Comma-separated Claude Code tool names that should be disallowed.
    #[serde(default)]
    pub disallowed_tools: String,
    /// Comma-separated Claude Code tool names that should be allowed.
    #[serde(default)]
    pub tools: String,
    /// Raw Claude Code settings payload passed to the guest-agent.
    #[serde(default)]
    pub settings: String,
    /// JSON array describing artifact mounts prepared by the runner.
    #[serde(default)]
    pub artifacts: String,
    /// JSON map of feature flag names to enabled states.
    #[serde(default)]
    pub feature_flags: String,
    /// JSON object describing API-owned Codex provider/runtime metadata.
    #[serde(default)]
    pub codex_runtime_config: String,
    /// Serialized schema-v2 Pi launch config marker.
    #[serde(default)]
    pub pi_launch_config: String,
    /// JSON object describing non-secret Pi model metadata.
    #[serde(default)]
    pub pi_model_config: String,
    /// Chat Thread id used as Pi's native session id.
    #[serde(default)]
    pub pi_session_id: String,
}

/// Borrowed logical string field from [`RunPayload`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RunPayloadField<'a> {
    /// Logical field name used in diagnostics.
    pub name: &'static str,
    /// Field value carried in the run payload.
    pub value: &'a str,
}

impl RunPayload {
    /// Return all logical string fields carried by this run payload.
    pub fn fields(&self) -> [RunPayloadField<'_>; 12] {
        let Self {
            prompt,
            append_system_prompt,
            secret_values,
            disallowed_tools,
            tools,
            settings,
            artifacts,
            feature_flags,
            codex_runtime_config,
            pi_launch_config,
            pi_model_config,
            pi_session_id,
        } = self;

        [
            RunPayloadField {
                name: PROMPT_ENV,
                value: prompt,
            },
            RunPayloadField {
                name: APPEND_SYSTEM_PROMPT_ENV,
                value: append_system_prompt,
            },
            RunPayloadField {
                name: SECRET_VALUES_ENV,
                value: secret_values,
            },
            RunPayloadField {
                name: DISALLOWED_TOOLS_ENV,
                value: disallowed_tools,
            },
            RunPayloadField {
                name: TOOLS_ENV,
                value: tools,
            },
            RunPayloadField {
                name: SETTINGS_ENV,
                value: settings,
            },
            RunPayloadField {
                name: ARTIFACTS_ENV,
                value: artifacts,
            },
            RunPayloadField {
                name: FEATURE_FLAGS_ENV,
                value: feature_flags,
            },
            RunPayloadField {
                name: CODEX_RUNTIME_CONFIG_ENV,
                value: codex_runtime_config,
            },
            RunPayloadField {
                name: PI_LAUNCH_CONFIG_ENV,
                value: pi_launch_config,
            },
            RunPayloadField {
                name: PI_MODEL_CONFIG_ENV,
                value: pi_model_config,
            },
            RunPayloadField {
                name: PI_SESSION_ID_ENV,
                value: pi_session_id,
            },
        ]
    }

    /// Return the first logical field name whose value contains a NUL byte.
    pub fn first_nul_field(&self) -> Option<&'static str> {
        self.fields()
            .into_iter()
            .find(|field| field.value.contains('\0'))
            .map(|field| field.name)
    }
}

/// Retained local input for the Guest Agent stuck-tool timeout in seconds.
///
/// Local execution may pass this legacy name through ordinary user env via
/// [`GUEST_AGENT_TUNING_ENV_KEYS`]. The runner translates it to
/// [`CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV`] for Guest bootstrap. The
/// guest-agent parses the value as `u64`; unset or unparseable values use the
/// compiled default.
pub const STUCK_TOOL_TIMEOUT_SECS_ENV: &str = "VM0_STUCK_TOOL_TIMEOUT_SECS";

/// Canonical stuck-tool timeout bootstrap output written by the runner.
///
/// Guest readers retain [`STUCK_TOOL_TIMEOUT_SECS_ENV`] as a rollback fallback.
pub const CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV: &str = "OKOU_STUCK_TOOL_TIMEOUT_SECS";

/// Retained local input for the Guest Agent SIGTERM grace period in seconds
/// after the CLI reports a final result.
///
/// Local execution may pass this legacy name through ordinary user env via
/// [`GUEST_AGENT_TUNING_ENV_KEYS`]. The runner translates it to
/// [`CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV`] for Guest bootstrap. Unset,
/// unparseable, or out-of-range values use the guest-agent's compiled default.
pub const POST_RESULT_SIGTERM_GRACE_SECS_ENV: &str = "VM0_POST_RESULT_SIGTERM_GRACE_SECS";

/// Canonical post-result SIGTERM grace bootstrap output written by the runner.
///
/// Guest readers retain [`POST_RESULT_SIGTERM_GRACE_SECS_ENV`] as a rollback
/// fallback.
pub const CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV: &str =
    "OKOU_POST_RESULT_SIGTERM_GRACE_SECS";

/// Retained local input for the Guest Agent absolute cap in seconds before
/// sending SIGTERM after the CLI reports a final result, regardless of later
/// post-result stdout events.
///
/// Local execution may pass this legacy name through ordinary user env via
/// [`GUEST_AGENT_TUNING_ENV_KEYS`]. The runner translates it to
/// [`CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV`] for Guest bootstrap. Unset,
/// unparseable, or out-of-range values use the guest-agent's compiled default.
pub const POST_RESULT_TOTAL_CAP_SECS_ENV: &str = "VM0_POST_RESULT_TOTAL_CAP_SECS";

/// Canonical post-result total-cap bootstrap output written by the runner.
///
/// Guest readers retain [`POST_RESULT_TOTAL_CAP_SECS_ENV`] as a rollback
/// fallback.
pub const CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV: &str = "OKOU_POST_RESULT_TOTAL_CAP_SECS";

/// Retained local input for the Guest Agent grace period in seconds before
/// escalating from SIGTERM to SIGKILL after the CLI reports a final result.
///
/// Local execution may pass this legacy name through ordinary user env via
/// [`GUEST_AGENT_TUNING_ENV_KEYS`]. The runner translates it to
/// [`CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV`] for Guest bootstrap. Unset,
/// unparseable, or out-of-range values use the guest-agent's compiled default.
pub const POST_RESULT_SIGKILL_GRACE_SECS_ENV: &str = "VM0_POST_RESULT_SIGKILL_GRACE_SECS";

/// Canonical post-result SIGKILL grace bootstrap output written by the runner.
///
/// Guest readers retain [`POST_RESULT_SIGKILL_GRACE_SECS_ENV`] as a rollback
/// fallback.
pub const CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV: &str =
    "OKOU_POST_RESULT_SIGKILL_GRACE_SECS";

/// Complete mapping from retained legacy local tuning inputs to canonical
/// Guest bootstrap outputs.
///
/// Each tuple is `(legacy_input, canonical_bootstrap_output)`.
pub const GUEST_AGENT_TUNING_ENV_MAPPINGS: [(&str, &str); 4] = [
    (
        STUCK_TOOL_TIMEOUT_SECS_ENV,
        CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
    ),
    (
        POST_RESULT_SIGTERM_GRACE_SECS_ENV,
        CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
    ),
    (
        POST_RESULT_TOTAL_CAP_SECS_ENV,
        CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
    ),
    (
        POST_RESULT_SIGKILL_GRACE_SECS_ENV,
        CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
    ),
];

/// Test/debug bootstrap switch that makes the guest-agent use the mock Claude
/// binary.
///
/// This runner-owned bootstrap key intentionally does not use the `VM0_`
/// prefix because the mock launcher contract uses this exact name. The
/// guest-agent treats exactly `true` as enabled.
pub const USE_MOCK_CLAUDE_ENV: &str = "USE_MOCK_CLAUDE";

/// Test/debug bootstrap switch that makes the guest-agent use the mock Codex
/// binary.
///
/// This runner-owned bootstrap key intentionally does not use the `VM0_`
/// prefix because the mock launcher contract uses this exact name. The
/// guest-agent treats `true` or `1` as enabled.
pub const USE_MOCK_CODEX_ENV: &str = "USE_MOCK_CODEX";

/// Optional test/debug override for the mock Claude binary path.
///
/// Unset means the guest-agent uses its compiled default mock binary path.
pub const CANONICAL_MOCK_CLAUDE_PATH_ENV: &str = "OKOU_MOCK_CLAUDE_PATH";

/// Optional test/debug override for the mock Codex binary path.
///
/// Unset means the guest-agent uses its compiled default mock binary path.
pub const CANONICAL_MOCK_CODEX_PATH_ENV: &str = "OKOU_MOCK_CODEX_PATH";

/// Retired runner bootstrap key that must remain protected at the user-env
/// boundary.
pub const WORKING_DIR_ENV: &str = "VM0_WORKING_DIR";

/// Retained legacy Guest Agent tuning inputs that local user env may provide.
///
/// These are the only `VM0_` keys intentionally allowed to cross the local
/// user-env boundary. The runner translates them to the corresponding canonical
/// outputs in [`GUEST_AGENT_TUNING_ENV_MAPPINGS`] separately from the general
/// user environment payload.
pub const GUEST_AGENT_TUNING_ENV_KEYS: &[&str] = &[
    GUEST_AGENT_TUNING_ENV_MAPPINGS[0].0,
    GUEST_AGENT_TUNING_ENV_MAPPINGS[1].0,
    GUEST_AGENT_TUNING_ENV_MAPPINGS[2].0,
    GUEST_AGENT_TUNING_ENV_MAPPINGS[3].0,
];

const EXPLICIT_RUNNER_OWNED_ENV_KEYS: &[&str] = &[
    RUN_ID_ENV,
    CANONICAL_SANDBOX_ID_ENV,
    CANONICAL_SANDBOX_REUSE_RESULT_ENV,
    CANONICAL_WORKSPACE_REUSE_RESULT_ENV,
    CANONICAL_API_START_TIME_ENV,
    PI_SESSION_ID_ENV,
    PI_LAUNCH_CONFIG_ENV,
    PI_LAUNCH_PAYLOAD_FILE_ENV,
    PI_MODEL_CONFIG_ENV,
    CONNECTOR_ACCOUNT_CONTEXT_FILE_ENV,
    CLI_AGENT_TYPE_ENV,
    USE_MOCK_CLAUDE_ENV,
    USE_MOCK_CODEX_ENV,
    VERCEL_PROTECTION_BYPASS_ENV,
];

const USER_ENV_KEY_DIAGNOSTIC_MAX_CHARS: usize = 128;

/// Returns whether `key` is supported by vm0 guest shell exec env injection.
///
/// This is the shell identifier format accepted by the guest env script's
/// `export KEY=VALUE` lines. It is intentionally not a general definition of
/// every environment variable name an operating system can carry.
pub fn is_shell_identifier_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

/// Returns whether `key` is a supported guest-agent tuning override.
///
/// Local submission uses this allowlist to permit selected runner-owned timing
/// controls while continuing to reject general runner bootstrap keys from user
/// env.
pub fn is_guest_agent_tuning_env_key(key: &str) -> bool {
    GUEST_AGENT_TUNING_ENV_KEYS.contains(&key)
}

/// Returns whether `key` belongs to the runner-owned bootstrap namespace.
///
/// This covers every `OKOU_` and `VM0_` key, including future and retired names,
/// plus the explicit bootstrap keys required by established runner, guest-agent,
/// or integration contracts. Runner and local-submit code use this predicate to
/// scrub or reject user-provided env keys before the guest-agent starts.
pub fn is_runner_owned_env_key(key: &str) -> bool {
    key.starts_with("OKOU_") || is_pre_platform_environment_runner_owned_env_key(key)
}

/// Returns whether `key` was runner-owned before `platformEnvironment` claims.
///
/// New runners use this only for old API claims or legitimately stored pre-field
/// contexts. Remove it after previous API rollback targets, supported pre-field
/// contexts, and old runners/sandboxes pass the #28914 drain gates.
pub fn is_pre_platform_environment_runner_owned_env_key(key: &str) -> bool {
    key.starts_with("VM0_") || EXPLICIT_RUNNER_OWNED_ENV_KEYS.contains(&key)
}

/// Escapes and bounds a user-controlled env key for diagnostics.
///
/// The returned string contains `escape_debug` output truncated to 128
/// characters, with `...` appended when truncation happens. This keeps control
/// characters and very long keys from producing confusing errors or log lines.
pub fn sanitize_user_env_key_for_diagnostic(key: &str) -> String {
    let mut chars = key.escape_debug();
    let mut truncated = String::new();
    for _ in 0..USER_ENV_KEY_DIAGNOSTIC_MAX_CHARS {
        let Some(ch) = chars.next() else {
            return truncated;
        };
        truncated.push(ch);
    }
    if chars.next().is_some() {
        truncated.push_str("...");
    }
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_names_match_wire_values() {
        assert_eq!(API_URL_ENV, "VM0_API_BACKEND_URL");
        assert_eq!(CANONICAL_API_URL_ENV, "OKOU_API_BACKEND_URL");
        assert_eq!(RUN_ID_ENV, "OKOU_RUN_ID");
        assert_eq!(CANONICAL_API_TOKEN_ENV, "OKOU_API_TOKEN");
        assert_eq!(CANONICAL_SANDBOX_ID_ENV, "OKOU_SANDBOX_ID");
        assert_eq!(
            CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            "OKOU_SANDBOX_REUSE_RESULT"
        );
        assert_eq!(
            CANONICAL_WORKSPACE_REUSE_RESULT_ENV,
            "OKOU_WORKSPACE_REUSE_RESULT"
        );
        assert_eq!(CANONICAL_RESUME_SESSION_ID_ENV, "OKOU_RESUME_SESSION_ID");
        assert_eq!(CANONICAL_API_START_TIME_ENV, "OKOU_API_START_TIME");
        assert_eq!(PI_SESSION_ID_ENV, "OKOU_PI_SESSION_ID");
        assert_eq!(PI_LAUNCH_CONFIG_ENV, "OKOU_PI_LAUNCH_CONFIG");
        assert_eq!(PI_LAUNCH_PAYLOAD_FILE_ENV, "OKOU_PI_LAUNCH_PAYLOAD_FILE");
        assert_eq!(PI_LAUNCH_PAYLOAD_PRIVATE_DIR_NAME, "pi-launch-payload");
        assert_eq!(PI_LAUNCH_PAYLOAD_FILENAME, "payload.json");
        assert_eq!(PI_MODEL_CONFIG_ENV, "OKOU_PI_MODEL_CONFIG");
        assert_eq!(CLI_AGENT_TYPE_ENV, "CLI_AGENT_TYPE");
        assert_eq!(
            AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            "VM0_AGENT_EXECUTION_TIMEOUT_SECS"
        );
        assert_eq!(
            CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            "OKOU_AGENT_EXECUTION_TIMEOUT_SECS"
        );
        assert_eq!(USER_ENV_FILE_ENV, "VM0_USER_ENV_FILE");
        assert_eq!(CANONICAL_USER_ENV_FILE_ENV, "OKOU_USER_ENV_FILE");
        assert_eq!(USER_ENV_PRIVATE_DIR_NAME, "user-env");
        assert_eq!(USER_ENV_FILENAME, "env.json");
        assert_eq!(
            CONNECTOR_ACCOUNT_CONTEXT_FILE_ENV,
            "OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE"
        );
        assert_eq!(
            CONNECTOR_ACCOUNT_CONTEXT_PRIVATE_DIR_NAME,
            "connector-account-context"
        );
        assert_eq!(CONNECTOR_ACCOUNT_CONTEXT_FILENAME, "context.json");
        assert_eq!(RUN_PAYLOAD_FILE_ENV, "VM0_RUN_PAYLOAD_FILE");
        assert_eq!(CANONICAL_RUN_PAYLOAD_FILE_ENV, "OKOU_RUN_PAYLOAD_FILE");
        assert_eq!(RUN_PAYLOAD_PRIVATE_DIR_NAME, "run-payload");
        assert_eq!(RUN_PAYLOAD_FILENAME, "payload.json");
        assert_eq!(
            CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
            "OKOU_STUCK_TOOL_TIMEOUT_SECS"
        );
        assert_eq!(
            CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
            "OKOU_POST_RESULT_SIGTERM_GRACE_SECS"
        );
        assert_eq!(
            CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
            "OKOU_POST_RESULT_TOTAL_CAP_SECS"
        );
        assert_eq!(
            CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
            "OKOU_POST_RESULT_SIGKILL_GRACE_SECS"
        );
        assert_eq!(CANONICAL_MOCK_CLAUDE_PATH_ENV, "OKOU_MOCK_CLAUDE_PATH");
        assert_eq!(CANONICAL_MOCK_CODEX_PATH_ENV, "OKOU_MOCK_CODEX_PATH");
    }

    #[test]
    fn run_payload_uses_camel_case_wire_keys() {
        let payload = RunPayload {
            prompt: "hello".to_string(),
            append_system_prompt: "system".to_string(),
            secret_values: "secret".to_string(),
            disallowed_tools: "WebFetch".to_string(),
            tools: "Bash".to_string(),
            settings: "{}".to_string(),
            artifacts: "[]".to_string(),
            feature_flags: r#"{"flag":true}"#.to_string(),
            codex_runtime_config: r#"{"providerId":"deepseek"}"#.to_string(),
            pi_launch_config: r#"{"schemaVersion":2}"#.to_string(),
            pi_model_config: r#"{"provider":"deepseek"}"#.to_string(),
            pi_session_id: "22222222-2222-4222-8222-222222222222".to_string(),
        };

        let json = serde_json::to_value(&payload).unwrap();

        assert_eq!(json["prompt"], "hello");
        assert_eq!(json["appendSystemPrompt"], "system");
        assert_eq!(json["secretValues"], "secret");
        assert_eq!(json["disallowedTools"], "WebFetch");
        assert_eq!(json["featureFlags"], r#"{"flag":true}"#);
        assert_eq!(json["codexRuntimeConfig"], r#"{"providerId":"deepseek"}"#);
        assert_eq!(json["piLaunchConfig"], r#"{"schemaVersion":2}"#);
        assert_eq!(json["piModelConfig"], r#"{"provider":"deepseek"}"#);
        assert_eq!(json["piSessionId"], "22222222-2222-4222-8222-222222222222");
    }

    #[test]
    fn run_payload_fields_returns_logical_names_and_values() {
        let payload = RunPayload {
            prompt: "prompt".to_string(),
            append_system_prompt: "system".to_string(),
            secret_values: "secret".to_string(),
            disallowed_tools: "WebFetch".to_string(),
            tools: "Bash".to_string(),
            settings: "{}".to_string(),
            artifacts: "[]".to_string(),
            feature_flags: r#"{"flag":true}"#.to_string(),
            codex_runtime_config: r#"{"providerId":"deepseek"}"#.to_string(),
            pi_launch_config: r#"{"schemaVersion":2}"#.to_string(),
            pi_model_config: r#"{"provider":"deepseek"}"#.to_string(),
            pi_session_id: "22222222-2222-4222-8222-222222222222".to_string(),
        };

        let fields = payload.fields();

        assert_eq!(
            fields,
            [
                RunPayloadField {
                    name: PROMPT_ENV,
                    value: "prompt"
                },
                RunPayloadField {
                    name: APPEND_SYSTEM_PROMPT_ENV,
                    value: "system"
                },
                RunPayloadField {
                    name: SECRET_VALUES_ENV,
                    value: "secret"
                },
                RunPayloadField {
                    name: DISALLOWED_TOOLS_ENV,
                    value: "WebFetch"
                },
                RunPayloadField {
                    name: TOOLS_ENV,
                    value: "Bash"
                },
                RunPayloadField {
                    name: SETTINGS_ENV,
                    value: "{}"
                },
                RunPayloadField {
                    name: ARTIFACTS_ENV,
                    value: "[]"
                },
                RunPayloadField {
                    name: FEATURE_FLAGS_ENV,
                    value: r#"{"flag":true}"#
                },
                RunPayloadField {
                    name: CODEX_RUNTIME_CONFIG_ENV,
                    value: r#"{"providerId":"deepseek"}"#
                },
                RunPayloadField {
                    name: PI_LAUNCH_CONFIG_ENV,
                    value: r#"{"schemaVersion":2}"#
                },
                RunPayloadField {
                    name: PI_MODEL_CONFIG_ENV,
                    value: r#"{"provider":"deepseek"}"#
                },
                RunPayloadField {
                    name: PI_SESSION_ID_ENV,
                    value: "22222222-2222-4222-8222-222222222222"
                },
            ]
        );
    }

    #[test]
    fn run_payload_first_nul_field_reports_logical_name() {
        let payload = RunPayload {
            settings: "bad\0settings".to_string(),
            ..RunPayload::default()
        };

        assert_eq!(payload.first_nul_field(), Some(SETTINGS_ENV));
    }

    #[test]
    fn run_payload_first_nul_field_accepts_clean_payload() {
        let payload = RunPayload {
            prompt: "prompt".to_string(),
            append_system_prompt: "system".to_string(),
            secret_values: "secret".to_string(),
            disallowed_tools: "WebFetch".to_string(),
            tools: "Bash".to_string(),
            settings: "{}".to_string(),
            artifacts: "[]".to_string(),
            feature_flags: r#"{"flag":true}"#.to_string(),
            codex_runtime_config: r#"{"providerId":"deepseek"}"#.to_string(),
            ..RunPayload::default()
        };

        assert_eq!(payload.first_nul_field(), None);
    }

    #[test]
    fn shell_identifier_env_key_accepts_supported_keys() {
        for key in ["FOO", "_FOO", "FOO_1", "_", "A1_B2"] {
            assert!(
                is_shell_identifier_env_key(key),
                "{key} should be a supported shell exec env key"
            );
        }
    }

    #[test]
    fn shell_identifier_env_key_rejects_unsupported_keys() {
        for key in [
            "",
            "1BAD",
            "BAD-NAME",
            "BAD.NAME",
            "BAD NAME",
            "ÅKEY",
            "\u{00e9}clair",
        ] {
            assert!(
                !is_shell_identifier_env_key(key),
                "{key} should not be a supported shell exec env key"
            );
        }
    }

    #[test]
    fn user_env_key_diagnostic_escapes_and_truncates() {
        let key = format!("BAD\n{}", "X".repeat(200));
        let diagnostic = sanitize_user_env_key_for_diagnostic(&key);

        assert!(diagnostic.starts_with(r"BAD\n"));
        assert!(diagnostic.ends_with("..."));
        assert!(!diagnostic.contains('\n'));
    }

    #[test]
    fn runner_owned_key_detection_covers_bootstrap_namespaces() {
        for key in [
            API_URL_ENV,
            CANONICAL_API_URL_ENV,
            RUN_ID_ENV,
            "VM0_API_TOKEN",
            CANONICAL_API_TOKEN_ENV,
            CANONICAL_SANDBOX_ID_ENV,
            CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            CANONICAL_WORKSPACE_REUSE_RESULT_ENV,
            CANONICAL_RESUME_SESSION_ID_ENV,
            CANONICAL_API_START_TIME_ENV,
            "VM0_SANDBOX_ID",
            "VM0_SANDBOX_REUSE_RESULT",
            "VM0_WORKSPACE_REUSE_RESULT",
            "VM0_RESUME_SESSION_ID",
            "VM0_API_START_TIME",
            PI_SESSION_ID_ENV,
            PI_LAUNCH_CONFIG_ENV,
            PI_LAUNCH_PAYLOAD_FILE_ENV,
            PI_MODEL_CONFIG_ENV,
            CONNECTOR_ACCOUNT_CONTEXT_FILE_ENV,
            WORKING_DIR_ENV,
            USER_ENV_FILE_ENV,
            CANONICAL_USER_ENV_FILE_ENV,
            RUN_PAYLOAD_FILE_ENV,
            CANONICAL_RUN_PAYLOAD_FILE_ENV,
            CLI_AGENT_TYPE_ENV,
            USE_MOCK_CLAUDE_ENV,
            USE_MOCK_CODEX_ENV,
            VERCEL_PROTECTION_BYPASS_ENV,
        ] {
            assert!(is_runner_owned_env_key(key), "{key} should be runner-owned");
        }
        assert!(is_runner_owned_env_key("OKOU_TOKEN"));
        assert!(is_runner_owned_env_key("OKOU_UNRELATED"));
        assert!(!is_runner_owned_env_key("CUSTOM_ENV"));
    }

    #[test]
    fn pre_platform_environment_detection_preserves_previous_ownership() {
        assert!(is_pre_platform_environment_runner_owned_env_key(RUN_ID_ENV));
        assert!(is_pre_platform_environment_runner_owned_env_key(
            "VM0_FUTURE_RUNNER_KEY"
        ));
        assert!(!is_pre_platform_environment_runner_owned_env_key(
            "OKOU_TOKEN"
        ));
        assert!(!is_pre_platform_environment_runner_owned_env_key(
            "OKOU_UNRELATED"
        ));
        assert!(!is_pre_platform_environment_runner_owned_env_key(
            "CUSTOM_ENV"
        ));
    }

    #[test]
    fn guest_agent_tuning_mapping_and_local_inputs_are_explicit() {
        assert_eq!(
            GUEST_AGENT_TUNING_ENV_MAPPINGS,
            [
                (
                    STUCK_TOOL_TIMEOUT_SECS_ENV,
                    CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
                ),
                (
                    POST_RESULT_SIGTERM_GRACE_SECS_ENV,
                    CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
                ),
                (
                    POST_RESULT_TOTAL_CAP_SECS_ENV,
                    CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
                ),
                (
                    POST_RESULT_SIGKILL_GRACE_SECS_ENV,
                    CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
                ),
            ]
        );
        assert_eq!(
            GUEST_AGENT_TUNING_ENV_KEYS,
            [
                STUCK_TOOL_TIMEOUT_SECS_ENV,
                POST_RESULT_SIGTERM_GRACE_SECS_ENV,
                POST_RESULT_TOTAL_CAP_SECS_ENV,
                POST_RESULT_SIGKILL_GRACE_SECS_ENV,
            ]
        );
        for key in [
            CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
            CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
            CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
            CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
        ] {
            assert!(
                !is_guest_agent_tuning_env_key(key),
                "canonical bootstrap output {key} must not become a local tuning input"
            );
        }
        for key in [API_URL_ENV, CANONICAL_API_URL_ENV] {
            assert!(
                !is_guest_agent_tuning_env_key(key),
                "API URL bootstrap key {key} must not become a local tuning input"
            );
        }
    }

    /// Contract sources scanned for declared environment key constants.
    ///
    /// Every module declaring a `*_ENV` bootstrap key must be listed here, or
    /// its keys escape the protection check below.
    const CONTRACT_ENV_SOURCES: &[(&str, &str)] = &[
        ("env.rs", include_str!("env.rs")),
        ("runtime_paths.rs", include_str!("runtime_paths.rs")),
        (
            "process_containment.rs",
            include_str!("process_containment.rs"),
        ),
    ];

    /// Extracts every `pub const NAME_ENV: &str = "VALUE";` declaration from a
    /// contract source as a `(name, value)` pair.
    ///
    /// Reading declarations out of the source keeps the check exhaustive. A
    /// hand-maintained list would only cover the keys someone remembered to
    /// register, which is the failure this check exists to prevent.
    ///
    /// Only declarations starting a line are matched, so prose mentioning the
    /// pattern inside a comment is not treated as a declaration.
    ///
    /// Rustfmt may keep the string literal on the declaration line or move it
    /// to the immediately following line. A `_ENV` declaration this cannot
    /// parse yields an empty value, which fails the protection check rather
    /// than being skipped, so an unparsed declaration fails closed.
    fn declared_env_key_constants(source: &str) -> Vec<(&str, &str)> {
        let lines = source.lines().collect::<Vec<_>>();
        lines
            .iter()
            .enumerate()
            .filter_map(|(index, line)| {
                let declaration = line.trim_start().strip_prefix("pub const ")?;
                let (name, rest) = declaration.split_once(':')?;
                let name = name.trim();
                if !name.ends_with("_ENV") {
                    return None;
                }
                let (_, rest) = rest.split_once('=')?;
                let literal_source = if rest.trim_start().starts_with('"') {
                    rest
                } else {
                    lines.get(index + 1).copied().unwrap_or("")
                };
                let value = literal_source
                    .trim_start()
                    .strip_prefix('"')
                    .and_then(|literal| literal.split_once('"'))
                    .map_or("", |(value, _)| value);
                Some((name, value))
            })
            .collect()
    }

    #[test]
    fn every_declared_env_key_is_classified_for_user_env_protection() {
        let mut unprotected = Vec::new();
        let mut total = 0;

        for (file, source) in CONTRACT_ENV_SOURCES {
            let declared = declared_env_key_constants(source);
            assert!(
                !declared.is_empty(),
                "{file} yielded no *_ENV declarations; the source scan is broken"
            );
            total += declared.len();

            for (name, value) in declared {
                if !is_runner_owned_env_key(value) {
                    unprotected.push(format!("{file}: {name} = {value:?}"));
                }
            }
        }

        assert!(
            total >= 37,
            "expected at least 37 declared *_ENV keys across the contract sources, found {total}; \
             lower this bound only when a key is deliberately removed"
        );
        assert!(
            unprotected.is_empty(),
            "these bootstrap env keys are not protected from user env injection. Add each to \
             EXPLICIT_RUNNER_OWNED_ENV_KEYS, or keep an OKOU_/VM0_ prefix:\n  {}",
            unprotected.join("\n  ")
        );
    }
}
