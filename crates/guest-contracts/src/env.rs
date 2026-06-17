//! Runner-to-guest environment variable name contract.

pub const API_URL_ENV: &str = "VM0_API_URL";
pub const RUN_ID_ENV: &str = "VM0_RUN_ID";
pub const API_TOKEN_ENV: &str = "VM0_API_TOKEN";
pub const SANDBOX_ID_ENV: &str = "VM0_SANDBOX_ID";
pub const SANDBOX_REUSE_RESULT_ENV: &str = "VM0_SANDBOX_REUSE_RESULT";
pub const PROMPT_ENV: &str = "VM0_PROMPT";
pub const APPEND_SYSTEM_PROMPT_ENV: &str = "VM0_APPEND_SYSTEM_PROMPT";
pub const VERCEL_PROTECTION_BYPASS_ENV: &str = "VERCEL_PROTECTION_BYPASS";
pub const RESUME_SESSION_ID_ENV: &str = "VM0_RESUME_SESSION_ID";
pub const API_START_TIME_ENV: &str = "VM0_API_START_TIME";
pub const SECRET_VALUES_ENV: &str = "VM0_SECRET_VALUES";
pub const DISALLOWED_TOOLS_ENV: &str = "VM0_DISALLOWED_TOOLS";
pub const TOOLS_ENV: &str = "VM0_TOOLS";
pub const SETTINGS_ENV: &str = "VM0_SETTINGS";
pub const CHAT_STREAM_CHANNEL_ENV: &str = "VM0_CHAT_STREAM_CHANNEL";
pub const CHAT_STREAM_TOPIC_ENV: &str = "VM0_CHAT_STREAM_TOPIC";
pub const CHAT_STREAM_TOKEN_ENV: &str = "VM0_CHAT_STREAM_TOKEN";
pub const CHAT_STREAM_ABLY_BASE_ENV: &str = "VM0_CHAT_STREAM_ABLY_BASE";
pub const CLI_AGENT_TYPE_ENV: &str = "CLI_AGENT_TYPE";
pub const USER_ENV_FILE_ENV: &str = "VM0_USER_ENV_FILE";
pub const ARTIFACTS_ENV: &str = "VM0_ARTIFACTS";
pub const FEATURE_FLAGS_ENV: &str = "VM0_FEATURE_FLAGS";
pub const STUCK_TOOL_TIMEOUT_SECS_ENV: &str = "VM0_STUCK_TOOL_TIMEOUT_SECS";
pub const POST_RESULT_SIGTERM_GRACE_SECS_ENV: &str = "VM0_POST_RESULT_SIGTERM_GRACE_SECS";
pub const POST_RESULT_SIGKILL_GRACE_SECS_ENV: &str = "VM0_POST_RESULT_SIGKILL_GRACE_SECS";
pub const USE_MOCK_CLAUDE_ENV: &str = "USE_MOCK_CLAUDE";
pub const USE_MOCK_CODEX_ENV: &str = "USE_MOCK_CODEX";
pub const MOCK_CLAUDE_PATH_ENV: &str = "VM0_MOCK_CLAUDE_PATH";
pub const MOCK_CODEX_PATH_ENV: &str = "VM0_MOCK_CODEX_PATH";

/// Retired runner bootstrap key that must remain protected at the user-env
/// boundary.
pub const WORKING_DIR_ENV: &str = "VM0_WORKING_DIR";

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
            "\u{00e9}clair",
        ] {
            assert!(
                !is_shell_identifier_env_key(key),
                "{key} should not be a supported shell exec env key"
            );
        }
    }
}
