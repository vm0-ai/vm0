//! Environment variable accessors — each value is read once via `LazyLock`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;

use crate::constants;
use crate::error::AgentError;
use guest_common::log_warn;

const LOG_TAG: &str = "sandbox:guest-agent";
const USER_ENV_FILE_ENV_KEY: &str = "VM0_USER_ENV_FILE";
const USER_ENV_PRIVATE_DIR_NAME: &str = "user-env";
const USER_ENV_FILENAME: &str = "env.json";
const ENV_KEY_DIAGNOSTIC_MAX_CHARS: usize = 128;

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

    /// Stable CLI agent type string used in runner/web contracts and logs.
    pub fn agent_type(self) -> &'static str {
        match self {
            Framework::ClaudeCode => "claude-code",
            Framework::Codex => "codex",
        }
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
static USER_ENV: LazyLock<Result<HashMap<String, String>, String>> =
    LazyLock::new(load_user_env_from_process);

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

/// `$HOME` is always set in the guest sandbox (rootfs init guarantees it),
/// unless the loaded user env intentionally overrides it for the CLI child.
/// If neither source sets it, the rootfs is misconfigured and we want a loud,
/// visible failure rather than papering over it with a magic path that would
/// silently land session/auth state in the wrong directory.
///
/// # Panics
/// Panics if `HOME` is unset in both loaded user env and the guest process env.
/// This indicates a rootfs/runner contract violation and is not
/// user-recoverable; the same fail-fast policy as `load_artifacts`
/// (`VM0_ARTIFACTS`).
#[allow(clippy::expect_used)]
fn load_home_dir() -> String {
    if let Some(home) = user_env_map().get("HOME") {
        return home.clone();
    }
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
// of `{name, mountPath, storageId, versionId, missingRootPolicy?}` entries —
// one per artifact mounted at boot. If the env var is unset or empty, there
// are no artifacts.
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
    /// Optional internal checkpoint policy. Absence means strict failure on a
    /// missing or unreadable artifact root.
    #[serde(default)]
    pub missing_root_policy: Option<ArtifactEntryMissingRootPolicy>,
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

fn load_user_env_from_process() -> Result<HashMap<String, String>, String> {
    let path = env_or_empty(USER_ENV_FILE_ENV_KEY);
    if path.is_empty() {
        return Ok(HashMap::new());
    }

    let path = Path::new(&path);
    validate_user_env_file_path(path)?;
    load_user_env_from_path(path)
}

fn load_user_env_from_path(path: &Path) -> Result<HashMap<String, String>, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("read {USER_ENV_FILE_ENV_KEY} {}: {e}", path.display()))?;
    remove_user_env_file(path)?;

    let user_env: HashMap<String, String> = serde_json::from_str(&raw)
        .map_err(|e| format!("parse {USER_ENV_FILE_ENV_KEY} JSON: {e}"))?;
    validate_user_env(&user_env)?;

    Ok(user_env)
}

fn remove_user_env_file(path: &Path) -> Result<(), String> {
    std::fs::remove_file(path)
        .map_err(|e| format!("remove {USER_ENV_FILE_ENV_KEY} {}: {e}", path.display()))?;
    if let Some(parent) = path.parent()
        && is_user_env_private_dir(parent)
    {
        std::fs::remove_dir(parent).map_err(|e| {
            format!(
                "remove {USER_ENV_FILE_ENV_KEY} parent {}: {e}",
                parent.display()
            )
        })?;
    }

    Ok(())
}

fn is_user_env_private_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == USER_ENV_PRIVATE_DIR_NAME)
}

fn validate_user_env_file_path(path: &Path) -> Result<(), String> {
    let runtime_dir = guest_runtime_dir_for_user_env()?;
    validate_user_env_file_path_for_runtime(path, &runtime_dir)
}

fn guest_runtime_dir_for_user_env() -> Result<PathBuf, String> {
    let run_id = env_or_empty("VM0_RUN_ID");
    guest_runtime_dir_for_user_env_run_id(&run_id)
}

fn guest_runtime_dir_for_user_env_run_id(run_id: &str) -> Result<PathBuf, String> {
    guest_runtime_paths::validate_run_id(run_id)
        .map_err(|e| format!("resolve guest runtime dir for {USER_ENV_FILE_ENV_KEY}: {e}"))?;
    guest_runtime_paths::run_dir_from_env(run_id)
        .map_err(|e| format!("resolve guest runtime dir for {USER_ENV_FILE_ENV_KEY}: {e}"))
}

fn user_env_file_path_for_runtime(runtime_dir: &Path) -> PathBuf {
    runtime_dir
        .join(USER_ENV_PRIVATE_DIR_NAME)
        .join(USER_ENV_FILENAME)
}

fn validate_user_env_file_path_for_runtime(path: &Path, runtime_dir: &Path) -> Result<(), String> {
    if path == user_env_file_path_for_runtime(runtime_dir) {
        return Ok(());
    }

    Err(format!(
        "{USER_ENV_FILE_ENV_KEY} must point to guest runtime {USER_ENV_PRIVATE_DIR_NAME}/{USER_ENV_FILENAME}"
    ))
}

fn validate_user_env(user_env: &HashMap<String, String>) -> Result<(), String> {
    let mut entries: Vec<(&String, &String)> = user_env.iter().collect();
    entries.sort_by_key(|(key, _)| *key);

    for (key, value) in entries {
        if !is_valid_env_key(key) {
            return Err(format!(
                "{USER_ENV_FILE_ENV_KEY} contains invalid env key {:?}",
                sanitize_env_key_for_diagnostic(key)
            ));
        }
        if value.contains('\0') {
            return Err(format!(
                "{USER_ENV_FILE_ENV_KEY} contains NUL byte for env key {:?}",
                sanitize_env_key_for_diagnostic(key)
            ));
        }
    }

    Ok(())
}

fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn sanitize_env_key_for_diagnostic(key: &str) -> String {
    let mut chars = key.escape_debug();
    let mut truncated = String::new();
    for _ in 0..ENV_KEY_DIAGNOSTIC_MAX_CHARS {
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

#[allow(clippy::panic)] // Entry points must call init_user_env; bypassing it is a code bug.
fn user_env_map() -> &'static HashMap<String, String> {
    match &*USER_ENV {
        Ok(user_env) => user_env,
        Err(message) => {
            panic!("{USER_ENV_FILE_ENV_KEY} failed to load before accessor use: {message}")
        }
    }
}

fn user_env_value(name: &str) -> &'static str {
    user_env_map().get(name).map(String::as_str).unwrap_or("")
}

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

/// Runner-provided run id from `VM0_RUN_ID`; empty string means unset.
pub fn run_id() -> &'static str {
    &RUN_ID
}
/// Backend API base URL from `VM0_API_URL`; empty string means unset.
pub fn api_url() -> &'static str {
    &API_URL
}
/// Backend API bearer token from `VM0_API_TOKEN`; empty string means no API.
pub fn api_token() -> &'static str {
    &API_TOKEN
}
/// Sandbox id from `VM0_SANDBOX_ID`; empty string means unset.
pub fn sandbox_id() -> &'static str {
    &SANDBOX_ID
}
/// Sandbox reuse result from `VM0_SANDBOX_REUSE_RESULT`; empty string means unset.
pub fn sandbox_reuse_result() -> &'static str {
    &SANDBOX_REUSE_RESULT
}
/// User prompt from `VM0_PROMPT`; empty string means unset.
pub fn prompt() -> &'static str {
    &PROMPT
}
/// Additional system prompt text from `VM0_APPEND_SYSTEM_PROMPT`; empty string
/// means unset.
pub fn append_system_prompt() -> &'static str {
    &APPEND_SYSTEM_PROMPT
}
/// Vercel protection bypass secret from `VERCEL_PROTECTION_BYPASS`; empty
/// string means unset.
pub fn vercel_bypass() -> &'static str {
    &VERCEL_BYPASS
}
/// Claude/Codex resume session id from `VM0_RESUME_SESSION_ID`; empty string
/// means a new session.
pub fn resume_session_id() -> &'static str {
    &RESUME_SESSION_ID
}
/// Runner-provided Unix epoch millisecond API start timestamp from
/// `VM0_API_START_TIME`; empty string means unset.
pub fn api_start_time() -> &'static str {
    &API_START_TIME
}
/// Encoded secret values from `VM0_SECRET_VALUES`; empty string means no secrets.
pub fn secret_values() -> &'static str {
    &SECRET_VALUES
}
/// Raw disallowed tool list from `VM0_DISALLOWED_TOOLS`; empty string means no
/// explicit deny list.
pub fn disallowed_tools() -> &'static str {
    &DISALLOWED_TOOLS
}
/// Raw allowed tool list from `VM0_TOOLS`; empty string means no explicit allow list.
pub fn tools() -> &'static str {
    &TOOLS
}
/// Raw CLI settings payload from `VM0_SETTINGS`; empty string means no settings
/// override.
pub fn settings() -> &'static str {
    &SETTINGS
}
/// Load and validate the runner-provided user env payload once at startup.
pub fn init_user_env() -> Result<(), AgentError> {
    match &*USER_ENV {
        Ok(_) => Ok(()),
        Err(message) => Err(AgentError::Execution(message.clone())),
    }
}
/// User/model/connector environment loaded from `VM0_USER_ENV_FILE`.
pub fn user_env() -> &'static HashMap<String, String> {
    user_env_map()
}
/// Whether `USE_MOCK_CLAUDE` is exactly `"true"`; unset or any other value is
/// false.
pub fn use_mock_claude() -> bool {
    *USE_MOCK_CLAUDE
}
/// Mock Claude binary path from `VM0_MOCK_CLAUDE_PATH`, or
/// `DEFAULT_MOCK_CLAUDE_PATH` when unset.
pub fn mock_claude_path() -> String {
    MOCK_CLAUDE_PATH.clone()
}
/// Raw CLI framework selector from `CLI_AGENT_TYPE`; empty string means unset.
pub fn cli_agent_type() -> &'static str {
    &CLI_AGENT_TYPE
}
/// OpenAI API key from loaded user env; empty string means unset.
pub fn openai_api_key() -> &'static str {
    user_env_value("OPENAI_API_KEY")
}
/// OpenAI model from loaded user env; empty string means unset.
pub fn openai_model() -> &'static str {
    user_env_value("OPENAI_MODEL")
}
/// ChatGPT workspace account id from loaded user env; empty string
/// means unset. Presence is the signal that the sandbox is running in
/// codex-oauth mode (see `is_codex_oauth_mode`); the value itself is
/// not consumed by the guest-agent — the firewall replaces the
/// placeholder bytes in `auth.json` on egress.
pub fn chatgpt_account_id() -> &'static str {
    user_env_value("CHATGPT_ACCOUNT_ID")
}
/// Whether the sandbox should bootstrap codex into codex-oauth mode
/// instead of the API-key path. True iff `CHATGPT_ACCOUNT_ID` is set.
pub fn is_codex_oauth_mode() -> bool {
    !chatgpt_account_id().is_empty()
}
/// Whether `USE_MOCK_CODEX` is `"true"` or `"1"`; unset or any other value is
/// false.
pub fn use_mock_codex() -> bool {
    *USE_MOCK_CODEX
}
/// Mock Codex binary path from `VM0_MOCK_CODEX_PATH`, or
/// `DEFAULT_MOCK_CODEX_PATH` when unset.
pub fn mock_codex_path() -> String {
    MOCK_CODEX_PATH.clone()
}
/// Guest home directory from loaded user env `HOME`, or process `HOME`.
///
/// # Panics
/// Panics if `HOME` is unset in both sources, which indicates a rootfs/runner
/// contract violation.
pub fn home_dir() -> &'static str {
    &HOME_DIR
}
/// Artifact mounts parsed from `VM0_ARTIFACTS`.
///
/// Unset or empty `VM0_ARTIFACTS` returns an empty slice.
///
/// # Panics
/// Panics if `VM0_ARTIFACTS` is set but is not a valid JSON array.
pub fn artifacts() -> &'static [ArtifactEnv] {
    &ARTIFACTS
}
/// Stuck tool timeout in seconds from `VM0_STUCK_TOOL_TIMEOUT_SECS`.
///
/// Unset or unparseable values use the compiled default; unparseable values
/// also log a warning.
pub fn stuck_tool_timeout_secs() -> u64 {
    *STUCK_TOOL_TIMEOUT
}
/// Grace period before SIGTERM after `type=result`, from
/// `VM0_POST_RESULT_SIGTERM_GRACE_SECS`.
///
/// Unset or unparseable values use the compiled default; unparseable values
/// also log a warning.
pub fn post_result_sigterm_grace_secs() -> u64 {
    *POST_RESULT_SIGTERM_GRACE
}
/// Grace period before SIGKILL after SIGTERM, from
/// `VM0_POST_RESULT_SIGKILL_GRACE_SECS`.
///
/// Unset or unparseable values use the compiled default; unparseable values
/// also log a warning.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn write_user_env_fixture(json: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(USER_ENV_PRIVATE_DIR_NAME);
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join(USER_ENV_FILENAME);
        std::fs::write(&path, json).unwrap();
        (tmp, path)
    }

    #[test]
    fn load_user_env_from_path_loads_provider_values_and_removes_file() {
        let (_tmp, path) = write_user_env_fixture(
            r#"{"OPENAI_API_KEY":"sk-test","OPENAI_MODEL":"gpt-test","CHATGPT_ACCOUNT_ID":"acct"}"#,
        );
        let parent = path.parent().unwrap().to_path_buf();

        let user_env = load_user_env_from_path(&path).unwrap();

        assert_eq!(user_env.get("OPENAI_API_KEY").unwrap(), "sk-test");
        assert_eq!(user_env.get("OPENAI_MODEL").unwrap(), "gpt-test");
        assert_eq!(user_env.get("CHATGPT_ACCOUNT_ID").unwrap(), "acct");
        assert!(!path.exists());
        assert!(!parent.exists());
    }

    #[test]
    fn load_user_env_from_path_rejects_invalid_key_without_value_leak() {
        let (_tmp, path) =
            write_user_env_fixture(r#"{"BAD-KEY":"secret-value","OPENAI_API_KEY":"sk-test"}"#);
        let parent = path.parent().unwrap().to_path_buf();

        let err = load_user_env_from_path(&path).unwrap_err();

        assert!(err.contains("BAD-KEY"));
        assert!(!err.contains("secret-value"));
        assert!(!err.contains("sk-test"));
        assert!(!path.exists());
        assert!(!parent.exists());
    }

    #[test]
    fn load_user_env_from_path_removes_file_before_parse_error() {
        let (_tmp, path) = write_user_env_fixture(r#"{"OPENAI_API_KEY":"sk-test""#);
        let parent = path.parent().unwrap().to_path_buf();

        let err = load_user_env_from_path(&path).unwrap_err();

        assert!(err.contains("parse"));
        assert!(!err.contains("sk-test"));
        assert!(!path.exists());
        assert!(!parent.exists());
    }

    #[test]
    fn load_user_env_from_path_keeps_unexpected_parent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("unexpected-user-env-dir");
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("env.json");
        std::fs::write(&path, r#"{"OPENAI_MODEL":"gpt-test"}"#).unwrap();

        let user_env = load_user_env_from_path(&path).unwrap();

        assert_eq!(user_env.get("OPENAI_MODEL").unwrap(), "gpt-test");
        assert!(!path.exists());
        assert!(dir.exists());
    }

    #[test]
    fn validate_user_env_file_path_rejects_unexpected_path() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_dir = tmp.path().join("runtime");
        let unexpected = tmp.path().join("other").join("user-env").join("env.json");

        let err = validate_user_env_file_path_for_runtime(&unexpected, &runtime_dir).unwrap_err();

        assert!(err.contains("user-env/env.json"));
        assert!(!err.contains(unexpected.to_string_lossy().as_ref()));
        assert!(
            validate_user_env_file_path_for_runtime(
                &user_env_file_path_for_runtime(&runtime_dir),
                &runtime_dir,
            )
            .is_ok()
        );
    }

    #[test]
    fn guest_runtime_dir_for_user_env_returns_error_when_run_id_missing() {
        let err = guest_runtime_dir_for_user_env_run_id("").unwrap_err();

        assert!(err.contains("VM0_RUN_ID is required"));
    }

    #[test]
    fn load_user_env_from_path_rejects_nul_value_without_value_leak() {
        let (_tmp, path) = write_user_env_fixture("{\"OPENAI_API_KEY\":\"sk-test\\u0000secret\"}");
        let parent = path.parent().unwrap().to_path_buf();

        let err = load_user_env_from_path(&path).unwrap_err();

        assert!(err.contains("OPENAI_API_KEY"));
        assert!(!err.contains("sk-test"));
        assert!(!err.contains("secret"));
        assert!(!path.exists());
        assert!(!parent.exists());
    }
}
