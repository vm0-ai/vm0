//! Environment variable accessors — each value is read once via `LazyLock`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;

use crate::constants;
use crate::error::AgentError;
use guest_common::log_warn;

const LOG_TAG: &str = "sandbox:guest-agent";
const USER_ENV_FILE_ENV_KEY: &str = guest_contracts::env::USER_ENV_FILE_ENV;
const USER_ENV_PRIVATE_DIR_NAME: &str = "user-env";
const USER_ENV_FILENAME: &str = "env.json";
const POST_RESULT_CLEANUP_MAX_SECS: u64 = 60 * 60;

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

static FRAMEWORK: LazyLock<Framework> =
    LazyLock::new(|| framework_from_cli_agent_type(cli_agent_type()));

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

static RUN_ID: LazyLock<String> = LazyLock::new(|| env_or_empty(guest_contracts::env::RUN_ID_ENV));
static API_URL: LazyLock<String> =
    LazyLock::new(|| env_or_empty(guest_contracts::env::API_URL_ENV));
static API_TOKEN: LazyLock<String> =
    LazyLock::new(|| env_or_empty(guest_contracts::env::API_TOKEN_ENV));
static SANDBOX_ID: LazyLock<String> =
    LazyLock::new(|| env_or_empty(guest_contracts::env::SANDBOX_ID_ENV));
static SANDBOX_REUSE_RESULT: LazyLock<String> =
    LazyLock::new(|| env_or_empty(guest_contracts::env::SANDBOX_REUSE_RESULT_ENV));
static PROMPT: LazyLock<String> = LazyLock::new(|| env_or_empty(guest_contracts::env::PROMPT_ENV));
static APPEND_SYSTEM_PROMPT: LazyLock<String> =
    LazyLock::new(|| env_or_empty(guest_contracts::env::APPEND_SYSTEM_PROMPT_ENV));
static VERCEL_BYPASS: LazyLock<String> =
    LazyLock::new(|| env_or_empty(guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV));
static RESUME_SESSION_ID: LazyLock<String> =
    LazyLock::new(|| env_or_empty(guest_contracts::env::RESUME_SESSION_ID_ENV));
static API_START_TIME: LazyLock<String> =
    LazyLock::new(|| env_or_empty(guest_contracts::env::API_START_TIME_ENV));
static SECRET_VALUES: LazyLock<String> =
    LazyLock::new(|| env_or_empty(guest_contracts::env::SECRET_VALUES_ENV));
static DISALLOWED_TOOLS: LazyLock<String> =
    LazyLock::new(|| env_or_empty(guest_contracts::env::DISALLOWED_TOOLS_ENV));
static TOOLS: LazyLock<String> = LazyLock::new(|| env_or_empty(guest_contracts::env::TOOLS_ENV));
static SETTINGS: LazyLock<String> =
    LazyLock::new(|| env_or_empty(guest_contracts::env::SETTINGS_ENV));
static USE_MOCK_CLAUDE: LazyLock<bool> =
    LazyLock::new(|| bool_true_env(guest_contracts::env::USE_MOCK_CLAUDE_ENV));
/// Production install location for the mock-claude binary. Exposed so
/// tests can assert against a single source of truth when the
/// `VM0_MOCK_CLAUDE_PATH` env override is unset.
pub const DEFAULT_MOCK_CLAUDE_PATH: &str = "/usr/local/bin/guest-mock-claude";

/// Optional override for the mock-claude binary path. Used by
/// integration tests to point at a cargo-built artifact; production
/// runs fall through to `DEFAULT_MOCK_CLAUDE_PATH`.
static MOCK_CLAUDE_PATH: LazyLock<String> = LazyLock::new(|| {
    std::env::var(guest_contracts::env::MOCK_CLAUDE_PATH_ENV)
        .unwrap_or_else(|_| DEFAULT_MOCK_CLAUDE_PATH.to_string())
});

// ---------------------------------------------------------------------------
// Codex framework env vars
// ---------------------------------------------------------------------------

static CLI_AGENT_TYPE: LazyLock<String> =
    LazyLock::new(|| env_or_empty(guest_contracts::env::CLI_AGENT_TYPE_ENV));
static USER_ENV: LazyLock<Result<HashMap<String, String>, String>> =
    LazyLock::new(load_user_env_from_process);

/// `USE_MOCK_CODEX` accepts both `"true"` and `"1"` (matches the Codex
/// epic's documented invocation shape `USE_MOCK_CODEX=1`). The
/// claude-side `USE_MOCK_CLAUDE` historically only accepts `"true"`;
/// the asymmetry is intentional.
static USE_MOCK_CODEX: LazyLock<bool> =
    LazyLock::new(|| bool_true_or_one_env(guest_contracts::env::USE_MOCK_CODEX_ENV));
static USE_CODEX_APP_SERVER_BACKEND: LazyLock<bool> =
    LazyLock::new(|| bool_true_or_one_env(guest_contracts::env::CODEX_APP_SERVER_BACKEND_ENV));

/// Production install location for the mock-codex binary, mirroring
/// `DEFAULT_MOCK_CLAUDE_PATH`.
pub const DEFAULT_MOCK_CODEX_PATH: &str = "/usr/local/bin/guest-mock-codex";

static MOCK_CODEX_PATH: LazyLock<String> = LazyLock::new(|| {
    std::env::var(guest_contracts::env::MOCK_CODEX_PATH_ENV)
        .unwrap_or_else(|_| DEFAULT_MOCK_CODEX_PATH.to_string())
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
    let process_home = std::env::var("HOME").ok();
    resolve_home_dir(user_env_map(), process_home.as_deref())
        .expect("HOME must be set in guest sandbox (rootfs init contract)")
}

static HOME_DIR: LazyLock<String> = LazyLock::new(load_home_dir);
/// Read an optional `u64` env var, falling back to `default` when it's
/// unset or unparseable. Emits a stderr warning on the unparseable case so
/// the mistake is visible in runner logs rather than silently absorbed.
fn u64_env_or(name: &str, default: u64) -> u64 {
    let value = std::env::var(name).ok();
    u64_value_or(name, value.as_deref(), default)
}

fn u64_value_or(name: &str, value: Option<&str>, default: u64) -> u64 {
    match value {
        Some(v) => v.parse().unwrap_or_else(|_| {
            log_warn!(
                LOG_TAG,
                "{name}={v:?} is not a valid u64, using default {default}s"
            );
            default
        }),
        None => default,
    }
}

/// Read an optional bounded seconds env var as `Duration`, falling back to
/// `default_secs` when unset, unparseable, or outside the supported range.
fn bounded_duration_secs_env_or(name: &str, default_secs: u64, max_secs: u64) -> Duration {
    let value = std::env::var(name).ok();
    bounded_duration_secs_value_or(name, value.as_deref(), default_secs, max_secs)
}

fn bounded_duration_secs_value_or(
    name: &str,
    value: Option<&str>,
    default_secs: u64,
    max_secs: u64,
) -> Duration {
    match value {
        Some(v) => match v.parse::<u64>() {
            Ok(secs) if secs <= max_secs => Duration::from_secs(secs),
            Ok(secs) => {
                log_warn!(
                    LOG_TAG,
                    "{name}={secs}s exceeds maximum {max_secs}s, using default {default_secs}s"
                );
                Duration::from_secs(default_secs)
            }
            Err(_) => {
                log_warn!(
                    LOG_TAG,
                    "{name}={v:?} is not a valid u64, using default {default_secs}s"
                );
                Duration::from_secs(default_secs)
            }
        },
        None => Duration::from_secs(default_secs),
    }
}

/// Workaround for Claude Code bug: WebSearch/WebFetch can hang indefinitely.
/// See: https://github.com/anthropics/claude-code/issues/11650
static STUCK_TOOL_TIMEOUT: LazyLock<u64> = LazyLock::new(|| {
    u64_env_or(
        guest_contracts::env::STUCK_TOOL_TIMEOUT_SECS_ENV,
        constants::STUCK_TOOL_TIMEOUT_SECS,
    )
});

/// Grace after `type=result` before SIGTERM-ing the CLI process group.
/// Shortened in integration tests via env override so runs converge
/// within a test-sized window instead of the prod default.
/// See: https://github.com/vm0-ai/vm0/issues/10879
static POST_RESULT_SIGTERM_GRACE: LazyLock<Duration> = LazyLock::new(|| {
    bounded_duration_secs_env_or(
        guest_contracts::env::POST_RESULT_SIGTERM_GRACE_SECS_ENV,
        constants::POST_RESULT_SIGTERM_GRACE_SECS,
        POST_RESULT_CLEANUP_MAX_SECS,
    )
});

/// Absolute post-result cap. Unlike the quiet grace, this is fixed from the
/// terminal result time and does not refresh on later stdout events.
static POST_RESULT_TOTAL_CAP: LazyLock<Duration> = LazyLock::new(|| {
    bounded_duration_secs_env_or(
        guest_contracts::env::POST_RESULT_TOTAL_CAP_SECS_ENV,
        constants::POST_RESULT_TOTAL_CAP_SECS,
        POST_RESULT_CLEANUP_MAX_SECS,
    )
});

/// Follow-up grace after SIGTERM before escalating to SIGKILL. Same
/// override rationale as `POST_RESULT_SIGTERM_GRACE`.
static POST_RESULT_SIGKILL_GRACE: LazyLock<Duration> = LazyLock::new(|| {
    bounded_duration_secs_env_or(
        guest_contracts::env::POST_RESULT_SIGKILL_GRACE_SECS_ENV,
        constants::POST_RESULT_SIGKILL_GRACE_SECS,
        POST_RESULT_CLEANUP_MAX_SECS,
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

/// Raw startup values used to build an owned guest-agent run config.
///
/// Empty strings represent unset runner bootstrap values, matching the legacy
/// `env::*` facade. Optional override fields preserve the difference between
/// an unset variable and an explicitly empty variable.
#[derive(Clone, Default)]
pub struct GuestConfigRaw {
    pub run_id: String,
    pub api_url: String,
    pub api_token: String,
    pub sandbox_id: String,
    pub sandbox_reuse_result: String,
    pub prompt: String,
    pub append_system_prompt: String,
    pub vercel_bypass: String,
    pub resume_session_id: String,
    pub api_start_time: String,
    pub secret_values: String,
    pub disallowed_tools: String,
    pub tools: String,
    pub settings: String,
    pub use_mock_claude: String,
    pub mock_claude_path: Option<String>,
    pub cli_agent_type: String,
    pub user_env_file: String,
    pub use_mock_codex: String,
    pub use_codex_app_server_backend: String,
    pub mock_codex_path: Option<String>,
    pub home: Option<String>,
    pub guest_runtime_dir: Option<PathBuf>,
    pub artifacts: String,
    pub stuck_tool_timeout_secs: String,
    pub post_result_sigterm_grace_secs: String,
    pub post_result_total_cap_secs: String,
    pub post_result_sigkill_grace_secs: String,
}

impl GuestConfigRaw {
    /// Capture raw startup values from the current process environment.
    pub fn from_process_env() -> Self {
        let guest_runtime_dir =
            std::env::var_os(guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from);

        Self {
            run_id: env_or_empty(guest_contracts::env::RUN_ID_ENV),
            api_url: env_or_empty(guest_contracts::env::API_URL_ENV),
            api_token: env_or_empty(guest_contracts::env::API_TOKEN_ENV),
            sandbox_id: env_or_empty(guest_contracts::env::SANDBOX_ID_ENV),
            sandbox_reuse_result: env_or_empty(guest_contracts::env::SANDBOX_REUSE_RESULT_ENV),
            prompt: env_or_empty(guest_contracts::env::PROMPT_ENV),
            append_system_prompt: env_or_empty(guest_contracts::env::APPEND_SYSTEM_PROMPT_ENV),
            vercel_bypass: env_or_empty(guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV),
            resume_session_id: env_or_empty(guest_contracts::env::RESUME_SESSION_ID_ENV),
            api_start_time: env_or_empty(guest_contracts::env::API_START_TIME_ENV),
            secret_values: env_or_empty(guest_contracts::env::SECRET_VALUES_ENV),
            disallowed_tools: env_or_empty(guest_contracts::env::DISALLOWED_TOOLS_ENV),
            tools: env_or_empty(guest_contracts::env::TOOLS_ENV),
            settings: env_or_empty(guest_contracts::env::SETTINGS_ENV),
            use_mock_claude: env_or_empty(guest_contracts::env::USE_MOCK_CLAUDE_ENV),
            mock_claude_path: std::env::var(guest_contracts::env::MOCK_CLAUDE_PATH_ENV).ok(),
            cli_agent_type: env_or_empty(guest_contracts::env::CLI_AGENT_TYPE_ENV),
            user_env_file: env_or_empty(USER_ENV_FILE_ENV_KEY),
            use_mock_codex: env_or_empty(guest_contracts::env::USE_MOCK_CODEX_ENV),
            use_codex_app_server_backend: env_or_empty(
                guest_contracts::env::CODEX_APP_SERVER_BACKEND_ENV,
            ),
            mock_codex_path: std::env::var(guest_contracts::env::MOCK_CODEX_PATH_ENV).ok(),
            home: std::env::var("HOME").ok(),
            guest_runtime_dir,
            artifacts: env_or_empty(guest_contracts::env::ARTIFACTS_ENV),
            stuck_tool_timeout_secs: env_or_empty(
                guest_contracts::env::STUCK_TOOL_TIMEOUT_SECS_ENV,
            ),
            post_result_sigterm_grace_secs: env_or_empty(
                guest_contracts::env::POST_RESULT_SIGTERM_GRACE_SECS_ENV,
            ),
            post_result_total_cap_secs: env_or_empty(
                guest_contracts::env::POST_RESULT_TOTAL_CAP_SECS_ENV,
            ),
            post_result_sigkill_grace_secs: env_or_empty(
                guest_contracts::env::POST_RESULT_SIGKILL_GRACE_SECS_ENV,
            ),
        }
    }
}

/// Immutable guest-agent startup configuration for a single run.
#[derive(Clone)]
pub struct GuestConfig {
    pub run_id: String,
    pub api_url: String,
    pub api_token: String,
    pub sandbox_id: String,
    pub sandbox_reuse_result: String,
    pub prompt: String,
    pub append_system_prompt: String,
    pub vercel_bypass: String,
    pub resume_session_id: String,
    pub api_start_time: String,
    pub secret_values: String,
    pub disallowed_tools: String,
    pub tools: String,
    pub settings: String,
    pub use_mock_claude: bool,
    pub mock_claude_path: String,
    pub cli_agent_type: String,
    pub framework: Framework,
    pub user_env: HashMap<String, String>,
    pub use_mock_codex: bool,
    pub use_codex_app_server_backend: bool,
    pub mock_codex_path: String,
    pub home_dir: String,
    pub artifacts: Vec<ArtifactEnv>,
    pub stuck_tool_timeout_secs: u64,
    pub post_result_sigterm_grace: Duration,
    pub post_result_total_cap: Duration,
    pub post_result_sigkill_grace: Duration,
}

impl GuestConfig {
    /// Build an owned config from the current process environment.
    pub fn from_process_env() -> Result<Self, String> {
        Self::from_raw(GuestConfigRaw::from_process_env())
    }

    /// Build an owned config from explicit startup values.
    pub fn from_raw(raw: GuestConfigRaw) -> Result<Self, String> {
        let user_env = load_user_env_from_raw(&raw)?;
        let home_dir = resolve_home_dir(&user_env, raw.home.as_deref())?;
        let artifacts = parse_artifacts_value(&raw.artifacts)
            .map_err(|e| format!("parse {} JSON: {e}", guest_contracts::env::ARTIFACTS_ENV))?;

        Ok(Self {
            run_id: raw.run_id,
            api_url: raw.api_url,
            api_token: raw.api_token,
            sandbox_id: raw.sandbox_id,
            sandbox_reuse_result: raw.sandbox_reuse_result,
            prompt: raw.prompt,
            append_system_prompt: raw.append_system_prompt,
            vercel_bypass: raw.vercel_bypass,
            resume_session_id: raw.resume_session_id,
            api_start_time: raw.api_start_time,
            secret_values: raw.secret_values,
            disallowed_tools: raw.disallowed_tools,
            tools: raw.tools,
            settings: raw.settings,
            use_mock_claude: bool_true_value(Some(&raw.use_mock_claude)),
            mock_claude_path: default_mock_path(
                raw.mock_claude_path.as_deref(),
                DEFAULT_MOCK_CLAUDE_PATH,
            ),
            framework: framework_from_cli_agent_type(&raw.cli_agent_type),
            cli_agent_type: raw.cli_agent_type,
            user_env,
            use_mock_codex: bool_true_or_one_value(Some(&raw.use_mock_codex)),
            use_codex_app_server_backend: bool_true_or_one_value(Some(
                &raw.use_codex_app_server_backend,
            )),
            mock_codex_path: default_mock_path(
                raw.mock_codex_path.as_deref(),
                DEFAULT_MOCK_CODEX_PATH,
            ),
            home_dir,
            artifacts,
            stuck_tool_timeout_secs: u64_value_or(
                guest_contracts::env::STUCK_TOOL_TIMEOUT_SECS_ENV,
                non_empty(&raw.stuck_tool_timeout_secs),
                constants::STUCK_TOOL_TIMEOUT_SECS,
            ),
            post_result_sigterm_grace: bounded_duration_secs_value_or(
                guest_contracts::env::POST_RESULT_SIGTERM_GRACE_SECS_ENV,
                non_empty(&raw.post_result_sigterm_grace_secs),
                constants::POST_RESULT_SIGTERM_GRACE_SECS,
                POST_RESULT_CLEANUP_MAX_SECS,
            ),
            post_result_total_cap: bounded_duration_secs_value_or(
                guest_contracts::env::POST_RESULT_TOTAL_CAP_SECS_ENV,
                non_empty(&raw.post_result_total_cap_secs),
                constants::POST_RESULT_TOTAL_CAP_SECS,
                POST_RESULT_CLEANUP_MAX_SECS,
            ),
            post_result_sigkill_grace: bounded_duration_secs_value_or(
                guest_contracts::env::POST_RESULT_SIGKILL_GRACE_SECS_ENV,
                non_empty(&raw.post_result_sigkill_grace_secs),
                constants::POST_RESULT_SIGKILL_GRACE_SECS,
                POST_RESULT_CLEANUP_MAX_SECS,
            ),
        })
    }
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
    let raw = std::env::var(guest_contracts::env::ARTIFACTS_ENV).unwrap_or_default();
    parse_artifacts_value(&raw).expect("VM0_ARTIFACTS must be a valid JSON array")
}

static ARTIFACTS: LazyLock<Vec<ArtifactEnv>> = LazyLock::new(load_artifacts);

fn framework_from_cli_agent_type(value: &str) -> Framework {
    match value {
        "codex" => Framework::Codex,
        "" | "claude-code" => Framework::ClaudeCode,
        other => {
            log_warn!(
                LOG_TAG,
                "Unknown CLI_AGENT_TYPE={other:?}, defaulting to claude-code"
            );
            Framework::ClaudeCode
        }
    }
}

fn non_empty(value: &str) -> Option<&str> {
    if value.is_empty() { None } else { Some(value) }
}

fn bool_true_env(name: &str) -> bool {
    let value = std::env::var(name).ok();
    bool_true_value(value.as_deref())
}

fn bool_true_value(value: Option<&str>) -> bool {
    matches!(value, Some("true"))
}

fn bool_true_or_one_env(name: &str) -> bool {
    let value = std::env::var(name).ok();
    bool_true_or_one_value(value.as_deref())
}

fn bool_true_or_one_value(value: Option<&str>) -> bool {
    matches!(value, Some("true" | "1"))
}

fn default_mock_path(value: Option<&str>, default: &str) -> String {
    value.map_or_else(|| default.to_string(), str::to_string)
}

fn parse_artifacts_value(raw: &str) -> Result<Vec<ArtifactEnv>, serde_json::Error> {
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<ArtifactEnv>>(raw)
}

fn load_user_env_from_process() -> Result<HashMap<String, String>, String> {
    let path = env_or_empty(USER_ENV_FILE_ENV_KEY);
    if path.is_empty() {
        return Ok(HashMap::new());
    }

    let path = Path::new(&path);
    validate_user_env_file_path(path)?;
    load_user_env_from_path(path)
}

fn load_user_env_from_raw(raw: &GuestConfigRaw) -> Result<HashMap<String, String>, String> {
    if raw.user_env_file.is_empty() {
        return Ok(HashMap::new());
    }

    let path = Path::new(&raw.user_env_file);
    let runtime_dir = guest_runtime_dir_for_user_env_values(
        &raw.run_id,
        raw.guest_runtime_dir.as_deref(),
        raw.home.as_deref(),
    )?;
    validate_user_env_file_path_for_runtime(path, &runtime_dir)?;
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
    let run_id = env_or_empty(guest_contracts::env::RUN_ID_ENV);
    guest_runtime_dir_for_user_env_run_id(&run_id)
}

fn guest_runtime_dir_for_user_env_run_id(run_id: &str) -> Result<PathBuf, String> {
    guest_contracts::runtime_paths::validate_run_id(run_id)
        .map_err(|e| format!("resolve guest runtime dir for {USER_ENV_FILE_ENV_KEY}: {e}"))?;
    guest_contracts::runtime_paths::run_dir_from_env(run_id)
        .map_err(|e| format!("resolve guest runtime dir for {USER_ENV_FILE_ENV_KEY}: {e}"))
}

fn guest_runtime_dir_for_user_env_values(
    run_id: &str,
    runtime_dir: Option<&Path>,
    home: Option<&str>,
) -> Result<PathBuf, String> {
    guest_contracts::runtime_paths::validate_run_id(run_id)
        .map_err(|e| format!("resolve guest runtime dir for {USER_ENV_FILE_ENV_KEY}: {e}"))?;

    if let Some(runtime_dir) = runtime_dir {
        if !runtime_dir.is_absolute() {
            return Err(format!(
                "resolve guest runtime dir for {USER_ENV_FILE_ENV_KEY}: {}",
                guest_contracts::runtime_paths::RuntimePathError::InvalidRuntimeDir
            ));
        }
        return Ok(runtime_dir.to_path_buf());
    }

    let Some(home) = home.filter(|value| !value.is_empty()) else {
        return Err(format!(
            "resolve guest runtime dir for {USER_ENV_FILE_ENV_KEY}: {}",
            guest_contracts::runtime_paths::RuntimePathError::MissingHome
        ));
    };

    guest_contracts::runtime_paths::run_dir_for_home(home, run_id)
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
        if !guest_contracts::env::is_shell_identifier_env_key(key) {
            return Err(format!(
                "{USER_ENV_FILE_ENV_KEY} contains invalid env key {:?}",
                guest_contracts::env::sanitize_user_env_key_for_diagnostic(key)
            ));
        }
        if value.contains('\0') {
            return Err(format!(
                "{USER_ENV_FILE_ENV_KEY} contains NUL byte for env key {:?}",
                guest_contracts::env::sanitize_user_env_key_for_diagnostic(key)
            ));
        }
    }

    Ok(())
}

fn resolve_home_dir(
    user_env: &HashMap<String, String>,
    process_home: Option<&str>,
) -> Result<String, String> {
    if let Some(home) = user_env.get("HOME") {
        return Ok(home.clone());
    }
    process_home
        .map(str::to_string)
        .ok_or_else(|| "HOME must be set in guest sandbox (rootfs init contract)".to_string())
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
/// Claude/Codex CLI agent session id from `VM0_RESUME_SESSION_ID`; empty
/// string means a new session.
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
/// Anthropic model from loaded user env; empty string means unset.
pub fn anthropic_model() -> &'static str {
    user_env_value("ANTHROPIC_MODEL")
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
/// Whether the disabled Codex app-server backend is explicitly enabled.
pub fn use_codex_app_server_backend() -> bool {
    *USE_CODEX_APP_SERVER_BACKEND
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
/// Unset, unparseable, or out-of-range values use the compiled default;
/// invalid values also log a warning.
pub fn post_result_sigterm_grace() -> Duration {
    *POST_RESULT_SIGTERM_GRACE
}
/// Absolute cap after `type=result`, from `VM0_POST_RESULT_TOTAL_CAP_SECS`.
///
/// Unset, unparseable, or out-of-range values use the compiled default;
/// invalid values also log a warning.
pub fn post_result_total_cap() -> Duration {
    *POST_RESULT_TOTAL_CAP
}
/// Grace period before SIGKILL after SIGTERM, from
/// `VM0_POST_RESULT_SIGKILL_GRACE_SECS`.
///
/// Unset, unparseable, or out-of-range values use the compiled default;
/// invalid values also log a warning.
pub fn post_result_sigkill_grace() -> Duration {
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

    const TEST_DEFAULT_SECS: u64 = 10;
    const TEST_MAX_SECS: u64 = 60;

    fn raw_config_fixture() -> GuestConfigRaw {
        GuestConfigRaw {
            run_id: "run-123".to_string(),
            home: Some("/home/vm0".to_string()),
            ..GuestConfigRaw::default()
        }
    }

    fn write_user_env_fixture(json: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(USER_ENV_PRIVATE_DIR_NAME);
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join(USER_ENV_FILENAME);
        std::fs::write(&path, json).unwrap();
        (tmp, path)
    }

    #[test]
    fn bounded_duration_secs_value_defaults_when_unset() {
        assert_eq!(
            bounded_duration_secs_value_or("TEST_TIMEOUT", None, TEST_DEFAULT_SECS, TEST_MAX_SECS),
            Duration::from_secs(TEST_DEFAULT_SECS)
        );
    }

    #[test]
    fn bounded_duration_secs_value_defaults_when_invalid() {
        assert_eq!(
            bounded_duration_secs_value_or(
                "TEST_TIMEOUT",
                Some("not-a-number"),
                TEST_DEFAULT_SECS,
                TEST_MAX_SECS,
            ),
            Duration::from_secs(TEST_DEFAULT_SECS)
        );
    }

    #[test]
    fn bounded_duration_secs_value_defaults_when_above_max() {
        assert_eq!(
            bounded_duration_secs_value_or(
                "TEST_TIMEOUT",
                Some("61"),
                TEST_DEFAULT_SECS,
                TEST_MAX_SECS,
            ),
            Duration::from_secs(TEST_DEFAULT_SECS)
        );
    }

    #[test]
    fn bounded_duration_secs_value_accepts_zero() {
        assert_eq!(
            bounded_duration_secs_value_or(
                "TEST_TIMEOUT",
                Some("0"),
                TEST_DEFAULT_SECS,
                TEST_MAX_SECS,
            ),
            Duration::ZERO
        );
    }

    #[test]
    fn bounded_duration_secs_value_accepts_value_at_max() {
        assert_eq!(
            bounded_duration_secs_value_or(
                "TEST_TIMEOUT",
                Some("60"),
                TEST_DEFAULT_SECS,
                TEST_MAX_SECS,
            ),
            Duration::from_secs(TEST_MAX_SECS)
        );
    }

    #[test]
    fn framework_from_cli_agent_type_accepts_known_values_and_defaults_unknown() {
        assert_eq!(framework_from_cli_agent_type(""), Framework::ClaudeCode);
        assert_eq!(
            framework_from_cli_agent_type("claude-code"),
            Framework::ClaudeCode
        );
        assert_eq!(framework_from_cli_agent_type("codex"), Framework::Codex);
        assert_eq!(
            framework_from_cli_agent_type("unexpected"),
            Framework::ClaudeCode
        );
    }

    #[test]
    fn guest_config_from_raw_builds_owned_config_without_process_env_mutation() {
        let raw = GuestConfigRaw {
            api_url: "https://api.example.test".to_string(),
            api_token: String::new(),
            sandbox_id: "sandbox-1".to_string(),
            sandbox_reuse_result: "reused".to_string(),
            prompt: "hello".to_string(),
            append_system_prompt: "extra system".to_string(),
            vercel_bypass: "bypass".to_string(),
            resume_session_id: "session-1".to_string(),
            api_start_time: "123".to_string(),
            secret_values: "encoded-secret".to_string(),
            disallowed_tools: "WebFetch".to_string(),
            tools: "Bash".to_string(),
            settings: "{}".to_string(),
            use_mock_claude: "true".to_string(),
            cli_agent_type: "codex".to_string(),
            use_mock_codex: "1".to_string(),
            use_codex_app_server_backend: "true".to_string(),
            artifacts:
                r#"[{"name":"artifact","mountPath":"/mnt/a","storageId":"storage","versionId":"v1"}]"#
                    .to_string(),
            stuck_tool_timeout_secs: "7".to_string(),
            post_result_sigterm_grace_secs: "8".to_string(),
            post_result_total_cap_secs: "9".to_string(),
            post_result_sigkill_grace_secs: "10".to_string(),
            ..raw_config_fixture()
        };

        let config = GuestConfig::from_raw(raw).unwrap();

        assert_eq!(config.run_id, "run-123");
        assert_eq!(config.api_url, "https://api.example.test");
        assert_eq!(config.api_token, "");
        assert_eq!(config.sandbox_id, "sandbox-1");
        assert_eq!(config.sandbox_reuse_result, "reused");
        assert_eq!(config.prompt, "hello");
        assert_eq!(config.append_system_prompt, "extra system");
        assert_eq!(config.vercel_bypass, "bypass");
        assert_eq!(config.resume_session_id, "session-1");
        assert_eq!(config.api_start_time, "123");
        assert_eq!(config.secret_values, "encoded-secret");
        assert_eq!(config.disallowed_tools, "WebFetch");
        assert_eq!(config.tools, "Bash");
        assert_eq!(config.settings, "{}");
        assert!(config.use_mock_claude);
        assert_eq!(config.mock_claude_path, DEFAULT_MOCK_CLAUDE_PATH);
        assert_eq!(config.cli_agent_type, "codex");
        assert_eq!(config.framework, Framework::Codex);
        assert!(config.use_mock_codex);
        assert!(config.use_codex_app_server_backend);
        assert_eq!(config.mock_codex_path, DEFAULT_MOCK_CODEX_PATH);
        assert_eq!(config.home_dir, "/home/vm0");
        assert_eq!(config.stuck_tool_timeout_secs, 7);
        assert_eq!(config.post_result_sigterm_grace, Duration::from_secs(8));
        assert_eq!(config.post_result_total_cap, Duration::from_secs(9));
        assert_eq!(config.post_result_sigkill_grace, Duration::from_secs(10));
        let artifact = config.artifacts.first().unwrap();
        assert_eq!(artifact.name, "artifact");
        assert_eq!(artifact.mount_path, "/mnt/a");
        assert_eq!(artifact.storage_id, "storage");
        assert_eq!(artifact.version_id, "v1");
    }

    #[test]
    fn guest_config_from_raw_loads_user_env_and_removes_private_file() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_dir = tmp.path().join("runtime");
        let user_env_dir = runtime_dir.join(USER_ENV_PRIVATE_DIR_NAME);
        std::fs::create_dir_all(&user_env_dir).unwrap();
        let user_env_path = user_env_dir.join(USER_ENV_FILENAME);
        std::fs::write(
            &user_env_path,
            r#"{"HOME":"/home/from-user-env","OPENAI_MODEL":"gpt-test"}"#,
        )
        .unwrap();

        let raw = GuestConfigRaw {
            user_env_file: user_env_path.to_string_lossy().into_owned(),
            guest_runtime_dir: Some(runtime_dir),
            home: Some("/home/from-process".to_string()),
            ..raw_config_fixture()
        };

        let config = GuestConfig::from_raw(raw).unwrap();

        assert_eq!(config.home_dir, "/home/from-user-env");
        assert_eq!(
            config.user_env.get("OPENAI_MODEL").map(String::as_str),
            Some("gpt-test")
        );
        assert!(!user_env_path.exists());
        assert!(!user_env_dir.exists());
    }

    #[test]
    fn guest_config_from_raw_preserves_empty_process_home() {
        let raw = GuestConfigRaw {
            home: Some(String::new()),
            ..raw_config_fixture()
        };

        let config = GuestConfig::from_raw(raw).unwrap();

        assert_eq!(config.home_dir, "");
    }

    #[test]
    fn guest_config_from_raw_preserves_explicit_empty_mock_paths() {
        let raw = GuestConfigRaw {
            mock_claude_path: Some(String::new()),
            mock_codex_path: Some(String::new()),
            ..raw_config_fixture()
        };

        let config = GuestConfig::from_raw(raw).unwrap();

        assert_eq!(config.mock_claude_path, "");
        assert_eq!(config.mock_codex_path, "");
    }

    #[test]
    fn guest_config_from_raw_reports_invalid_artifacts() {
        let raw = GuestConfigRaw {
            artifacts: "{not-json".to_string(),
            ..raw_config_fixture()
        };

        let err = GuestConfig::from_raw(raw).err().unwrap();

        assert!(err.contains(guest_contracts::env::ARTIFACTS_ENV));
    }

    #[test]
    fn guest_config_from_raw_rejects_user_env_outside_runtime_dir_without_path_leak() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_dir = tmp.path().join("runtime");
        let unexpected = tmp.path().join("other").join("user-env").join("env.json");

        let raw = GuestConfigRaw {
            user_env_file: unexpected.to_string_lossy().into_owned(),
            guest_runtime_dir: Some(runtime_dir),
            ..raw_config_fixture()
        };

        let err = GuestConfig::from_raw(raw).err().unwrap();

        assert!(err.contains("user-env/env.json"));
        assert!(!err.contains(unexpected.to_string_lossy().as_ref()));
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
