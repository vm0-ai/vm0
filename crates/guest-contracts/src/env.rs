//! Runner-to-guest environment variable name contract.
//!
//! The runner uses these names to bootstrap the guest-agent process. User,
//! model-provider, and connector environment is a separate payload loaded
//! through [`USER_ENV_FILE_ENV`], so user-provided keys cannot override runner
//! bootstrap controls directly.
//!
//! The `VM0_` namespace is runner-owned, including keys defined in sibling
//! modules such as [`crate::runtime_paths::GUEST_RUNTIME_DIR_ENV`]. User env
//! filtering should treat current, future, and retired `VM0_` keys as
//! protected. A small set of non-`VM0_` bootstrap keys is also runner-owned
//! because external tools expect those exact names.
//!
//! [`GUEST_AGENT_TUNING_ENV_KEYS`] is the only intentional exception where
//! selected runner-owned keys may cross the local user-env boundary as
//! guest-agent timing overrides.

/// Backend API base URL provided to the guest-agent.
///
/// This is the only runner bootstrap key intentionally exposed to CLI child
/// processes by the guest-agent's curated child environment.
pub const API_URL_ENV: &str = "VM0_API_URL";

/// Stable run identifier used by guest-agent logs, telemetry, and runtime
/// file path resolution.
pub const RUN_ID_ENV: &str = "VM0_RUN_ID";

/// Sensitive backend API bearer token for guest-agent calls.
///
/// This value is runner-owned and must not be exposed through user-provided
/// environment or CLI child env.
pub const API_TOKEN_ENV: &str = "VM0_API_TOKEN";

/// Sandbox identifier assigned by the runner.
pub const SANDBOX_ID_ENV: &str = "VM0_SANDBOX_ID";

/// Wire value describing whether the sandbox was fresh, reused, or resumed
/// from another runner-side reuse state.
pub const SANDBOX_REUSE_RESULT_ENV: &str = "VM0_SANDBOX_REUSE_RESULT";

/// User prompt payload sent to the guest-agent.
pub const PROMPT_ENV: &str = "VM0_PROMPT";

/// Optional extra system prompt text.
///
/// The runner omits this key when the append-system-prompt value is absent or
/// empty.
pub const APPEND_SYSTEM_PROMPT_ENV: &str = "VM0_APPEND_SYSTEM_PROMPT";

/// Sensitive Vercel protection bypass secret for guest API calls.
///
/// This runner-owned bootstrap key intentionally does not use the `VM0_`
/// prefix because Vercel expects this exact environment variable name.
pub const VERCEL_PROTECTION_BYPASS_ENV: &str = "VERCEL_PROTECTION_BYPASS";

/// Optional CLI session or thread identifier used when resuming a prior agent
/// session.
///
/// The runner normalizes Codex thread ids before emitting this key.
pub const RESUME_SESSION_ID_ENV: &str = "VM0_RESUME_SESSION_ID";

/// Optional Unix epoch millisecond timestamp for when the API accepted the
/// run.
pub const API_START_TIME_ENV: &str = "VM0_API_START_TIME";

/// Sensitive values used by the guest-agent masker.
///
/// The payload is a comma-separated list of base64-encoded secret values, not
/// secret names. The runner includes the sandbox token so guest logs and event
/// payloads can redact it.
pub const SECRET_VALUES_ENV: &str = "VM0_SECRET_VALUES";

/// Comma-separated Claude Code tool names that should be disallowed.
pub const DISALLOWED_TOOLS_ENV: &str = "VM0_DISALLOWED_TOOLS";

/// Comma-separated Claude Code tool names that should be allowed.
pub const TOOLS_ENV: &str = "VM0_TOOLS";

/// Raw Claude Code settings payload passed to the guest-agent.
///
/// The runner treats this as an opaque string and currently emits JSON from
/// the API execution context.
pub const SETTINGS_ENV: &str = "VM0_SETTINGS";

/// CLI framework selector, for example `claude-code` or `codex`.
///
/// This runner-owned bootstrap key intentionally does not use the `VM0_`
/// prefix because downstream CLI setup uses this exact name.
pub const CLI_AGENT_TYPE_ENV: &str = "CLI_AGENT_TYPE";

/// Path to the private user environment JSON file written by the runner.
///
/// The guest-agent validates that the path points at its per-run private
/// runtime directory, parses it as a `HashMap<String, String>`, and removes the
/// file after loading. Unset or empty means there is no user environment
/// payload.
pub const USER_ENV_FILE_ENV: &str = "VM0_USER_ENV_FILE";

/// JSON array describing artifact mounts prepared by the runner.
///
/// Each entry uses camelCase wire keys: `name`, `mountPath`, `storageId`,
/// `versionId`, and optional `missingRootPolicy`. Unset or empty means there
/// are no artifact mounts.
pub const ARTIFACTS_ENV: &str = "VM0_ARTIFACTS";

/// JSON map of feature flag names to enabled states.
pub const FEATURE_FLAGS_ENV: &str = "VM0_FEATURE_FLAGS";

/// Guest-agent stuck-tool timeout override in seconds.
///
/// This is a tuning key: local execution may pass it through user env via
/// [`GUEST_AGENT_TUNING_ENV_KEYS`].
pub const STUCK_TOOL_TIMEOUT_SECS_ENV: &str = "VM0_STUCK_TOOL_TIMEOUT_SECS";

/// Guest-agent grace period in seconds before sending SIGTERM after the CLI
/// reports a final result.
///
/// This is a tuning key: local execution may pass it through user env via
/// [`GUEST_AGENT_TUNING_ENV_KEYS`].
pub const POST_RESULT_SIGTERM_GRACE_SECS_ENV: &str = "VM0_POST_RESULT_SIGTERM_GRACE_SECS";

/// Guest-agent grace period in seconds before escalating from SIGTERM to
/// SIGKILL after the CLI reports a final result.
///
/// This is a tuning key: local execution may pass it through user env via
/// [`GUEST_AGENT_TUNING_ENV_KEYS`].
pub const POST_RESULT_SIGKILL_GRACE_SECS_ENV: &str = "VM0_POST_RESULT_SIGKILL_GRACE_SECS";

/// Test/debug bootstrap switch that makes the guest-agent use the mock Claude
/// binary.
///
/// This runner-owned bootstrap key intentionally does not use the `VM0_`
/// prefix because the mock launcher contract uses this exact name.
pub const USE_MOCK_CLAUDE_ENV: &str = "USE_MOCK_CLAUDE";

/// Test/debug bootstrap switch that makes the guest-agent use the mock Codex
/// binary.
///
/// This runner-owned bootstrap key intentionally does not use the `VM0_`
/// prefix because the mock launcher contract uses this exact name.
pub const USE_MOCK_CODEX_ENV: &str = "USE_MOCK_CODEX";

/// Optional test/debug override for the mock Claude binary path.
pub const MOCK_CLAUDE_PATH_ENV: &str = "VM0_MOCK_CLAUDE_PATH";

/// Optional test/debug override for the mock Codex binary path.
pub const MOCK_CODEX_PATH_ENV: &str = "VM0_MOCK_CODEX_PATH";

/// Retired runner bootstrap key that must remain protected at the user-env
/// boundary.
pub const WORKING_DIR_ENV: &str = "VM0_WORKING_DIR";

/// Runner-owned guest-agent tuning keys that local user env may provide.
///
/// These are the only `VM0_` keys intentionally allowed to cross the local
/// user-env boundary. They tune guest-agent timing behavior and are copied into
/// the bootstrap env separately from the general user environment payload.
pub const GUEST_AGENT_TUNING_ENV_KEYS: &[&str] = &[
    STUCK_TOOL_TIMEOUT_SECS_ENV,
    POST_RESULT_SIGTERM_GRACE_SECS_ENV,
    POST_RESULT_SIGKILL_GRACE_SECS_ENV,
];

const NON_VM0_RUNNER_OWNED_ENV_KEYS: &[&str] = &[
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
/// This covers every `VM0_` key, including future and retired names, plus the
/// explicit non-`VM0_` bootstrap keys that external tools require. Runner and
/// local-submit code use this predicate to scrub or reject user-provided env
/// keys before the guest-agent starts.
pub fn is_runner_owned_env_key(key: &str) -> bool {
    key.starts_with("VM0_") || NON_VM0_RUNNER_OWNED_ENV_KEYS.contains(&key)
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
        assert_eq!(API_URL_ENV, "VM0_API_URL");
        assert_eq!(RUN_ID_ENV, "VM0_RUN_ID");
        assert_eq!(CLI_AGENT_TYPE_ENV, "CLI_AGENT_TYPE");
        assert_eq!(USER_ENV_FILE_ENV, "VM0_USER_ENV_FILE");
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
            WORKING_DIR_ENV,
            CLI_AGENT_TYPE_ENV,
            USE_MOCK_CLAUDE_ENV,
            USE_MOCK_CODEX_ENV,
            VERCEL_PROTECTION_BYPASS_ENV,
        ] {
            assert!(is_runner_owned_env_key(key), "{key} should be runner-owned");
        }
        assert!(!is_runner_owned_env_key("CUSTOM_ENV"));
    }

    #[test]
    fn guest_agent_tuning_keys_are_explicit() {
        assert!(is_guest_agent_tuning_env_key(STUCK_TOOL_TIMEOUT_SECS_ENV));
        assert!(is_guest_agent_tuning_env_key(
            POST_RESULT_SIGTERM_GRACE_SECS_ENV
        ));
        assert!(is_guest_agent_tuning_env_key(
            POST_RESULT_SIGKILL_GRACE_SECS_ENV
        ));
        assert!(!is_guest_agent_tuning_env_key(API_URL_ENV));
    }
}
