//! CLI session restore helpers for guest agent frameworks.

mod codex;

use sandbox::{Sandbox, SandboxError};
use tracing::{info, warn};

use super::cli_framework::{EffectiveCliFramework, effective_cli_framework};
use super::env::validate_resume_session_id;
use super::session_id::{canonical_codex_thread_id, is_valid_session_id};
use super::{RunnerError, RunnerResult};
use crate::paths::diagnostic_session_fingerprint;
use crate::restored_session_identity::{RestoredSessionFramework, RestoredSessionIdentity};
use crate::types::{ExecutionContext, ResumeSession};
use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;

const SESSION_PATH_SENTINEL: &str = "\u{0}\u{1}";
const SESSION_ID_SENTINEL: &str = "\u{0}\u{2}";
const REDACTED_SESSION_PATH: &str = "[redacted-session-path]";
const REDACTED_SESSION_ID: &str = "[redacted-session-id]";
const SUBSTRING_SESSION_ID_REDACTION_MIN_LEN: usize = 8;

impl RestoredSessionIdentity {
    pub(crate) fn from_context(context: &ExecutionContext) -> Option<Self> {
        validate_resume_session_id(context).ok()?;
        let resume_session = context.resume_session.as_ref()?;
        let history_ref = resume_session.history_ref()?;
        let effective_framework = effective_cli_framework(&context.cli_agent_type);
        let framework = restored_session_framework(effective_framework);
        let session_id = restored_session_identity_session_id(
            effective_framework,
            &resume_session.cli_agent_session_id,
        )?;
        Some(Self::new(
            framework,
            &session_id,
            history_ref.kind,
            history_ref.hash.clone(),
            history_ref.size,
            None,
        ))
    }
}

fn restored_session_identity_session_id(
    framework: EffectiveCliFramework,
    session_id: &str,
) -> Option<String> {
    match framework {
        EffectiveCliFramework::ClaudeCode => Some(session_id.to_owned()),
        EffectiveCliFramework::Codex => canonical_codex_thread_id(session_id),
    }
}

fn restored_session_framework(framework: EffectiveCliFramework) -> RestoredSessionFramework {
    match framework {
        EffectiveCliFramework::ClaudeCode => RestoredSessionFramework::ClaudeCode,
        EffectiveCliFramework::Codex => RestoredSessionFramework::Codex,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct SessionRestoreDiagnostics {
    pub(super) framework: &'static str,
    pub(super) session_fingerprint: String,
    pub(super) bytes_in: usize,
    pub(super) restored_session_identity: Option<RestoredSessionIdentity>,
}

pub(super) async fn restore_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &ResumeSession,
) -> RunnerResult<SessionRestoreDiagnostics> {
    // Validate the CLI agent session id to prevent path traversal.
    // Only allow alnum, dash, and underscore.
    // Applied up-front so unknown frameworks still reject malformed IDs in case the
    // skip branch is ever upgraded to a write.
    if !is_valid_session_id(&session.cli_agent_session_id) {
        return Err(RunnerError::Internal("invalid session_id".into()));
    }

    if session.session_history().is_none() {
        return Err(RunnerError::Internal(
            "resume session history was not materialized".into(),
        ));
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
) -> RunnerResult<SessionRestoreDiagnostics> {
    let session_history = session.session_history().ok_or_else(|| {
        RunnerError::Internal("resume session history was not materialized".into())
    })?;
    let project_name = CANONICAL_WORKING_DIR
        .trim_start_matches('/')
        .replace('/', "-");
    let session_dir = format!("/home/user/.claude/projects/-{project_name}");
    let session_path = format!("{session_dir}/{}.jsonl", session.cli_agent_session_id);

    write_session_history_file(
        sandbox,
        &session_path,
        &[&session.cli_agent_session_id],
        session_history,
    )
    .await?;
    let diagnostics = SessionRestoreDiagnostics {
        framework: "claude-code",
        session_fingerprint: diagnostic_session_fingerprint(&session.cli_agent_session_id),
        bytes_in: session_history.len(),
        restored_session_identity: RestoredSessionIdentity::from_context(context).map(|identity| {
            identity.with_guest_history(session_history.len() as u64, session_path.clone())
        }),
    };
    info!(
        run_id = %context.run_id,
        framework = diagnostics.framework,
        session_fingerprint = %diagnostics.session_fingerprint,
        bytes_in = diagnostics.bytes_in,
        "restored session history"
    );
    Ok(diagnostics)
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
