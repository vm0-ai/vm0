//! Environment variable accessors — each value is read once via `LazyLock`.

use std::sync::LazyLock;

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
static VERCEL_BYPASS: LazyLock<String> = LazyLock::new(|| env_or_empty("VERCEL_PROTECTION_BYPASS"));
static RESUME_SESSION_ID: LazyLock<String> =
    LazyLock::new(|| env_or_empty("VM0_RESUME_SESSION_ID"));
static CLI_AGENT_TYPE: LazyLock<String> = LazyLock::new(|| {
    let v = env_or_empty("CLI_AGENT_TYPE");
    if v.is_empty() {
        "claude-code".to_string()
    } else {
        v
    }
});
static API_START_TIME: LazyLock<String> = LazyLock::new(|| env_or_empty("VM0_API_START_TIME"));
static OPENAI_MODEL: LazyLock<String> = LazyLock::new(|| env_or_empty("OPENAI_MODEL"));
static WORKING_DIR: LazyLock<String> = LazyLock::new(|| env_or_empty("VM0_WORKING_DIR"));
static SECRET_VALUES: LazyLock<String> = LazyLock::new(|| env_or_empty("VM0_SECRET_VALUES"));
static USE_MOCK_CLAUDE: LazyLock<bool> = LazyLock::new(|| {
    std::env::var("USE_MOCK_CLAUDE")
        .map(|v| v == "true")
        .unwrap_or(false)
});

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

static ARTIFACT_DRIVER: LazyLock<String> = LazyLock::new(|| env_or_empty("VM0_ARTIFACT_DRIVER"));
static ARTIFACT_MOUNT_PATH: LazyLock<String> =
    LazyLock::new(|| env_or_empty("VM0_ARTIFACT_MOUNT_PATH"));
static ARTIFACT_VOLUME_NAME: LazyLock<String> =
    LazyLock::new(|| env_or_empty("VM0_ARTIFACT_VOLUME_NAME"));

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
pub fn vercel_bypass() -> &'static str {
    &VERCEL_BYPASS
}
pub fn resume_session_id() -> &'static str {
    &RESUME_SESSION_ID
}
pub fn cli_agent_type() -> &'static str {
    &CLI_AGENT_TYPE
}
pub fn api_start_time() -> &'static str {
    &API_START_TIME
}
pub fn openai_model() -> &'static str {
    &OPENAI_MODEL
}
pub fn working_dir() -> &'static str {
    &WORKING_DIR
}
pub fn secret_values() -> &'static str {
    &SECRET_VALUES
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
