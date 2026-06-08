//! CLI session restore helpers for guest agent frameworks.

use sandbox::Sandbox;
use tracing::{info, warn};

use super::{RunnerError, RunnerResult};
use crate::types::{ExecutionContext, ResumeSession};
use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;

pub(super) async fn restore_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &ResumeSession,
) -> RunnerResult<()> {
    // Validate session_id to prevent path traversal (only allow alnum, dash, underscore).
    // Applied up-front so unknown frameworks still reject malformed IDs in case the
    // skip branch is ever upgraded to a write.
    if !is_valid_session_id(&session.session_id) {
        return Err(RunnerError::Internal(format!(
            "invalid session_id: {}",
            session.session_id
        )));
    }

    match context.cli_agent_type.as_str() {
        "" | "claude-code" => restore_claude_session(sandbox, context, session).await,
        "codex" => restore_codex_session(sandbox, context, session).await,
        other => {
            warn!(
                run_id = %context.run_id,
                framework = %other,
                "skipping session restore for unknown framework"
            );
            Ok(())
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
    let session_path = format!("{session_dir}/{}.jsonl", session.session_id);

    sandbox
        .write_file(&session_path, session.session_history.as_bytes())
        .await?;
    info!(run_id = %context.run_id, path = %session_path, "restored claude session history");
    Ok(())
}

pub(super) fn codex_restore_rollout_path(
    session_id: &str,
    session_history: &str,
    fallback_timestamp: chrono::DateTime<chrono::Utc>,
) -> String {
    let timestamp = codex_session_meta_timestamp(session_history).unwrap_or(fallback_timestamp);
    format!(
        "/home/user/.codex/sessions/{}/{}/{}/rollout-{}-{session_id}.jsonl",
        timestamp.format("%Y"),
        timestamp.format("%m"),
        timestamp.format("%d"),
        timestamp.format("%Y-%m-%dT%H-%M-%S"),
    )
}

pub(super) fn codex_session_meta_timestamp(
    session_history: &str,
) -> Option<chrono::DateTime<chrono::Utc>> {
    for line in session_history.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|value| value.as_str()) != Some("session_meta") {
            continue;
        }

        if let Some(timestamp) = value
            .get("payload")
            .and_then(|payload| payload.get("timestamp"))
            .and_then(|timestamp| timestamp.as_str())
            .and_then(parse_codex_rollout_timestamp)
        {
            return Some(timestamp);
        }

        if let Some(timestamp) = value
            .get("timestamp")
            .and_then(|timestamp| timestamp.as_str())
            .and_then(parse_codex_rollout_timestamp)
        {
            return Some(timestamp);
        }
    }

    None
}

pub(super) fn parse_codex_rollout_timestamp(raw: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|timestamp| timestamp.with_timezone(&chrono::Utc))
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H-%M-%S")
                .ok()
                .map(|timestamp| {
                    chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(
                        timestamp,
                        chrono::Utc,
                    )
                })
        })
}

/// Write a Codex session history file as plain JSONL at
/// `~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-{thread_id}.jsonl`.
///
/// Codex 0.137 filters filesystem resume candidates through its canonical
/// rollout filename parser, so a bare `{thread_id}.jsonl` is ignored.
pub(super) async fn restore_codex_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &ResumeSession,
) -> RunnerResult<()> {
    let session_path = codex_restore_rollout_path(
        &session.session_id,
        &session.session_history,
        chrono::Utc::now(),
    );

    sandbox
        .write_file(&session_path, session.session_history.as_bytes())
        .await?;

    info!(
        run_id = %context.run_id,
        path = %session_path,
        bytes_in = session.session_history.len(),
        "restored codex session history",
    );
    Ok(())
}

/// Returns true if the session ID contains only safe characters (alphanumeric, dash, underscore).
pub(super) fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}
