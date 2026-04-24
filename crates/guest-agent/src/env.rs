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
static SANDBOX_ID: LazyLock<String> = LazyLock::new(|| env_or_empty("VM0_SANDBOX_ID"));
static SANDBOX_REUSE_RESULT: LazyLock<String> =
    LazyLock::new(|| env_or_empty("VM0_SANDBOX_REUSE_RESULT"));
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
static USE_MOCK_CLAUDE: LazyLock<bool> = LazyLock::new(|| {
    std::env::var("USE_MOCK_CLAUDE")
        .map(|v| v == "true")
        .unwrap_or(false)
});
/// Production install location for the mock-claude binary. Exposed so
/// tests can assert against a single source of truth when the
/// `VM0_MOCK_CLAUDE_PATH` env override is unset.
pub const DEFAULT_MOCK_CLAUDE_PATH: &str = "/usr/local/bin/guest-mock-claude";

/// Optional override for the mock-claude binary path. Used by
/// integration tests to point at a cargo-built artifact; production
/// runs fall through to `DEFAULT_MOCK_CLAUDE_PATH`.
static MOCK_CLAUDE_PATH: LazyLock<String> = LazyLock::new(|| {
    std::env::var("VM0_MOCK_CLAUDE_PATH").unwrap_or_else(|_| DEFAULT_MOCK_CLAUDE_PATH.to_string())
});
/// Read an optional `u64` env var, falling back to `default` when it's
/// unset or unparseable. Emits a stderr warning on the unparseable case so
/// the mistake is visible in runner logs rather than silently absorbed.
fn u64_env_or(name: &str, default: u64) -> u64 {
    match std::env::var(name) {
        Ok(v) => v.parse().unwrap_or_else(|_| {
            eprintln!("[WARN] {name}={v:?} is not a valid u64, using default {default}s");
            default
        }),
        Err(_) => default,
    }
}

/// Workaround for Claude Code bug: WebSearch/WebFetch can hang indefinitely.
/// See: https://github.com/anthropics/claude-code/issues/11650
static STUCK_TOOL_TIMEOUT: LazyLock<u64> = LazyLock::new(|| {
    u64_env_or(
        "VM0_STUCK_TOOL_TIMEOUT_SECS",
        constants::STUCK_TOOL_TIMEOUT_SECS,
    )
});

/// Grace after `type=result` before SIGTERM-ing the CLI process group.
/// Shortened in integration tests via env override so runs converge
/// within a test-sized window instead of the prod default.
/// See: https://github.com/vm0-ai/vm0/issues/10879
static POST_RESULT_SIGTERM_GRACE: LazyLock<u64> = LazyLock::new(|| {
    u64_env_or(
        "VM0_POST_RESULT_SIGTERM_GRACE_SECS",
        constants::POST_RESULT_SIGTERM_GRACE_SECS,
    )
});

/// Follow-up grace after SIGTERM before escalating to SIGKILL. Same
/// override rationale as `POST_RESULT_SIGTERM_GRACE`.
static POST_RESULT_SIGKILL_GRACE: LazyLock<u64> = LazyLock::new(|| {
    u64_env_or(
        "VM0_POST_RESULT_SIGKILL_GRACE_SECS",
        constants::POST_RESULT_SIGKILL_GRACE_SECS,
    )
});

// ---------------------------------------------------------------------------
// Artifacts (multi-mount)
//
// The runner emits a single `VM0_ARTIFACTS` env var containing a JSON array
// of `{name, mountPath, storageId, versionId}` entries — one per artifact
// mounted at boot. If the env var is unset or empty, there are no artifacts.
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEnv {
    pub name: String,
    pub mount_path: String,
    pub storage_id: String,
    pub version_id: String,
}

/// Parse `VM0_ARTIFACTS`, which the runner writes as a JSON array.
///
/// # Panics
/// Panics if the env var is set but not valid JSON. This indicates a
/// runner/guest-agent version-skew bug and is not user-recoverable;
/// failing loudly is preferable to silently producing a zero-snapshot
/// run that looks successful in dashboards.
#[allow(clippy::expect_used)]
fn load_artifacts() -> Vec<ArtifactEnv> {
    let raw = std::env::var("VM0_ARTIFACTS").unwrap_or_default();
    if raw.is_empty() {
        return Vec::new();
    }
    serde_json::from_str::<Vec<ArtifactEnv>>(&raw)
        .expect("VM0_ARTIFACTS must be a valid JSON array")
}

static ARTIFACTS: LazyLock<Vec<ArtifactEnv>> = LazyLock::new(load_artifacts);

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
pub fn sandbox_id() -> &'static str {
    &SANDBOX_ID
}
pub fn sandbox_reuse_result() -> &'static str {
    &SANDBOX_REUSE_RESULT
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
pub fn use_mock_claude() -> bool {
    *USE_MOCK_CLAUDE
}
pub fn mock_claude_path() -> String {
    MOCK_CLAUDE_PATH.clone()
}
pub fn artifacts() -> &'static [ArtifactEnv] {
    &ARTIFACTS
}
pub fn stuck_tool_timeout_secs() -> u64 {
    *STUCK_TOOL_TIMEOUT
}
pub fn post_result_sigterm_grace_secs() -> u64 {
    *POST_RESULT_SIGTERM_GRACE
}
pub fn post_result_sigkill_grace_secs() -> u64 {
    *POST_RESULT_SIGKILL_GRACE
}
/// Whether a backend API is available (token set).
///
/// When false (e.g. local-provider test mode), heartbeat / events / checkpoint
/// are skipped because there is no API server to call.
pub fn has_api() -> bool {
    !API_TOKEN.is_empty()
}
