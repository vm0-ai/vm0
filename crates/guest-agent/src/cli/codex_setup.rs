//! Codex auth setup boundary.
//!
//! This module owns the guest-side setup wrapper that runs before
//! `codex exec`. Fabricated ChatGPT-OAuth auth.json creation stays in
//! `codex_auth`; command construction stays in `cli::command`.

use std::process::Stdio;
use std::time::{Duration, Instant};

use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_info, log_warn};
use tokio::io::AsyncWriteExt as _;

use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::masker::SecretMasker;

use super::{child_env, diagnostics};

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
///   `OPENAI_API_KEY` is empty, log and return Ok -- `codex exec` receives
///   the loaded user env so the env path covers authn even when the login
///   subcommand isn't available.
///
/// Both paths are best-effort -- failure logs but does not abort init.
pub async fn setup_codex(masker: &SecretMasker) -> Result<(), AgentError> {
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
    let mut cmd = tokio::process::Command::new("codex");
    child_env::apply_to_tokio_command(&mut cmd);
    let result = cmd
        .args(["login", "--with-api-key"])
        .env("CODEX_HOME", &codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn();
    let result = match result {
        Ok(mut child) => {
            let pgid = child.id().map(|pid| pid as i32);
            let mut process_group = SetupProcessGroupGuard::new(pgid);
            let stderr = child.stderr.take();
            let stderr_handle = tokio::spawn(async move {
                match stderr {
                    Some(stderr) => diagnostics::collect_stderr_result_tail(stderr).await,
                    None => Vec::new(),
                }
            });

            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(api_key.as_bytes()).await;
            }

            match child.wait().await {
                Ok(status) => {
                    let stderr_lines = drain_setup_stderr_after_wait(stderr_handle, pgid).await;
                    process_group.disarm();
                    Ok((status, stderr_lines))
                }
                Err(e) => {
                    stderr_handle.abort();
                    let _ = stderr_handle.await;
                    Err(("wait", e))
                }
            }
        }
        Err(e) => Err(("spawn", e)),
    };
    let success = matches!(&result, Ok((status, _)) if status.success());
    if success {
        log_info!(LOG_TAG, "Codex authenticated with API key");
    } else {
        match &result {
            Ok((status, stderr_lines)) => {
                let stderr_lines = masker.mask_diagnostic_lines(stderr_lines.clone());
                if stderr_lines.is_empty() {
                    log_warn!(LOG_TAG, "codex login failed (non-fatal): {status}");
                } else {
                    let stderr = stderr_lines.join("\n");
                    log_warn!(LOG_TAG, "codex login failed (non-fatal): {stderr}");
                }
            }
            Err((stage, e)) => {
                let error = masker
                    .mask_diagnostic_lines(vec![e.to_string()])
                    .into_iter()
                    .next()
                    .unwrap_or_default();
                log_warn!(LOG_TAG, "codex login {stage} failed (non-fatal): {error}");
            }
        }
    }
    record_sandbox_op("codex_login", login_start.elapsed(), success, None);
    Ok(())
}

struct SetupProcessGroupGuard {
    pgid: Option<i32>,
}

impl SetupProcessGroupGuard {
    fn new(pgid: Option<i32>) -> Self {
        Self { pgid }
    }

    fn disarm(&mut self) {
        self.pgid = None;
    }
}

impl Drop for SetupProcessGroupGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.pgid {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
}

async fn drain_setup_stderr_after_wait(
    mut stderr_handle: tokio::task::JoinHandle<Vec<String>>,
    pgid: Option<i32>,
) -> Vec<String> {
    if !stderr_handle.is_finished() {
        tokio::task::yield_now().await;
    }

    if !stderr_handle.is_finished()
        && let Some(pid) = pgid
    {
        log_warn!(
            LOG_TAG,
            "codex login stderr still open after exit, SIGKILL pgid={pid}"
        );
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }

    let stderr_timeout =
        tokio::time::sleep(Duration::from_secs(constants::STDOUT_DRAIN_DEADLINE_SECS));
    tokio::pin!(stderr_timeout);
    tokio::select! {
        result = &mut stderr_handle => match result {
            Ok(lines) => lines,
            Err(e) => {
                log_warn!(LOG_TAG, "codex login stderr collector panicked: {e}");
                Vec::new()
            }
        },
        () = &mut stderr_timeout => {
            log_warn!(
                LOG_TAG,
                "codex login stderr drain timeout, possible orphaned child process"
            );
            stderr_handle.abort();
            let _ = stderr_handle.await;
            Vec::new()
        },
    }
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
