//! CLI session restore helpers for guest agent frameworks.

mod codex;

use std::sync::Arc;

use chrono::{DateTime, Utc};
use sandbox::Sandbox;
use tracing::{info, warn};

use super::cli_framework::{EffectiveCliFramework, effective_cli_framework};
use super::env::validate_resume_session_id;
use super::session_id::{canonical_codex_thread_id, is_valid_session_id};
use super::{RunnerError, RunnerResult};
use crate::restored_session_identity::{RestoredSessionFramework, RestoredSessionIdentity};
use crate::types::{ExecutionContext, SandboxReuseResult};
use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;

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
            Some(history_ref.raw_size),
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

#[derive(Debug)]
pub(super) struct MaterializedResumeSession {
    cli_agent_session_id: String,
    history: MaterializedResumeHistory,
    codex_timestamp: Option<DateTime<Utc>>,
}

#[derive(Debug)]
enum MaterializedResumeHistory {
    SharedText(Arc<String>),
    Bytes(Vec<u8>),
    CodexZstd(Vec<u8>),
}

impl MaterializedResumeSession {
    pub(super) fn new(
        cli_agent_session_id: String,
        history_bytes: Vec<u8>,
        codex_timestamp: Option<DateTime<Utc>>,
    ) -> Self {
        Self {
            cli_agent_session_id,
            history: MaterializedResumeHistory::Bytes(history_bytes),
            codex_timestamp,
        }
    }

    pub(super) fn new_shared(
        cli_agent_session_id: String,
        session_history: Arc<String>,
        codex_timestamp: Option<DateTime<Utc>>,
    ) -> Self {
        Self {
            cli_agent_session_id,
            history: MaterializedResumeHistory::SharedText(session_history),
            codex_timestamp,
        }
    }

    pub(super) fn new_codex_zstd(
        cli_agent_session_id: String,
        history_bytes: Vec<u8>,
        codex_timestamp: Option<DateTime<Utc>>,
    ) -> Self {
        Self {
            cli_agent_session_id,
            history: MaterializedResumeHistory::CodexZstd(history_bytes),
            codex_timestamp,
        }
    }

    pub(super) fn cli_agent_session_id(&self) -> &str {
        &self.cli_agent_session_id
    }

    pub(super) fn history_bytes(&self) -> &[u8] {
        match &self.history {
            MaterializedResumeHistory::SharedText(session_history) => session_history.as_bytes(),
            MaterializedResumeHistory::Bytes(history_bytes) => history_bytes,
            MaterializedResumeHistory::CodexZstd(bytes) => bytes,
        }
    }

    pub(super) fn codex_timestamp(&self) -> Option<DateTime<Utc>> {
        self.codex_timestamp
    }

    pub(super) fn codex_zstd_history(&self) -> Option<&[u8]> {
        match &self.history {
            MaterializedResumeHistory::CodexZstd(bytes) => Some(bytes),
            MaterializedResumeHistory::SharedText(_) | MaterializedResumeHistory::Bytes(_) => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct SessionRestoreDiagnostics {
    pub(super) framework: &'static str,
    pub(super) session_id: String,
    pub(super) bytes_in: usize,
}

pub(super) async fn restore_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &MaterializedResumeSession,
    reuse_result: SandboxReuseResult,
) -> RunnerResult<SessionRestoreDiagnostics> {
    // Validate the CLI agent session id to prevent path traversal.
    // Only allow alnum, dash, and underscore.
    // Applied up-front so unknown frameworks still reject malformed IDs in case the
    // skip branch is ever upgraded to a write.
    if !is_valid_session_id(session.cli_agent_session_id()) {
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
            codex::restore_codex_session(sandbox, context, session, reuse_result).await
        }
    }
}

/// Write a Claude Code session history file at `~/.claude/projects/-{project}/{id}.jsonl`.
pub(super) async fn restore_claude_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &MaterializedResumeSession,
) -> RunnerResult<SessionRestoreDiagnostics> {
    let session_history = session.history_bytes();
    let project_name = CANONICAL_WORKING_DIR
        .trim_start_matches('/')
        .replace('/', "-");
    let session_dir = format!("/home/user/.claude/projects/-{project_name}");
    let session_id = session.cli_agent_session_id();
    let session_path = format!("{session_dir}/{session_id}.jsonl");

    write_session_history_file(sandbox, &session_path, session_history).await?;
    let diagnostics = SessionRestoreDiagnostics {
        framework: "claude-code",
        session_id: session_id.to_string(),
        bytes_in: session_history.len(),
    };
    info!(
        run_id = %context.run_id,
        framework = diagnostics.framework,
        session_id = %diagnostics.session_id,
        bytes_in = diagnostics.bytes_in,
        "restored session history"
    );
    Ok(diagnostics)
}

async fn write_session_history_file(
    sandbox: &dyn Sandbox,
    session_path: &str,
    session_history: &[u8],
) -> RunnerResult<()> {
    sandbox
        .write_file(session_path, session_history)
        .await
        .map_err(RunnerError::Sandbox)
}
