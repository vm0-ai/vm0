use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox};
use tracing::info;

use super::{redact_session_restore_diagnostic, write_session_history_file};
use crate::helper_exec::{format_helper_exec_failure, helper_exec_succeeded};
use crate::paths::diagnostic_session_fingerprint;
use crate::types::{ExecutionContext, ResumeSession};

use super::super::session_id::canonical_codex_thread_id;
use super::super::{DEFAULT_EXEC_TIMEOUT, RunnerError, RunnerResult};

const CODEX_HOME: &str = "/home/user/.codex";
const CODEX_SESSION_CLEANUP_SCRIPT: &str =
    include_str!("../../../scripts/codex-session-cleanup.sh");

fn codex_restore_rollout_path(
    session_id: &str,
    session_history: &str,
    fallback_timestamp: chrono::DateTime<chrono::Utc>,
) -> String {
    let timestamp = codex_session_meta_timestamp(session_history).unwrap_or(fallback_timestamp);
    format!(
        "{CODEX_HOME}/sessions/{}/{}/{}/rollout-{}-{session_id}.jsonl",
        timestamp.format("%Y"),
        timestamp.format("%m"),
        timestamp.format("%d"),
        timestamp.format("%Y-%m-%dT%H-%M-%S"),
    )
}

fn codex_session_meta_timestamp(session_history: &str) -> Option<chrono::DateTime<chrono::Utc>> {
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

fn parse_codex_rollout_timestamp(raw: &str) -> Option<chrono::DateTime<chrono::Utc>> {
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
    let session_id = canonical_codex_thread_id(&session.cli_agent_session_id)
        .ok_or_else(|| RunnerError::Internal("invalid codex session_id".into()))?;

    let session_path =
        codex_restore_rollout_path(&session_id, &session.session_history, chrono::Utc::now());

    cleanup_existing_codex_session_files(sandbox, context, &session_id, &session_path).await?;

    write_session_history_file(
        sandbox,
        &session_path,
        &[&session_id, &session.cli_agent_session_id],
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
    let cleanup_cmd = codex_session_cleanup_command(CODEX_HOME);
    let env = [
        ("VM0_CODEX_RESTORE_SESSION_ID", session_id),
        ("VM0_CODEX_RESTORE_SESSION_PATH", session_path),
    ];
    let result = sandbox
        .exec(&ExecRequest {
            cmd: &cleanup_cmd,
            timeout: DEFAULT_EXEC_TIMEOUT,
            env: &env,
            sudo: false,
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        })
        .await?;
    if !helper_exec_succeeded(&result) {
        return Err(RunnerError::Internal(redact_session_restore_diagnostic(
            format_helper_exec_failure("codex session cleanup", &result),
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

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn codex_session_cleanup_command(codex_home: &str) -> String {
    let codex_home = shell_quote(codex_home);
    format!("codex_home={codex_home}\n{CODEX_SESSION_CLEANUP_SCRIPT}")
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Output};

    const SESSION_ID: &str = "019e9154-c304-70f0-adde-36efb1be1701";
    const SESSION_ID_NO_DASHES: &str = "019e9154c30470f0adde36efb1be1701";

    fn restore_path(codex_home: &Path) -> PathBuf {
        codex_home.join(format!(
            "sessions/2026/06/04/rollout-2026-06-04T07-18-08-{SESSION_ID}.jsonl"
        ))
    }

    fn create_file(path: &Path) {
        fs::create_dir_all(path.parent().expect("test path should have parent")).unwrap();
        fs::write(path, "test").unwrap();
    }

    fn run_cleanup(codex_home: &Path, restore_path: &Path) -> Output {
        run_cleanup_with_session_id(codex_home, restore_path, SESSION_ID)
    }

    fn run_cleanup_with_session_id(
        codex_home: &Path,
        restore_path: &Path,
        session_id: &str,
    ) -> Output {
        Command::new("sh")
            .arg("-c")
            .arg(codex_session_cleanup_command(
                codex_home.to_str().expect("test path should be utf-8"),
            ))
            .env("VM0_CODEX_RESTORE_SESSION_ID", session_id)
            .env(
                "VM0_CODEX_RESTORE_SESSION_PATH",
                restore_path.to_str().expect("test path should be utf-8"),
            )
            .output()
            .unwrap()
    }

    fn assert_success(output: &Output) {
        assert!(
            output.status.success(),
            "stderr={} stdout={}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
    }

    fn assert_failure_contains(output: &Output, expected: &str) {
        assert!(
            !output.status.success(),
            "expected command to fail; stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains(expected),
            "expected stderr to contain {expected:?}, got {stderr:?}"
        );
    }

    #[test]
    fn cleanup_command_uses_fixed_codex_home_prelude() {
        let command = codex_session_cleanup_command(CODEX_HOME);

        assert!(command.contains("codex_home='/home/user/.codex'"));
        assert!(command.contains("root=\"$codex_home/sessions\""));
        assert!(command.contains("find \"$root\" \\( -type f -o -type l \\)"));
    }

    #[test]
    fn cleanup_script_deletes_matching_session_files_and_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let restore_path = restore_path(&codex_home);
        let restore_dir = restore_path.parent().unwrap();
        fs::create_dir_all(restore_dir).unwrap();

        let matching_jsonl = restore_dir.join(format!("rollout-a-{SESSION_ID}.jsonl"));
        let matching_zst = restore_dir.join(format!("rollout-a-{SESSION_ID}.jsonl.zst"));
        let matching_tmp = restore_dir.join(format!("rollout-a-{SESSION_ID}.jsonl.vm0tmp-123"));
        let matching_no_dash = codex_home.join("sessions/2026/06/05").join(format!(
            "rollout-b-{SESSION_ID_NO_DASHES}.jsonl.zst.vm0tmp-456"
        ));
        let matching_symlink = restore_dir.join(format!("rollout-link-{SESSION_ID}.jsonl"));
        let matching_directory = restore_dir.join(format!("rollout-dir-{SESSION_ID}.jsonl"));
        let unrelated = restore_dir.join("rollout-other-session.jsonl");

        create_file(&matching_jsonl);
        create_file(&matching_zst);
        create_file(&matching_tmp);
        create_file(&matching_no_dash);
        create_file(&unrelated);
        fs::create_dir(&matching_directory).unwrap();
        symlink(&unrelated, &matching_symlink).unwrap();

        let output = run_cleanup(&codex_home, &restore_path);

        assert_success(&output);
        assert!(!matching_jsonl.exists());
        assert!(!matching_zst.exists());
        assert!(!matching_tmp.exists());
        assert!(!matching_no_dash.exists());
        assert!(!matching_symlink.exists());
        assert!(matching_directory.exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn cleanup_script_accepts_uppercase_session_id() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let restore_path = restore_path(&codex_home);
        let restore_dir = restore_path.parent().unwrap();
        fs::create_dir_all(restore_dir).unwrap();
        let matching_jsonl = restore_dir.join(format!("rollout-a-{SESSION_ID}.jsonl"));
        create_file(&matching_jsonl);

        let output = run_cleanup_with_session_id(
            &codex_home,
            &restore_path,
            &SESSION_ID.to_ascii_uppercase(),
        );

        assert_success(&output);
        assert!(!matching_jsonl.exists());
    }

    #[test]
    fn cleanup_script_rejects_restore_path_outside_sessions_root() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        fs::create_dir_all(codex_home.join("sessions")).unwrap();
        let outside_restore_path = temp
            .path()
            .join(format!("outside/rollout-{SESSION_ID}.jsonl"));

        let output = run_cleanup(&codex_home, &outside_restore_path);

        assert_failure_contains(&output, "invalid codex restore directory");
    }

    #[test]
    fn cleanup_script_rejects_symlink_codex_home() {
        let temp = tempfile::tempdir().unwrap();
        let real_codex_home = temp.path().join("real-codex");
        let codex_home = temp.path().join(".codex");
        fs::create_dir_all(real_codex_home.join("sessions/2026/06/04")).unwrap();
        symlink(&real_codex_home, &codex_home).unwrap();
        let restore_path = restore_path(&codex_home);

        let output = run_cleanup(&codex_home, &restore_path);

        assert_failure_contains(&output, "codex restore directory is a symlink");
    }

    #[test]
    fn cleanup_script_rejects_non_directory_restore_component() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let root = codex_home.join("sessions");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("2026"), "not a directory").unwrap();
        let restore_path = restore_path(&codex_home);

        let output = run_cleanup(&codex_home, &restore_path);

        assert_failure_contains(&output, "codex restore path component is not a directory");
    }

    #[test]
    fn cleanup_script_succeeds_when_sessions_root_is_missing() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        fs::create_dir_all(&codex_home).unwrap();
        let restore_path = restore_path(&codex_home);

        let output = run_cleanup(&codex_home, &restore_path);

        assert_success(&output);
    }

    #[test]
    fn cleanup_script_rejects_restore_path_without_date_depth() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let root = codex_home.join("sessions");
        fs::create_dir_all(&root).unwrap();
        let shallow_restore_path = root.join(format!("rollout-{SESSION_ID}.jsonl"));

        let output = run_cleanup(&codex_home, &shallow_restore_path);

        assert_failure_contains(&output, "invalid codex restore directory");
    }

    #[test]
    fn cleanup_script_rejects_empty_session_id_without_deleting_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let restore_path = restore_path(&codex_home);
        let restore_dir = restore_path.parent().unwrap();
        fs::create_dir_all(restore_dir).unwrap();
        let existing_session = restore_dir.join("rollout-existing-session.jsonl");
        create_file(&existing_session);

        let output = run_cleanup_with_session_id(&codex_home, &restore_path, "");

        assert_failure_contains(&output, "invalid codex restore session id");
        assert!(existing_session.exists());
    }

    #[test]
    fn cleanup_script_rejects_glob_session_id_without_deleting_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let restore_path = restore_path(&codex_home);
        let restore_dir = restore_path.parent().unwrap();
        fs::create_dir_all(restore_dir).unwrap();
        let existing_session = restore_dir.join("rollout-existing-session.jsonl");
        create_file(&existing_session);

        let output = run_cleanup_with_session_id(&codex_home, &restore_path, "*");

        assert_failure_contains(&output, "invalid codex restore session id");
        assert!(existing_session.exists());
    }
}
