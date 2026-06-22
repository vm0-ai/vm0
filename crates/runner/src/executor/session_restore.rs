//! CLI session restore helpers for guest agent frameworks.

mod codex;

use sandbox::{Sandbox, SandboxError};
use tracing::{info, warn};

use super::cli_framework::{EffectiveCliFramework, effective_cli_framework};
use super::session_id::is_valid_session_id;
use super::{RunnerError, RunnerResult};
use crate::paths::diagnostic_session_fingerprint;
use crate::types::{ExecutionContext, ResumeSession};
use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;

const SESSION_PATH_SENTINEL: &str = "\u{0}\u{1}";
const SESSION_ID_SENTINEL: &str = "\u{0}\u{2}";
const REDACTED_SESSION_PATH: &str = "[redacted-session-path]";
const REDACTED_SESSION_ID: &str = "[redacted-session-id]";
const SUBSTRING_SESSION_ID_REDACTION_MIN_LEN: usize = 8;
pub(super) async fn restore_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &ResumeSession,
) -> RunnerResult<()> {
    // Validate the CLI agent session id to prevent path traversal.
    // Only allow alnum, dash, and underscore.
    // Applied up-front so unknown frameworks still reject malformed IDs in case the
    // skip branch is ever upgraded to a write.
    if !is_valid_session_id(&session.cli_agent_session_id) {
        return Err(RunnerError::Internal("invalid session_id".into()));
    }

    match effective_cli_framework(&context.cli_agent_type) {
        EffectiveCliFramework::ClaudeCode => {
            if !matches!(context.cli_agent_type.as_str(), "" | "claude-code") {
                warn!(
                    run_id = %context.run_id,
                    framework = %context.cli_agent_type,
                    "restoring session as claude-code for unknown framework"
                );
            }
            restore_claude_session(sandbox, context, session).await
        }
        EffectiveCliFramework::Codex => {
            codex::restore_codex_session(sandbox, context, session).await
        }
    }
}

/// Write a Claude Code session history file at `~/.claude/projects/-{project}/{id}.jsonl`.
pub(super) async fn restore_claude_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &ResumeSession,
) -> RunnerResult<()> {
    let project_name = CANONICAL_WORKING_DIR
        .trim_start_matches('/')
        .replace('/', "-");
    let session_dir = format!("/home/user/.claude/projects/-{project_name}");
    let session_path = format!("{session_dir}/{}.jsonl", session.cli_agent_session_id);

    write_session_history_file(
        sandbox,
        &session_path,
        &[&session.cli_agent_session_id],
        &session.session_history,
    )
    .await?;
    info!(
        run_id = %context.run_id,
        framework = "claude-code",
        session_fingerprint = %diagnostic_session_fingerprint(&session.cli_agent_session_id),
        bytes_in = session.session_history.len(),
        "restored session history"
    );
    Ok(())
}

async fn write_session_history_file(
    sandbox: &dyn Sandbox,
    session_path: &str,
    session_ids: &[&str],
    session_history: &str,
) -> RunnerResult<()> {
    sandbox
        .write_file(session_path, session_history.as_bytes())
        .await
        .map_err(|error| redact_session_restore_sandbox_error(error, session_ids, session_path))
}

fn redact_session_restore_sandbox_error(
    error: SandboxError,
    session_ids: &[&str],
    session_path: &str,
) -> RunnerError {
    RunnerError::Sandbox(match error {
        SandboxError::BackendUnavailable { message } => SandboxError::BackendUnavailable {
            message: redact_session_restore_diagnostic(message, session_ids, session_path),
        },
        SandboxError::Configuration { message } => SandboxError::Configuration {
            message: redact_session_restore_diagnostic(message, session_ids, session_path),
        },
        SandboxError::Initialization { phase, message } => SandboxError::Initialization {
            phase,
            message: redact_session_restore_diagnostic(message, session_ids, session_path),
        },
        SandboxError::Start { message } => SandboxError::Start {
            message: redact_session_restore_diagnostic(message, session_ids, session_path),
        },
        SandboxError::InvalidState {
            context,
            state,
            message,
        } => SandboxError::InvalidState {
            context,
            state: redact_session_restore_diagnostic(state, session_ids, session_path),
            message: redact_session_restore_diagnostic(message, session_ids, session_path),
        },
        SandboxError::Operation {
            operation,
            reason,
            message,
        } => SandboxError::Operation {
            operation,
            reason,
            message: redact_session_restore_diagnostic(message, session_ids, session_path),
        },
        SandboxError::IdleTransition {
            transition,
            message,
        } => SandboxError::IdleTransition {
            transition,
            message: redact_session_restore_diagnostic(message, session_ids, session_path),
        },
        SandboxError::Io(error) => SandboxError::Io(std::io::Error::new(
            error.kind(),
            redact_session_restore_diagnostic(error.to_string(), session_ids, session_path),
        )),
    })
}

fn redact_session_restore_diagnostic(
    message: String,
    session_ids: &[&str],
    session_path: &str,
) -> String {
    let mut redacted = message.replace(session_path, SESSION_PATH_SENTINEL);
    for session_id in session_ids {
        for sensitive in session_redaction_variants(session_id) {
            redacted = redact_session_id_variant(redacted, &sensitive);
        }
    }
    redacted
        .replace(SESSION_PATH_SENTINEL, REDACTED_SESSION_PATH)
        .replace(SESSION_ID_SENTINEL, REDACTED_SESSION_ID)
}

fn redact_session_id_variant(message: String, sensitive: &str) -> String {
    if sensitive.len() >= SUBSTRING_SESSION_ID_REDACTION_MIN_LEN {
        return message.replace(sensitive, SESSION_ID_SENTINEL);
    }

    let mut redacted = String::with_capacity(message.len());
    let mut last = 0;
    for (start, _) in message.match_indices(sensitive) {
        let end = start + sensitive.len();
        let previous = message[..start].chars().next_back();
        let next = message[end..].chars().next();
        if is_session_token_boundary(previous) && is_session_token_boundary(next) {
            redacted.push_str(&message[last..start]);
            redacted.push_str(SESSION_ID_SENTINEL);
            last = end;
        }
    }
    if last == 0 {
        message
    } else {
        redacted.push_str(&message[last..]);
        redacted
    }
}

fn is_session_token_boundary(ch: Option<char>) -> bool {
    !ch.is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn session_redaction_variants(session_id: &str) -> Vec<String> {
    let no_dashes = session_id.replace('-', "");
    [
        session_id.to_string(),
        session_id.to_ascii_lowercase(),
        session_id.to_ascii_uppercase(),
        no_dashes.clone(),
        no_dashes.to_ascii_lowercase(),
        no_dashes.to_ascii_uppercase(),
    ]
    .into_iter()
    .filter(|variant| !variant.is_empty())
    .collect()
}
