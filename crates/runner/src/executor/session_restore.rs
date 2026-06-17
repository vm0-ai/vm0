//! CLI session restore helpers for guest agent frameworks.

use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox, SandboxError};
use tracing::{info, warn};

use super::storage::format_guest_exec_failure;
use super::{DEFAULT_EXEC_TIMEOUT, RunnerError, RunnerResult};
use crate::paths::diagnostic_session_fingerprint;
use crate::types::{ExecutionContext, ResumeSession};
use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;

const SESSION_PATH_SENTINEL: &str = "\u{0}\u{1}";
const SESSION_ID_SENTINEL: &str = "\u{0}\u{2}";
const REDACTED_SESSION_PATH: &str = "[redacted-session-path]";
const REDACTED_SESSION_ID: &str = "[redacted-session-id]";
const SUBSTRING_SESSION_ID_REDACTION_MIN_LEN: usize = 8;
const MAX_SESSION_ID_LEN: usize = 128;

pub(super) async fn restore_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &ResumeSession,
) -> RunnerResult<()> {
    // Validate session_id to prevent path traversal (only allow alnum, dash, underscore).
    // Applied up-front so unknown frameworks still reject malformed IDs in case the
    // skip branch is ever upgraded to a write.
    if !is_valid_session_id(&session.session_id) {
        return Err(RunnerError::Internal("invalid session_id".into()));
    }

    match context.cli_agent_type.as_str() {
        "" | "claude-code" => restore_claude_session(sandbox, context, session).await,
        "codex" => restore_codex_session(sandbox, context, session).await,
        other => {
            warn!(
                run_id = %context.run_id,
                framework = %other,
                "restoring session as claude-code for unknown framework"
            );
            restore_claude_session(sandbox, context, session).await
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

    write_session_history_file(
        sandbox,
        &session_path,
        &[&session.session_id],
        &session.session_history,
    )
    .await?;
    info!(
        run_id = %context.run_id,
        framework = "claude-code",
        session_fingerprint = %diagnostic_session_fingerprint(&session.session_id),
        bytes_in = session.session_history.len(),
        "restored session history"
    );
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
    let session_id = canonical_codex_thread_id(&session.session_id)
        .ok_or_else(|| RunnerError::Internal("invalid codex session_id".into()))?;

    let session_path =
        codex_restore_rollout_path(&session_id, &session.session_history, chrono::Utc::now());

    cleanup_existing_codex_session_files(sandbox, context, &session_id, &session_path).await?;

    write_session_history_file(
        sandbox,
        &session_path,
        &[&session_id, &session.session_id],
        &session.session_history,
    )
    .await?;

    info!(
        run_id = %context.run_id,
        framework = "codex",
        session_fingerprint = %diagnostic_session_fingerprint(&session_id),
        bytes_in = session.session_history.len(),
        "restored session history",
    );
    Ok(())
}

async fn cleanup_existing_codex_session_files(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session_id: &str,
    session_path: &str,
) -> RunnerResult<()> {
    let cleanup_cmd = r#"codex_home=/home/user/.codex
root="$codex_home/sessions"
restore_path="$VM0_CODEX_RESTORE_SESSION_PATH"
restore_dir="${restore_path%/*}"
case "$restore_dir" in
  "$root"/*/*/*) ;;
  *)
    echo "invalid codex restore directory: $restore_dir" >&2
    exit 1
    ;;
esac
check_restore_dir_component() {
  path="$1"
  if [ -L "$path" ]; then
    echo "codex restore directory is a symlink: $path" >&2
    exit 1
  fi
  if [ -e "$path" ] && [ ! -d "$path" ]; then
    echo "codex restore path component is not a directory: $path" >&2
    exit 1
  fi
}
check_restore_dir_component "$codex_home"
check_restore_dir_component "$root"
root_prefix="$root/"
relative_dir="${restore_dir#$root_prefix}"
current="$root"
old_ifs="$IFS"
IFS=/
for component in $relative_dir; do
  case "$component" in
    ""|"."|"..")
      echo "invalid codex restore path component: $component" >&2
      exit 1
      ;;
  esac
  current="$current/$component"
  check_restore_dir_component "$current"
done
IFS="$old_ifs"
if [ -d "$root" ]; then
  id="$VM0_CODEX_RESTORE_SESSION_ID"
  id_no_dashes="$(printf '%s' "$id" | tr -d '-')"
  find "$root" \( -type f -o -type l \) \( \
    -iname "*${id}*.jsonl" -o \
    -iname "*${id}*.jsonl.zst" -o \
    -iname "*${id}*.jsonl.vm0tmp-*" -o \
    -iname "*${id}*.jsonl.zst.vm0tmp-*" -o \
    -iname "*${id_no_dashes}*.jsonl" -o \
    -iname "*${id_no_dashes}*.jsonl.zst" -o \
    -iname "*${id_no_dashes}*.jsonl.vm0tmp-*" -o \
    -iname "*${id_no_dashes}*.jsonl.zst.vm0tmp-*" \
  \) -delete
fi"#;
    let env = [
        ("VM0_CODEX_RESTORE_SESSION_ID", session_id),
        ("VM0_CODEX_RESTORE_SESSION_PATH", session_path),
    ];
    let result = sandbox
        .exec(&ExecRequest {
            cmd: cleanup_cmd,
            timeout: DEFAULT_EXEC_TIMEOUT,
            env: &env,
            sudo: false,
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        })
        .await?;
    if result.exit_code != 0 {
        return Err(RunnerError::Internal(redact_session_restore_diagnostic(
            format_guest_exec_failure("codex session cleanup", &result),
            &[session_id],
            session_path,
        )));
    }
    info!(
        run_id = %context.run_id,
        session_fingerprint = %diagnostic_session_fingerprint(session_id),
        "cleaned up existing codex session files before restore",
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

/// Returns true if the session ID is short enough for guest filenames and
/// contains only safe characters (alphanumeric, dash, underscore).
pub(super) fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_SESSION_ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub(super) fn canonical_codex_thread_id(id: &str) -> Option<String> {
    if !is_valid_session_id(id) {
        return None;
    }
    uuid::Uuid::parse_str(id).ok().map(|uuid| uuid.to_string())
}
