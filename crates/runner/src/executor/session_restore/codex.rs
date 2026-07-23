use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecResult, Sandbox};
use shell_quote::quote_shell_arg;
use tracing::info;

use super::{MaterializedResumeSession, SessionRestoreDiagnostics, write_session_history_file};
use crate::helper_exec::{format_helper_exec_failure, helper_exec_succeeded};
use crate::types::ExecutionContext;

use super::super::{DEFAULT_EXEC_TIMEOUT, RunnerError, RunnerResult};
use guest_contracts::codex_thread_id::CodexThreadId;

const CODEX_HOME: &str = "/home/user/.codex";
const CODEX_SESSIONS_ROOT: &str = "/home/user/.codex/sessions";
const CODEX_SESSION_CLEANUP_SCRIPT: &str =
    include_str!("../../../scripts/codex-session-cleanup.sh");
const INVALID_CODEX_CLEANUP_OUTPUT: &str = "invalid codex session cleanup output";

fn codex_restore_logical_rollout_path(
    session_id: &str,
    timestamp: chrono::DateTime<chrono::Utc>,
) -> String {
    format!(
        "{CODEX_HOME}/sessions/{}/{}/{}/rollout-{}-{session_id}.jsonl",
        timestamp.format("%Y"),
        timestamp.format("%m"),
        timestamp.format("%d"),
        timestamp.format("%Y-%m-%dT%H-%M-%S"),
    )
}

fn codex_restore_rollout_timestamp(
    session: &MaterializedResumeSession,
    fallback_timestamp: chrono::DateTime<chrono::Utc>,
) -> chrono::DateTime<chrono::Utc> {
    session.codex_timestamp().unwrap_or(fallback_timestamp)
}

/// Write a Codex session history file as canonical JSONL or zstd-compressed
/// JSONL under
/// `~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-{thread_id}.jsonl[.zst]`.
///
/// Codex 0.137 filters filesystem resume candidates through its canonical
/// rollout filename parser, so a bare `{thread_id}.jsonl` is ignored.
pub(super) async fn restore_codex_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &MaterializedResumeSession,
) -> RunnerResult<SessionRestoreDiagnostics> {
    let original_session_id = session.cli_agent_session_id();
    let thread_id = CodexThreadId::parse(original_session_id)
        .ok_or_else(|| RunnerError::Internal("invalid codex session_id".into()))?;
    let session_id = thread_id.as_str();
    let session_filename_key = thread_id.filename_key();

    let timestamp = codex_restore_rollout_timestamp(session, chrono::Utc::now());
    let (session_history, physical_suffix) = if let Some(bytes) = session.codex_zstd_history() {
        (bytes, ".zst")
    } else {
        (session.history_bytes(), "")
    };
    let fallback_logical_path = codex_restore_logical_rollout_path(session_id, timestamp);

    let logical_path = cleanup_existing_codex_session_files(
        sandbox,
        context,
        session_id,
        &session_filename_key,
        &fallback_logical_path,
    )
    .await?
    .unwrap_or(fallback_logical_path);
    let session_path = format!("{logical_path}{physical_suffix}");

    write_session_history_file(sandbox, &session_path, session_history).await?;

    let diagnostics = SessionRestoreDiagnostics {
        framework: "codex",
        session_id: session_id.to_string(),
        bytes_in: session_history.len(),
    };
    info!(
        run_id = %context.run_id,
        framework = diagnostics.framework,
        session_id = %diagnostics.session_id,
        bytes_in = diagnostics.bytes_in,
        "restored session history",
    );
    Ok(diagnostics)
}

async fn cleanup_existing_codex_session_files(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session_id: &str,
    session_filename_key: &str,
    fallback_logical_path: &str,
) -> RunnerResult<Option<String>> {
    let cleanup_cmd = codex_session_cleanup_command(CODEX_HOME);
    let env = [
        ("VM0_CODEX_RESTORE_SESSION_ID", session_id),
        (
            "VM0_CODEX_RESTORE_SESSION_FILENAME_KEY",
            session_filename_key,
        ),
        ("VM0_CODEX_RESTORE_SESSION_PATH", fallback_logical_path),
    ];
    let result = sandbox
        .exec_with_diagnostic_label(
            &ExecRequest {
                cmd: &cleanup_cmd,
                timeout: DEFAULT_EXEC_TIMEOUT,
                env: &env,
                sudo: false,
                expected_exit_codes: &[],
                stdin_bytes: None,
                output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
            },
            "codex-session-cleanup",
        )
        .await?;
    if !helper_exec_succeeded(&result) {
        return Err(RunnerError::Internal(format_helper_exec_failure(
            "codex session cleanup",
            &result,
        )));
    }
    info!(
        run_id = %context.run_id,
        session_id = %session_id,
        "cleaned up existing codex session files before restore",
    );
    parse_codex_cleanup_output(&result, session_id)
}

fn parse_codex_cleanup_output(
    result: &ExecResult,
    session_id: &str,
) -> RunnerResult<Option<String>> {
    // Helper stdout crosses the guest trust boundary and becomes a write
    // destination, so validate it independently of the shell classifier.
    if result.stdout_truncated {
        return Err(RunnerError::Internal(INVALID_CODEX_CLEANUP_OUTPUT.into()));
    }
    if result.stdout.is_empty() {
        return Ok(None);
    }
    let output = std::str::from_utf8(&result.stdout)
        .map_err(|_| RunnerError::Internal(INVALID_CODEX_CLEANUP_OUTPUT.into()))?;
    let path = output
        .strip_suffix('\n')
        .filter(|path| !path.is_empty() && !path.contains(['\r', '\n']))
        .filter(|path| is_canonical_codex_logical_path(path, session_id))
        .ok_or_else(|| RunnerError::Internal(INVALID_CODEX_CLEANUP_OUTPUT.into()))?;
    Ok(Some(path.to_string()))
}

fn is_canonical_codex_logical_path(path: &str, session_id: &str) -> bool {
    let Some(relative) = path
        .strip_prefix(CODEX_SESSIONS_ROOT)
        .and_then(|path| path.strip_prefix('/'))
    else {
        return false;
    };
    let mut components = relative.split('/');
    let (Some(year), Some(month), Some(day), Some(filename), None) = (
        components.next(),
        components.next(),
        components.next(),
        components.next(),
        components.next(),
    ) else {
        return false;
    };
    if !fixed_ascii_digits(year, 4) || !fixed_ascii_digits(month, 2) || !fixed_ascii_digits(day, 2)
    {
        return false;
    }
    let (Ok(year_number), Ok(month_number), Ok(day_number)) = (
        year.parse::<i32>(),
        month.parse::<u32>(),
        day.parse::<u32>(),
    ) else {
        return false;
    };
    if year_number < 1
        || chrono::NaiveDate::from_ymd_opt(year_number, month_number, day_number).is_none()
    {
        return false;
    }

    let prefix = format!("rollout-{year}-{month}-{day}T");
    let suffix = format!("-{session_id}.jsonl");
    let Some(time) = filename
        .strip_prefix(&prefix)
        .and_then(|filename| filename.strip_suffix(&suffix))
    else {
        return false;
    };
    let mut time_components = time.split('-');
    let (Some(hour), Some(minute), Some(second), None) = (
        time_components.next(),
        time_components.next(),
        time_components.next(),
        time_components.next(),
    ) else {
        return false;
    };
    if !fixed_ascii_digits(hour, 2)
        || !fixed_ascii_digits(minute, 2)
        || !fixed_ascii_digits(second, 2)
    {
        return false;
    }
    let (Ok(hour), Ok(minute), Ok(second)) = (
        hour.parse::<u32>(),
        minute.parse::<u32>(),
        second.parse::<u32>(),
    ) else {
        return false;
    };
    hour <= 23 && minute <= 59 && second <= 59
}

fn fixed_ascii_digits(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn codex_session_cleanup_command(codex_home: &str) -> String {
    let codex_home = quote_shell_arg(codex_home);
    format!("codex_home={codex_home}\n{CODEX_SESSION_CLEANUP_SCRIPT}")
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};
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

    fn canonical_path(codex_home: &Path, date: &str, time: &str) -> PathBuf {
        let mut date_components = date.split('-');
        let year = date_components.next().unwrap();
        let month = date_components.next().unwrap();
        let day = date_components.next().unwrap();
        assert!(date_components.next().is_none());
        codex_home.join(format!(
            "sessions/{year}/{month}/{day}/rollout-{date}T{time}-{SESSION_ID}.jsonl"
        ))
    }

    fn run_cleanup(codex_home: &Path, restore_path: &Path) -> Output {
        run_cleanup_with_session_id(codex_home, restore_path, SESSION_ID)
    }

    fn run_cleanup_with_session_id(
        codex_home: &Path,
        restore_path: &Path,
        session_id: &str,
    ) -> Output {
        let session_filename_key = session_id.replace('-', "");
        run_cleanup_with_session_identity(
            codex_home,
            restore_path,
            session_id,
            &session_filename_key,
        )
    }

    fn run_cleanup_with_session_identity(
        codex_home: &Path,
        restore_path: &Path,
        session_id: &str,
        session_filename_key: &str,
    ) -> Output {
        cleanup_command(codex_home, restore_path, session_id, session_filename_key)
            .output()
            .unwrap()
    }

    fn run_cleanup_with_budget(codex_home: &Path, restore_path: &Path, budget: &str) -> Output {
        cleanup_command(codex_home, restore_path, SESSION_ID, SESSION_ID_NO_DASHES)
            .env("VM0_CODEX_SESSION_CLEANUP_SCAN_BUDGET", budget)
            .output()
            .unwrap()
    }

    fn cleanup_command(
        codex_home: &Path,
        restore_path: &Path,
        session_id: &str,
        session_filename_key: &str,
    ) -> Command {
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(codex_session_cleanup_command(
                codex_home.to_str().expect("test path should be utf-8"),
            ))
            .env("VM0_CODEX_RESTORE_SESSION_ID", session_id)
            .env(
                "VM0_CODEX_RESTORE_SESSION_FILENAME_KEY",
                session_filename_key,
            )
            .env(
                "VM0_CODEX_RESTORE_SESSION_PATH",
                restore_path.to_str().expect("test path should be utf-8"),
            );
        command
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
        assert!(command.contains("scan_budget="));
        assert!(command.contains("collect_matching_session_entries"));
        assert!(command.contains("find \"$root\" -mindepth 1 -printf '%y%p\\0'"));
        assert!(command.contains("canonical_logical_path"));
        assert!(command.contains("candidate_ambiguous"));
        assert!(command.contains("delete_matching_session_entries"));
        assert!(command.contains("xargs -0"));
        assert!(!command.contains("-delete"));
        assert!(!command.contains("for path in \"$dir\"/*"));
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
        let matching_newline = restore_dir.join(format!("rollout-line\nbreak-{SESSION_ID}.jsonl"));
        let matching_non_layout = codex_home
            .join("sessions/not-layout/deep")
            .join(format!("rollout-c-{SESSION_ID}.jsonl"));
        let matching_symlink = restore_dir.join(format!("rollout-link-{SESSION_ID}.jsonl"));
        let matching_directory = restore_dir.join(format!("rollout-dir-{SESSION_ID}.jsonl"));
        let unrelated = restore_dir.join("rollout-other-session.jsonl");

        create_file(&matching_jsonl);
        create_file(&matching_zst);
        create_file(&matching_tmp);
        create_file(&matching_no_dash);
        create_file(&matching_newline);
        create_file(&matching_non_layout);
        create_file(&unrelated);
        fs::create_dir(&matching_directory).unwrap();
        symlink(&unrelated, &matching_symlink).unwrap();

        let output = run_cleanup(&codex_home, &restore_path);

        assert_success(&output);
        assert!(output.stdout.is_empty());
        assert!(!matching_jsonl.exists());
        assert!(!matching_zst.exists());
        assert!(!matching_tmp.exists());
        assert!(!matching_no_dash.exists());
        assert!(!matching_newline.exists());
        assert!(!matching_non_layout.exists());
        assert!(!matching_symlink.exists());
        assert!(matching_directory.exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn cleanup_script_returns_existing_canonical_logical_path() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let fallback_path = restore_path(&codex_home);
        let existing_path = canonical_path(&codex_home, "2026-07-23", "04-01-04");
        create_file(&existing_path);

        let output = run_cleanup(&codex_home, &fallback_path);

        assert_success(&output);
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("{}\n", existing_path.display())
        );
        assert!(!existing_path.exists());
    }

    #[test]
    fn cleanup_script_normalizes_existing_zstd_path_to_logical_path() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let fallback_path = restore_path(&codex_home);
        let logical_path = canonical_path(&codex_home, "2026-07-23", "04-01-04");
        let compressed_path = PathBuf::from(format!("{}.zst", logical_path.display()));
        create_file(&compressed_path);

        let output = run_cleanup(&codex_home, &fallback_path);

        assert_success(&output);
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("{}\n", logical_path.display())
        );
        assert!(!compressed_path.exists());
    }

    #[test]
    fn cleanup_script_treats_raw_and_zstd_siblings_as_one_logical_path() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let fallback_path = restore_path(&codex_home);
        let logical_path = canonical_path(&codex_home, "2026-07-23", "04-01-04");
        let compressed_path = PathBuf::from(format!("{}.zst", logical_path.display()));
        create_file(&logical_path);
        create_file(&compressed_path);

        let output = run_cleanup(&codex_home, &fallback_path);

        assert_success(&output);
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("{}\n", logical_path.display())
        );
        assert!(!logical_path.exists());
        assert!(!compressed_path.exists());
    }

    #[test]
    fn cleanup_script_rejects_distinct_canonical_paths_without_deleting_them() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let fallback_path = restore_path(&codex_home);
        let first_path = canonical_path(&codex_home, "2026-07-23", "04-01-04");
        let second_path = canonical_path(&codex_home, "2026-07-24", "05-02-05");
        create_file(&first_path);
        create_file(&second_path);

        let output = run_cleanup(&codex_home, &fallback_path);

        assert_failure_contains(&output, "ambiguous codex session restore path");
        assert!(output.stdout.is_empty());
        assert!(first_path.exists());
        assert!(second_path.exists());
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(!stderr.contains(first_path.to_str().unwrap()));
        assert!(!stderr.contains(second_path.to_str().unwrap()));
    }

    #[test]
    fn cleanup_script_does_not_disclose_candidate_when_deletion_fails() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let fallback_path = restore_path(&codex_home);
        let existing_path = canonical_path(&codex_home, "2026-07-23", "04-01-04");
        create_file(&existing_path);

        let fake_bin = temp.path().join("fake-bin");
        fs::create_dir(&fake_bin).unwrap();
        let fake_rm = fake_bin.join("rm");
        fs::write(&fake_rm, "#!/bin/sh\nprintf '%s\\n' \"$*\" >&2\nexit 1\n").unwrap();
        let mut permissions = fs::metadata(&fake_rm).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_rm, permissions).unwrap();
        let path = format!("{}:{}", fake_bin.display(), std::env::var("PATH").unwrap());

        let output = cleanup_command(
            &codex_home,
            &fallback_path,
            SESSION_ID,
            SESSION_ID_NO_DASHES,
        )
        .env("PATH", path)
        .output()
        .unwrap();

        assert_failure_contains(&output, "failed to delete codex session files");
        assert!(output.stdout.is_empty());
        assert!(existing_path.exists());
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(!stderr.contains(existing_path.to_str().unwrap()));
    }

    #[test]
    fn cleanup_script_does_not_select_noncanonical_date_or_time() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let fallback_path = restore_path(&codex_home);
        let invalid_date = canonical_path(&codex_home, "2026-02-31", "04-01-04");
        let invalid_time = canonical_path(&codex_home, "2026-07-23", "24-01-04");
        create_file(&invalid_date);
        create_file(&invalid_time);

        let output = run_cleanup(&codex_home, &fallback_path);

        assert_success(&output);
        assert!(output.stdout.is_empty());
        assert!(!invalid_date.exists());
        assert!(!invalid_time.exists());
    }

    #[test]
    fn cleanup_script_does_not_follow_symlinked_date_directory() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let fallback_path = restore_path(&codex_home);
        let external_root = temp.path().join("external");
        let external_path = canonical_path(&external_root, "2026-07-23", "04-01-04");
        create_file(&external_path);
        let sessions_year = codex_home.join("sessions/2026");
        fs::create_dir_all(&sessions_year).unwrap();
        symlink(
            external_root.join("sessions/2026/07"),
            sessions_year.join("07"),
        )
        .unwrap();

        let output = run_cleanup(&codex_home, &fallback_path);

        assert_success(&output);
        assert!(output.stdout.is_empty());
        assert!(external_path.exists());
    }

    #[test]
    fn cleanup_script_does_not_select_canonical_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let fallback_path = restore_path(&codex_home);
        let symlink_path = canonical_path(&codex_home, "2026-07-23", "04-01-04");
        let target = temp.path().join("target.jsonl");
        create_file(&target);
        fs::create_dir_all(symlink_path.parent().unwrap()).unwrap();
        symlink(&target, &symlink_path).unwrap();

        let output = run_cleanup(&codex_home, &fallback_path);

        assert_success(&output);
        assert!(output.stdout.is_empty());
        assert!(!symlink_path.exists());
        assert!(target.exists());
    }

    #[test]
    fn cleanup_script_fails_when_scan_budget_exceeded_without_deleting_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let restore_path = restore_path(&codex_home);
        let restore_dir = restore_path.parent().unwrap();
        fs::create_dir_all(restore_dir).unwrap();
        let matching_jsonl = restore_dir.join(format!("rollout-a-{SESSION_ID}.jsonl"));
        create_file(&matching_jsonl);

        let output = run_cleanup_with_budget(&codex_home, &restore_path, "1");

        assert_failure_contains(&output, "codex session cleanup exceeded scan budget");
        assert!(matching_jsonl.exists());
    }

    #[test]
    fn cleanup_script_rejects_invalid_scan_budget_without_deleting_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let restore_path = restore_path(&codex_home);
        let restore_dir = restore_path.parent().unwrap();
        fs::create_dir_all(restore_dir).unwrap();
        let matching_jsonl = restore_dir.join(format!("rollout-a-{SESSION_ID}.jsonl"));
        create_file(&matching_jsonl);

        for budget in ["0", "1000000", "not-a-number"] {
            let output = run_cleanup_with_budget(&codex_home, &restore_path, budget);

            assert_failure_contains(&output, "invalid codex session cleanup scan budget");
            assert!(matching_jsonl.exists());
        }
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
    fn cleanup_script_rejects_failed_session_id_normalization_without_deleting_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let restore_path = restore_path(&codex_home);
        let restore_dir = restore_path.parent().unwrap();
        fs::create_dir_all(restore_dir).unwrap();
        let matching_jsonl = restore_dir.join(format!("rollout-a-{SESSION_ID}.jsonl"));
        create_file(&matching_jsonl);

        let fake_bin = temp.path().join("fake-bin");
        fs::create_dir(&fake_bin).unwrap();
        symlink("/bin/sh", fake_bin.join("sh")).unwrap();
        let fake_tr = fake_bin.join("tr");
        fs::write(&fake_tr, "#!/bin/sh\nexit 1\n").unwrap();
        let mut permissions = fs::metadata(&fake_tr).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_tr, permissions).unwrap();

        let output = cleanup_command(&codex_home, &restore_path, SESSION_ID, SESSION_ID_NO_DASHES)
            .env("PATH", &fake_bin)
            .output()
            .unwrap();

        assert_failure_contains(&output, "failed to normalize codex restore session id");
        assert!(matching_jsonl.exists());
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

        let output = cleanup_command(&codex_home, &restore_path, SESSION_ID, SESSION_ID_NO_DASHES)
            .env("TMPDIR", temp.path().join("missing-tmp"))
            .output()
            .unwrap();

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
    fn cleanup_script_rejects_invalid_session_id_with_valid_filename_key_without_deleting_sessions()
    {
        for invalid_session_id in ["", "*"] {
            let temp = tempfile::tempdir().unwrap();
            let codex_home = temp.path().join(".codex");
            let restore_path = restore_path(&codex_home);
            let restore_dir = restore_path.parent().unwrap();
            fs::create_dir_all(restore_dir).unwrap();
            let existing_session = restore_dir.join("rollout-existing-session.jsonl");
            create_file(&existing_session);

            let output = run_cleanup_with_session_identity(
                &codex_home,
                &restore_path,
                invalid_session_id,
                SESSION_ID_NO_DASHES,
            );

            assert_failure_contains(&output, "invalid codex restore session id");
            assert!(existing_session.exists());
        }
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
