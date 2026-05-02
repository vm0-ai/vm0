//! Environment variable accessors — each value is read once via `LazyLock`.

use std::sync::LazyLock;

use crate::constants;
use guest_common::log_warn;

const LOG_TAG: &str = "sandbox:guest-agent";

fn env_or_empty(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

/// CLI framework dispatched by the runner via `CLI_AGENT_TYPE`. Unknown
/// values fall back to `ClaudeCode` so a misconfigured runner can't
/// crash the guest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Framework {
    ClaudeCode,
    Codex,
}

impl Framework {
    /// Resolve the framework once and cache it. Subsequent calls are a
    /// `LazyLock` deref — no repeat env reads, no repeat warning logs,
    /// and a single source of truth if a third framework is added later.
    pub fn from_env() -> Self {
        *FRAMEWORK
    }
}

static FRAMEWORK: LazyLock<Framework> = LazyLock::new(|| match cli_agent_type() {
    "codex" => Framework::Codex,
    "" | "claude-code" => Framework::ClaudeCode,
    other => {
        log_warn!(
            LOG_TAG,
            "Unknown CLI_AGENT_TYPE={other:?}, defaulting to claude-code"
        );
        Framework::ClaudeCode
    }
});

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

// ---------------------------------------------------------------------------
// Codex framework env vars
// ---------------------------------------------------------------------------

static CLI_AGENT_TYPE: LazyLock<String> = LazyLock::new(|| env_or_empty("CLI_AGENT_TYPE"));
static OPENAI_API_KEY: LazyLock<String> = LazyLock::new(|| env_or_empty("OPENAI_API_KEY"));
static OPENAI_MODEL: LazyLock<String> = LazyLock::new(|| env_or_empty("OPENAI_MODEL"));

/// `USE_MOCK_CODEX` accepts both `"true"` and `"1"` (matches the Codex
/// epic's documented invocation shape `USE_MOCK_CODEX=1`). The
/// claude-side `USE_MOCK_CLAUDE` historically only accepts `"true"`;
/// the asymmetry is intentional.
static USE_MOCK_CODEX: LazyLock<bool> = LazyLock::new(|| {
    std::env::var("USE_MOCK_CODEX")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false)
});

/// Production install location for the mock-codex binary, mirroring
/// `DEFAULT_MOCK_CLAUDE_PATH`.
pub const DEFAULT_MOCK_CODEX_PATH: &str = "/usr/local/bin/guest-mock-codex";

static MOCK_CODEX_PATH: LazyLock<String> = LazyLock::new(|| {
    std::env::var("VM0_MOCK_CODEX_PATH").unwrap_or_else(|_| DEFAULT_MOCK_CODEX_PATH.to_string())
});

/// `$HOME` is always set in the guest sandbox (rootfs init guarantees it).
/// If it isn't, the rootfs is misconfigured and we want a loud, visible
/// failure rather than papering over it with a magic path that would
/// silently land codex auth state in the wrong directory.
///
/// # Panics
/// Panics if `HOME` is unset. This indicates a rootfs/runner contract
/// violation and is not user-recoverable; the same fail-fast policy as
/// `load_artifacts` (`VM0_ARTIFACTS`).
#[allow(clippy::expect_used)]
fn load_home_dir() -> String {
    std::env::var("HOME").expect("HOME must be set in guest sandbox (rootfs init contract)")
}

static HOME_DIR: LazyLock<String> = LazyLock::new(load_home_dir);
/// Read an optional `u64` env var, falling back to `default` when it's
/// unset or unparseable. Emits a stderr warning on the unparseable case so
/// the mistake is visible in runner logs rather than silently absorbed.
fn u64_env_or(name: &str, default: u64) -> u64 {
    match std::env::var(name) {
        Ok(v) => v.parse().unwrap_or_else(|_| {
            log_warn!(
                LOG_TAG,
                "{name}={v:?} is not a valid u64, using default {default}s"
            );
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

/// One artifact mount described by the runner-provided `VM0_ARTIFACTS` JSON array.
///
/// The environment value is encoded as camelCase JSON, so this struct expects
/// `mountPath`, `storageId`, and `versionId` keys at the guest-agent boundary.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEnv {
    /// VAS storage name for the mounted artifact. This is also the artifact
    /// name reported in checkpoint snapshot payloads.
    pub name: String,
    /// Absolute path inside the guest where the artifact archive was mounted
    /// and where the guest-agent walks files during checkpointing.
    pub mount_path: String,
    /// VAS storage id used when recomputing the mounted artifact's content hash.
    pub storage_id: String,
    /// VAS version id mounted at startup. This is the expected content hash used
    /// to skip unchanged snapshots and the parent version for new snapshots.
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
pub fn cli_agent_type() -> &'static str {
    &CLI_AGENT_TYPE
}
pub fn openai_api_key() -> &'static str {
    &OPENAI_API_KEY
}
pub fn openai_model() -> &'static str {
    &OPENAI_MODEL
}
pub fn use_mock_codex() -> bool {
    *USE_MOCK_CODEX
}
pub fn mock_codex_path() -> String {
    MOCK_CODEX_PATH.clone()
}
pub fn home_dir() -> &'static str {
    &HOME_DIR
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
