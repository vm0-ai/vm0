//! Environment variable accessors — each value is read once via `LazyLock`.

use std::sync::LazyLock;

use crate::constants;

fn env_or_empty(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

static RUN_ID: LazyLock<String> = LazyLock::new(|| env_or_empty("VM0_RUN_ID"));
static API_URL: LazyLock<String> = LazyLock::new(|| env_or_empty("VM0_API_URL"));
static API_TOKEN: LazyLock<String> = LazyLock::new(|| env_or_empty("VM0_API_TOKEN"));
static PROMPT: LazyLock<String> = LazyLock::new(|| env_or_empty("VM0_PROMPT"));
static APPEND_SYSTEM_PROMPT: LazyLock<String> =
    LazyLock::new(|| env_or_empty("VM0_APPEND_SYSTEM_PROMPT"));
static VERCEL_BYPASS: LazyLock<String> = LazyLock::new(|| env_or_empty("VERCEL_PROTECTION_BYPASS"));
static RESUME_SESSION_ID: LazyLock<String> =
    LazyLock::new(|| env_or_empty("VM0_RESUME_SESSION_ID"));
static API_START_TIME: LazyLock<String> = LazyLock::new(|| env_or_empty("VM0_API_START_TIME"));
static WORKING_DIR: LazyLock<String> = LazyLock::new(|| env_or_empty("VM0_WORKING_DIR"));
static SECRET_VALUES: LazyLock<String> = LazyLock::new(|| env_or_empty("VM0_SECRET_VALUES"));
static DISALLOWED_TOOLS: LazyLock<String> = LazyLock::new(|| env_or_empty("VM0_DISALLOWED_TOOLS"));
static TOOLS: LazyLock<String> = LazyLock::new(|| env_or_empty("VM0_TOOLS"));
static SETTINGS: LazyLock<String> = LazyLock::new(|| env_or_empty("VM0_SETTINGS"));
static FEATURE_FLAGS: LazyLock<String> = LazyLock::new(|| env_or_empty("VM0_FEATURE_FLAGS"));
static USE_MOCK_CLAUDE: LazyLock<bool> = LazyLock::new(|| {
    std::env::var("USE_MOCK_CLAUDE")
        .map(|v| v == "true")
        .unwrap_or(false)
});
/// Workaround for Claude Code bug: WebSearch/WebFetch can hang indefinitely.
/// See: https://github.com/anthropics/claude-code/issues/11650
static STUCK_TOOL_TIMEOUT: LazyLock<u64> = LazyLock::new(|| {
    match std::env::var("VM0_STUCK_TOOL_TIMEOUT_SECS") {
        Ok(v) => match v.parse() {
            Ok(secs) => secs,
            Err(_) => {
                eprintln!(
                    "[WARN] VM0_STUCK_TOOL_TIMEOUT_SECS={v:?} is not a valid u64, using default {}s",
                    constants::STUCK_TOOL_TIMEOUT_SECS
                );
                constants::STUCK_TOOL_TIMEOUT_SECS
            }
        },
        Err(_) => constants::STUCK_TOOL_TIMEOUT_SECS,
    }
});

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

static ARTIFACT_DRIVER: LazyLock<String> = LazyLock::new(|| env_or_empty("VM0_ARTIFACT_DRIVER"));
static ARTIFACT_VERSION_ID: LazyLock<String> =
    LazyLock::new(|| env_or_empty("VM0_ARTIFACT_VERSION_ID"));
static ARTIFACT_MOUNT_PATH: LazyLock<String> =
    LazyLock::new(|| env_or_empty("VM0_ARTIFACT_MOUNT_PATH"));
static ARTIFACT_VOLUME_NAME: LazyLock<String> =
    LazyLock::new(|| env_or_empty("VM0_ARTIFACT_VOLUME_NAME"));

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

static MEMORY_DRIVER: LazyLock<String> = LazyLock::new(|| env_or_empty("VM0_MEMORY_DRIVER"));
static MEMORY_VERSION_ID: LazyLock<String> =
    LazyLock::new(|| env_or_empty("VM0_MEMORY_VERSION_ID"));
static MEMORY_MOUNT_PATH: LazyLock<String> =
    LazyLock::new(|| env_or_empty("VM0_MEMORY_MOUNT_PATH"));
static MEMORY_NAME: LazyLock<String> = LazyLock::new(|| env_or_empty("VM0_MEMORY_NAME"));

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

pub fn run_id() -> &'static str {
    &RUN_ID
}
pub fn api_url() -> &'static str {
    &API_URL
}
pub fn api_token() -> &'static str {
    &API_TOKEN
}
pub fn prompt() -> &'static str {
    &PROMPT
}
pub fn append_system_prompt() -> &'static str {
    &APPEND_SYSTEM_PROMPT
}
pub fn vercel_bypass() -> &'static str {
    &VERCEL_BYPASS
}
pub fn resume_session_id() -> &'static str {
    &RESUME_SESSION_ID
}
pub fn api_start_time() -> &'static str {
    &API_START_TIME
}
pub fn working_dir() -> &'static str {
    &WORKING_DIR
}
pub fn secret_values() -> &'static str {
    &SECRET_VALUES
}
pub fn disallowed_tools() -> &'static str {
    &DISALLOWED_TOOLS
}
pub fn tools() -> &'static str {
    &TOOLS
}
pub fn settings() -> &'static str {
    &SETTINGS
}
pub fn feature_flags() -> &'static str {
    &FEATURE_FLAGS
}
pub fn use_mock_claude() -> bool {
    *USE_MOCK_CLAUDE
}
pub fn artifact_driver() -> &'static str {
    &ARTIFACT_DRIVER
}
pub fn artifact_mount_path() -> &'static str {
    &ARTIFACT_MOUNT_PATH
}
pub fn artifact_volume_name() -> &'static str {
    &ARTIFACT_VOLUME_NAME
}
pub fn artifact_version_id() -> &'static str {
    &ARTIFACT_VERSION_ID
}
pub fn memory_driver() -> &'static str {
    &MEMORY_DRIVER
}
pub fn memory_mount_path() -> &'static str {
    &MEMORY_MOUNT_PATH
}
pub fn memory_name() -> &'static str {
    &MEMORY_NAME
}
pub fn memory_version_id() -> &'static str {
    &MEMORY_VERSION_ID
}
pub fn stuck_tool_timeout_secs() -> u64 {
    *STUCK_TOOL_TIMEOUT
}
/// Whether a backend API is available (token set).
///
/// When false (e.g. local-provider test mode), heartbeat / events / checkpoint
/// are skipped because there is no API server to call.
pub fn has_api() -> bool {
    !API_TOKEN.is_empty()
}
