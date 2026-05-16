//! Codex auth setup boundary.
//!
//! This module owns the guest-side setup wrapper that runs before
//! `codex exec`. Fabricated ChatGPT-OAuth auth.json creation stays in
//! `codex_auth`; command construction stays in `cli::command`.

use std::io::Write as _;
use std::process::Stdio;
use std::time::Instant;

use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_info, log_warn};

use crate::env;
use crate::error::AgentError;

const LOG_TAG: &str = "sandbox:guest-agent";

/// Set up codex auth on the guest before invoking `codex exec`.
///
/// Two mutually-exclusive paths:
///
/// - **ChatGPT-OAuth mode** (`CHATGPT_ACCOUNT_ID` set): write a fabricated
///   `~/.codex/auth.json` containing placeholder JWTs that put codex into
///   `Chatgpt` mode without ever holding real OAuth credentials inside
///   the sandbox. The firewall replaces placeholder bytes on egress. See
///   the `codex_auth` module + issue #11877.
///
/// - **API-key mode** (default): pipe `OPENAI_API_KEY` into
///   `codex login --with-api-key` to write `~/.codex/auth.json`. If
///   `OPENAI_API_KEY` is empty, log and return Ok -- `codex exec` reads
///   the env directly so the env path covers authn even when the login
///   subcommand isn't available.
///
/// Both paths are best-effort -- failure logs but does not abort init.
pub fn setup_codex() -> Result<(), AgentError> {
    if env::is_codex_oauth_mode() {
        return setup_codex_chatgpt();
    }

    let codex_home = format!("{}/.codex", env::home_dir());
    std::fs::create_dir_all(&codex_home)?;
    log_info!(LOG_TAG, "Codex home directory: {codex_home}");

    let api_key = env::openai_api_key();
    if api_key.is_empty() {
        log_info!(LOG_TAG, "OPENAI_API_KEY not set, skipping codex login");
        return Ok(());
    }

    let login_start = Instant::now();
    let result = std::process::Command::new("codex")
        .args(["login", "--with-api-key"])
        .env("CODEX_HOME", &codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(api_key.as_bytes());
            }
            child.wait_with_output()
        });
    let success = matches!(&result, Ok(o) if o.status.success());
    if success {
        log_info!(LOG_TAG, "Codex authenticated with API key");
    } else {
        match &result {
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                log_warn!(LOG_TAG, "codex login failed (non-fatal): {stderr}");
            }
            Err(e) => {
                log_warn!(LOG_TAG, "codex login spawn failed (non-fatal): {e}");
            }
        }
    }
    record_sandbox_op("codex_login", login_start.elapsed(), success, None);
    Ok(())
}

/// Wrapper that calls `codex_auth::setup_codex_chatgpt_inner` with values
/// read from env + the real clock, and records a telemetry op so failures
/// surface in dashboards.
fn setup_codex_chatgpt() -> Result<(), AgentError> {
    let setup_start = Instant::now();
    let home = std::path::PathBuf::from(env::home_dir());
    let result = crate::codex_auth::setup_codex_chatgpt_inner(&home, chrono::Utc::now());

    let success = result.is_ok();
    let err_msg = result.as_ref().err().map(|e| e.to_string());
    record_sandbox_op(
        "codex_chatgpt_setup",
        setup_start.elapsed(),
        success,
        err_msg.as_deref(),
    );

    if success {
        log_info!(LOG_TAG, "Codex ChatGPT-OAuth auth.json written");
    }
    result
}
