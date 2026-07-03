//! Guest-agent startup configuration parsed from environment snapshots.
//!
//! `GuestConfigRaw::from_process_env` is the only process-env capture boundary
//! in this module. After startup, callers should pass an owned [`GuestConfig`]
//! instead of rereading process globals through run-scoped facade functions.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;

use crate::constants;
use guest_common::log_warn;

const LOG_TAG: &str = "sandbox:guest-agent";
const USER_ENV_FILE_ENV_KEY: &str = guest_contracts::env::USER_ENV_FILE_ENV;
const RUN_PAYLOAD_FILE_ENV_KEY: &str = guest_contracts::env::RUN_PAYLOAD_FILE_ENV;
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
    /// Stable CLI agent type string used in runner/web contracts and logs.
    pub fn agent_type(self) -> &'static str {
        match self {
            Framework::ClaudeCode => "claude-code",
            Framework::Codex => "codex",
        }
    }
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/// Production install location for the mock-claude binary. Exposed so
/// tests can assert against a single source of truth when the
/// `VM0_MOCK_CLAUDE_PATH` env override is unset.
pub const DEFAULT_MOCK_CLAUDE_PATH: &str = "/usr/local/bin/guest-mock-claude";

/// Production install location for the mock-codex binary, mirroring
/// `DEFAULT_MOCK_CLAUDE_PATH`.
pub const DEFAULT_MOCK_CODEX_PATH: &str = "/usr/local/bin/guest-mock-codex";

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

// ---------------------------------------------------------------------------
// Artifacts (multi-mount)
//
// The runner supplies a JSON array of
// `{name, mountPath, storageId, versionId, missingRootPolicy?}` entries through
// the run payload. If the value is unset or empty, there are no artifacts.
// ---------------------------------------------------------------------------

/// One artifact mount described by the runner-provided artifact JSON array.
///
/// The wire value is encoded as camelCase JSON, so this struct expects
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
/// Empty strings represent unset runner bootstrap values. Optional override
/// fields preserve the difference between an unset variable and an explicitly
/// empty variable.
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
    pub run_payload_file: String,
    pub use_mock_codex: String,
    pub use_codex_app_server_backend: String,
    pub mock_codex_path: Option<String>,
    pub home: Option<String>,
    pub runtime_home: Option<PathBuf>,
    pub guest_runtime_dir: Option<PathBuf>,
    pub artifacts: String,
    pub feature_flags: String,
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
            prompt: String::new(),
            append_system_prompt: String::new(),
            vercel_bypass: env_or_empty(guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV),
            resume_session_id: env_or_empty(guest_contracts::env::RESUME_SESSION_ID_ENV),
            api_start_time: env_or_empty(guest_contracts::env::API_START_TIME_ENV),
            secret_values: String::new(),
            disallowed_tools: String::new(),
            tools: String::new(),
            settings: String::new(),
            use_mock_claude: env_or_empty(guest_contracts::env::USE_MOCK_CLAUDE_ENV),
            mock_claude_path: std::env::var(guest_contracts::env::MOCK_CLAUDE_PATH_ENV).ok(),
            cli_agent_type: env_or_empty(guest_contracts::env::CLI_AGENT_TYPE_ENV),
            user_env_file: env_or_empty(USER_ENV_FILE_ENV_KEY),
            run_payload_file: env_or_empty(RUN_PAYLOAD_FILE_ENV_KEY),
            use_mock_codex: env_or_empty(guest_contracts::env::USE_MOCK_CODEX_ENV),
            use_codex_app_server_backend: env_or_empty(
                guest_contracts::env::CODEX_APP_SERVER_BACKEND_ENV,
            ),
            mock_codex_path: std::env::var(guest_contracts::env::MOCK_CODEX_PATH_ENV).ok(),
            home: std::env::var("HOME").ok(),
            runtime_home: std::env::var_os("HOME").map(PathBuf::from),
            guest_runtime_dir,
            artifacts: String::new(),
            feature_flags: String::new(),
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

    pub(crate) fn require_run_payload_file(&self) -> Result<(), String> {
        if self.run_payload_file.is_empty() {
            return Err(format!("{RUN_PAYLOAD_FILE_ENV_KEY} is required"));
        }
        Ok(())
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
    pub feature_flags: String,
    pub stuck_tool_timeout_secs: u64,
    pub post_result_sigterm_grace: Duration,
    pub post_result_total_cap: Duration,
    pub post_result_sigkill_grace: Duration,
}

impl GuestConfig {
    /// Build an owned config from the current process environment.
    pub fn from_process_env() -> Result<Self, String> {
        let raw = GuestConfigRaw::from_process_env();
        raw.require_run_payload_file()?;
        Self::from_raw(raw)
    }

    /// Build an owned config from explicit startup values.
    pub fn from_raw(mut raw: GuestConfigRaw) -> Result<Self, String> {
        if let Some(payload) = load_run_payload_from_raw(&raw)? {
            apply_run_payload_to_raw(&mut raw, payload);
        }
        let user_env = load_user_env_from_raw(&raw)?;
        Self::from_raw_with_user_env(raw, user_env)
    }

    fn from_raw_with_user_env(
        raw: GuestConfigRaw,
        user_env: HashMap<String, String>,
    ) -> Result<Self, String> {
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
            feature_flags: raw.feature_flags,
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

fn bool_true_value(value: Option<&str>) -> bool {
    matches!(value, Some("true"))
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

fn load_run_payload_from_raw(
    raw: &GuestConfigRaw,
) -> Result<Option<guest_contracts::env::RunPayload>, String> {
    if raw.run_payload_file.is_empty() {
        return Ok(None);
    }

    let path = Path::new(&raw.run_payload_file);
    let runtime_dir = guest_runtime_dir_for_private_file_values(
        RUN_PAYLOAD_FILE_ENV_KEY,
        &raw.run_id,
        raw.guest_runtime_dir.as_deref(),
        raw.runtime_home
            .as_deref()
            .or_else(|| raw.home.as_deref().map(Path::new)),
    )?;
    validate_run_payload_file_path_for_runtime(path, &runtime_dir)?;
    load_run_payload_from_path(path).map(Some)
}

fn load_run_payload_from_path(path: &Path) -> Result<guest_contracts::env::RunPayload, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("read {RUN_PAYLOAD_FILE_ENV_KEY} {}: {e}", path.display()))?;
    remove_run_payload_file(path)?;

    let payload: guest_contracts::env::RunPayload = serde_json::from_str(&raw)
        .map_err(|e| format!("parse {RUN_PAYLOAD_FILE_ENV_KEY} JSON: {e}"))?;
    validate_run_payload(&payload)?;

    Ok(payload)
}

fn apply_run_payload_to_raw(raw: &mut GuestConfigRaw, payload: guest_contracts::env::RunPayload) {
    raw.prompt = payload.prompt;
    raw.append_system_prompt = payload.append_system_prompt;
    raw.secret_values = payload.secret_values;
    raw.disallowed_tools = payload.disallowed_tools;
    raw.tools = payload.tools;
    raw.settings = payload.settings;
    raw.artifacts = payload.artifacts;
    raw.feature_flags = payload.feature_flags;
}

fn remove_run_payload_file(path: &Path) -> Result<(), String> {
    std::fs::remove_file(path)
        .map_err(|e| format!("remove {RUN_PAYLOAD_FILE_ENV_KEY} {}: {e}", path.display()))?;
    if let Some(parent) = path.parent()
        && is_run_payload_private_dir(parent)
    {
        std::fs::remove_dir(parent).map_err(|e| {
            format!(
                "remove {RUN_PAYLOAD_FILE_ENV_KEY} parent {}: {e}",
                parent.display()
            )
        })?;
    }

    Ok(())
}

fn is_run_payload_private_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME)
}

fn run_payload_file_path_for_runtime(runtime_dir: &Path) -> PathBuf {
    runtime_dir
        .join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME)
        .join(guest_contracts::env::RUN_PAYLOAD_FILENAME)
}

fn validate_run_payload_file_path_for_runtime(
    path: &Path,
    runtime_dir: &Path,
) -> Result<(), String> {
    if path == run_payload_file_path_for_runtime(runtime_dir) {
        return Ok(());
    }

    Err(format!(
        "{RUN_PAYLOAD_FILE_ENV_KEY} must point to guest runtime {}/{}",
        guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME,
        guest_contracts::env::RUN_PAYLOAD_FILENAME
    ))
}

fn validate_run_payload(payload: &guest_contracts::env::RunPayload) -> Result<(), String> {
    for (name, value) in [
        (guest_contracts::env::PROMPT_ENV, payload.prompt.as_str()),
        (
            guest_contracts::env::APPEND_SYSTEM_PROMPT_ENV,
            payload.append_system_prompt.as_str(),
        ),
        (
            guest_contracts::env::SECRET_VALUES_ENV,
            payload.secret_values.as_str(),
        ),
        (
            guest_contracts::env::DISALLOWED_TOOLS_ENV,
            payload.disallowed_tools.as_str(),
        ),
        (guest_contracts::env::TOOLS_ENV, payload.tools.as_str()),
        (
            guest_contracts::env::SETTINGS_ENV,
            payload.settings.as_str(),
        ),
        (
            guest_contracts::env::ARTIFACTS_ENV,
            payload.artifacts.as_str(),
        ),
        (
            guest_contracts::env::FEATURE_FLAGS_ENV,
            payload.feature_flags.as_str(),
        ),
    ] {
        if value.contains('\0') {
            return Err(format!(
                "{RUN_PAYLOAD_FILE_ENV_KEY} contains NUL byte for {name}"
            ));
        }
    }

    Ok(())
}

fn load_user_env_from_raw(raw: &GuestConfigRaw) -> Result<HashMap<String, String>, String> {
    if raw.user_env_file.is_empty() {
        return Ok(HashMap::new());
    }

    let path = Path::new(&raw.user_env_file);
    let runtime_dir = guest_runtime_dir_for_private_file_values(
        USER_ENV_FILE_ENV_KEY,
        &raw.run_id,
        raw.guest_runtime_dir.as_deref(),
        raw.runtime_home
            .as_deref()
            .or_else(|| raw.home.as_deref().map(Path::new)),
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

fn guest_runtime_dir_for_private_file_values(
    env_key: &str,
    run_id: &str,
    runtime_dir: Option<&Path>,
    home: Option<&Path>,
) -> Result<PathBuf, String> {
    guest_contracts::runtime_paths::validate_run_id(run_id)
        .map_err(|e| format!("resolve guest runtime dir for {env_key}: {e}"))?;

    if let Some(runtime_dir) = runtime_dir {
        if !runtime_dir.is_absolute() {
            return Err(format!(
                "resolve guest runtime dir for {env_key}: {}",
                guest_contracts::runtime_paths::RuntimePathError::InvalidRuntimeDir
            ));
        }
        return Ok(runtime_dir.to_path_buf());
    }

    let Some(home) = home.filter(|value| !value.as_os_str().is_empty()) else {
        return Err(format!(
            "resolve guest runtime dir for {env_key}: {}",
            guest_contracts::runtime_paths::RuntimePathError::MissingHome
        ));
    };

    guest_contracts::runtime_paths::run_dir_for_home(home, run_id)
        .map_err(|e| format!("resolve guest runtime dir for {env_key}: {e}"))
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

    fn write_run_payload_fixture(
        runtime_dir: &Path,
        payload: &guest_contracts::env::RunPayload,
    ) -> std::path::PathBuf {
        let dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
        std::fs::write(&path, serde_json::to_vec(payload).unwrap()).unwrap();
        path
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
    fn guest_config_from_raw_loads_run_payload_and_removes_private_file() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_dir = tmp.path().join("runtime");
        let payload = guest_contracts::env::RunPayload {
            prompt: "payload prompt".to_string(),
            append_system_prompt: "payload system".to_string(),
            secret_values: "payload-secret".to_string(),
            disallowed_tools: "WebFetch".to_string(),
            tools: "Bash".to_string(),
            settings: "{}".to_string(),
            artifacts:
                r#"[{"name":"artifact","mountPath":"/mnt/a","storageId":"storage","versionId":"v1"}]"#
                    .to_string(),
            feature_flags: r#"{"flag":true}"#.to_string(),
        };
        let path = write_run_payload_fixture(&runtime_dir, &payload);
        let parent = path.parent().unwrap().to_path_buf();

        let raw = GuestConfigRaw {
            run_payload_file: path.to_string_lossy().into_owned(),
            prompt: "legacy prompt".to_string(),
            append_system_prompt: "legacy system".to_string(),
            secret_values: "legacy-secret".to_string(),
            disallowed_tools: "LegacyTool".to_string(),
            tools: "LegacyAllowedTool".to_string(),
            settings: r#"{"legacy":true}"#.to_string(),
            artifacts: String::new(),
            guest_runtime_dir: Some(runtime_dir),
            ..raw_config_fixture()
        };

        let config = GuestConfig::from_raw(raw).unwrap();

        assert_eq!(config.prompt, "payload prompt");
        assert_eq!(config.append_system_prompt, "payload system");
        assert_eq!(config.secret_values, "payload-secret");
        assert_eq!(config.disallowed_tools, "WebFetch");
        assert_eq!(config.tools, "Bash");
        assert_eq!(config.settings, "{}");
        assert_eq!(config.artifacts.len(), 1);
        assert_eq!(config.feature_flags, r#"{"flag":true}"#);
        assert!(!path.exists());
        assert!(!parent.exists());
    }

    #[test]
    fn guest_config_from_raw_rejects_run_payload_outside_runtime_dir_without_path_leak() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_dir = tmp.path().join("runtime");
        let unexpected = tmp
            .path()
            .join("other")
            .join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME)
            .join(guest_contracts::env::RUN_PAYLOAD_FILENAME);

        let raw = GuestConfigRaw {
            run_payload_file: unexpected.to_string_lossy().into_owned(),
            guest_runtime_dir: Some(runtime_dir),
            ..raw_config_fixture()
        };

        let err = GuestConfig::from_raw(raw).err().unwrap();

        assert!(err.contains("run-payload/payload.json"));
        assert!(!err.contains(unexpected.to_string_lossy().as_ref()));
    }

    #[test]
    fn load_run_payload_from_path_rejects_nul_without_value_leak() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_dir = tmp.path().join("runtime");
        let payload = guest_contracts::env::RunPayload {
            prompt: "secret\0prompt".to_string(),
            ..guest_contracts::env::RunPayload::default()
        };
        let path = write_run_payload_fixture(&runtime_dir, &payload);
        let parent = path.parent().unwrap().to_path_buf();

        let err = load_run_payload_from_path(&path).unwrap_err();

        assert!(err.contains(guest_contracts::env::PROMPT_ENV));
        assert!(!err.contains("secret"));
        assert!(!err.contains("prompt"));
        assert!(!path.exists());
        assert!(!parent.exists());
    }

    #[test]
    fn load_run_payload_from_path_removes_file_before_parse_error() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_dir = tmp.path().join("runtime");
        let dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
        std::fs::write(&path, r#"{"prompt":"secret""#).unwrap();

        let err = load_run_payload_from_path(&path).unwrap_err();

        assert!(err.contains("parse"));
        assert!(!err.contains("secret"));
        assert!(!path.exists());
        assert!(!dir.exists());
    }

    #[test]
    fn guest_config_from_raw_validates_user_env_with_runtime_home_when_home_string_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime_home = tmp.path().join("home");
        let runtime_dir =
            guest_contracts::runtime_paths::run_dir_for_home(&runtime_home, "run-123").unwrap();
        let user_env_dir = runtime_dir.join(USER_ENV_PRIVATE_DIR_NAME);
        std::fs::create_dir_all(&user_env_dir).unwrap();
        let user_env_path = user_env_dir.join(USER_ENV_FILENAME);
        std::fs::write(
            &user_env_path,
            r#"{"HOME":"/home/from-user-env","OPENAI_MODEL":"gpt-runtime-home"}"#,
        )
        .unwrap();

        let raw = GuestConfigRaw {
            user_env_file: user_env_path.to_string_lossy().into_owned(),
            home: None,
            runtime_home: Some(runtime_home),
            ..raw_config_fixture()
        };

        let config = GuestConfig::from_raw(raw).unwrap();

        assert_eq!(config.home_dir, "/home/from-user-env");
        assert_eq!(
            config.user_env.get("OPENAI_MODEL").map(String::as_str),
            Some("gpt-runtime-home")
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
        let err = guest_runtime_dir_for_private_file_values(
            USER_ENV_FILE_ENV_KEY,
            "",
            None,
            Some(Path::new("/home/vm0")),
        )
        .unwrap_err();

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
