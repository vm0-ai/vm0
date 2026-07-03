//! Codex auth setup boundary.
//!
//! This module owns the guest-side setup wrapper that runs before
//! `codex exec`. Auth-state file construction lives in `codex_auth`;
//! command construction stays in `cli::command`.

use std::time::Instant;

use guest_common::log_info;
use guest_common::telemetry::record_sandbox_op;

use crate::codex_auth::{DesiredCodexAuth, reconcile_codex_auth_state};
use crate::env;
use crate::error::AgentError;
use crate::masker::SecretMasker;

const LOG_TAG: &str = "sandbox:guest-agent";

/// Reconcile Codex auth using the config captured during guest-agent bootstrap.
///
/// Three mutually-exclusive states are supported:
///
/// - **ChatGPT-OAuth mode** (`CHATGPT_ACCOUNT_ID` set): write a fabricated
///   `~/.codex/auth.json` containing placeholder JWTs that put Codex into
///   ChatGPT mode without ever holding real OAuth credentials inside the
///   sandbox. The firewall replaces placeholder bytes on egress. See the
///   `codex_auth` module and issue #11877.
/// - **API-key mode** (`OPENAI_API_KEY` set): write Codex's API-key auth.json
///   shape directly. This avoids spawning `codex login --with-api-key` and
///   keeps setup deterministic before the CLI process starts.
/// - **No auth**: remove any stale auth.json left by a previous reused
///   sandbox run so Codex cannot inherit credentials from another run.
pub async fn setup_codex_for_config(
    _masker: &SecretMasker,
    config: &env::GuestConfig,
) -> Result<(), AgentError> {
    let codex_oauth_mode = config
        .user_env
        .get("CHATGPT_ACCOUNT_ID")
        .is_some_and(|value| !value.is_empty());
    let api_key = config
        .user_env
        .get("OPENAI_API_KEY")
        .map(String::as_str)
        .unwrap_or("");
    setup_codex_with_values(codex_oauth_mode, &config.home_dir, api_key)
}

fn setup_codex_with_values(
    codex_oauth_mode: bool,
    home_dir: &str,
    api_key: &str,
) -> Result<(), AgentError> {
    let setup_start = Instant::now();
    let home = std::path::PathBuf::from(home_dir);
    let (desired, mode_label) = if codex_oauth_mode {
        (
            DesiredCodexAuth::ChatGpt {
                now: chrono::Utc::now(),
            },
            "chatgpt",
        )
    } else if api_key.is_empty() {
        (DesiredCodexAuth::None, "none")
    } else {
        (DesiredCodexAuth::ApiKey { api_key }, "apikey")
    };

    let result = reconcile_codex_auth_state(&home, desired);
    let success = result.is_ok();
    let err_msg = result.as_ref().err().map(ToString::to_string);
    record_sandbox_op(
        "codex_auth_reconcile",
        setup_start.elapsed(),
        success,
        err_msg.as_deref(),
    );

    if success {
        log_info!(
            LOG_TAG,
            "Codex auth state reconciled with mode {mode_label}"
        );
    }

    result
}
