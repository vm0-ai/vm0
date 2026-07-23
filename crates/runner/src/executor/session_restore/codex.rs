use std::time::Duration;

use guest_contracts::codex_thread_id::CodexThreadId;
use guest_contracts::codex_thread_path::{
    CODEX_THREAD_PATH_LOOKUP_REPORT_MAX_BYTES, CodexThreadPathLookupReport,
};
use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecOutputLimits, ExecRequest, Sandbox};
use shell_quote::quote_shell_arg;
use tracing::info;

use super::{MaterializedResumeSession, SessionRestoreDiagnostics, write_session_history_file};
use crate::helper_exec::{format_helper_exec_failure, helper_exec_succeeded};
use crate::paths::guest;
use crate::types::{ExecutionContext, SandboxReuseResult};

use super::super::{DEFAULT_EXEC_TIMEOUT, RunnerError, RunnerResult};

const CODEX_HOME: &str = "/home/user/.codex";
const CODEX_SESSIONS_ROOT: &str = "/home/user/.codex/sessions";
const CODEX_SESSION_RESTORE_SCRIPT: &str =
    include_str!("../../../scripts/codex-session-restore.sh");
const CODEX_THREAD_PATH_LOOKUP_TIMEOUT: Duration = Duration::from_secs(20);
const CODEX_THREAD_PATH_LOOKUP_OUTPUT_LIMITS: ExecOutputLimits = ExecOutputLimits::separate(
    CODEX_THREAD_PATH_LOOKUP_REPORT_MAX_BYTES as u32 + 1,
    8 * 1024,
);
const ROLLOUT_PREFIX: &str = "rollout-";
const LOGICAL_EXTENSION: &str = ".jsonl";
const TIMESTAMP_LEN: usize = 19;

#[derive(Clone, Debug, Eq, PartialEq)]
struct CodexRolloutPath {
    logical: String,
}

impl CodexRolloutPath {
    fn parse(raw: &str, thread_id: &CodexThreadId) -> Option<Self> {
        let relative = raw.strip_prefix(&format!("{CODEX_SESSIONS_ROOT}/"))?;
        let [year, month, day, file_name] = exact_path_components(relative)?;
        if raw != format!("{CODEX_SESSIONS_ROOT}/{year}/{month}/{day}/{file_name}") {
            return None;
        }

        let timestamp_and_thread = file_name
            .strip_prefix(ROLLOUT_PREFIX)?
            .strip_suffix(LOGICAL_EXTENSION)?;
        let expected_thread_suffix = format!("-{}", thread_id.as_str());
        let timestamp = timestamp_and_thread.strip_suffix(&expected_thread_suffix)?;
        if timestamp.len() != TIMESTAMP_LEN
            || !valid_timestamp(timestamp)
            || timestamp.get(..10)? != format!("{year}-{month}-{day}")
        {
            return None;
        }

        Some(Self {
            logical: raw.to_string(),
        })
    }

    fn physical_path(&self, zstd: bool) -> String {
        if zstd {
            format!("{}.zst", self.logical)
        } else {
            self.logical.clone()
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CodexRolloutPathSource {
    CodexIndex,
    ReusedFallback,
    NonReusedFallback,
}

impl CodexRolloutPathSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::CodexIndex => "codex-index",
            Self::ReusedFallback => "reused-fallback",
            Self::NonReusedFallback => "non-reused-fallback",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CodexRestorePhase {
    Prepare,
    Commit,
}

impl CodexRestorePhase {
    fn mode(self) -> &'static str {
        match self {
            Self::Prepare => "prepare",
            Self::Commit => "commit",
        }
    }

    fn diagnostic_label(self) -> &'static str {
        match self {
            Self::Prepare => "codex-session-restore-prepare",
            Self::Commit => "codex-session-restore-commit",
        }
    }

    fn operation(self) -> &'static str {
        match self {
            Self::Prepare => "codex session restore prepare",
            Self::Commit => "codex session restore commit",
        }
    }
}

struct CodexRestoreRequest<'a> {
    session_id: &'a str,
    session_filename_key: &'a str,
    session_path: &'a str,
    staging_path: &'a str,
}

fn codex_fallback_rollout_path(
    session_id: &str,
    timestamp: chrono::DateTime<chrono::Utc>,
) -> CodexRolloutPath {
    CodexRolloutPath {
        logical: format!(
            "{CODEX_SESSIONS_ROOT}/{}/{}/{}/rollout-{}-{session_id}.jsonl",
            timestamp.format("%Y"),
            timestamp.format("%m"),
            timestamp.format("%d"),
            timestamp.format("%Y-%m-%dT%H-%M-%S"),
        ),
    }
}

fn codex_restore_rollout_timestamp(
    session: &MaterializedResumeSession,
    fallback_timestamp: chrono::DateTime<chrono::Utc>,
) -> chrono::DateTime<chrono::Utc> {
    session.codex_timestamp().unwrap_or(fallback_timestamp)
}

/// Restore Codex history at Codex's indexed logical rollout path in a reused
/// sandbox, or at a canonical timestamp-derived path when no local Codex index
/// entry exists. Native zstd history uses the logical path's `.zst` sibling.
///
/// Codex filters filesystem resume candidates through its canonical
/// rollout filename parser, so a bare `{thread_id}.jsonl` is ignored.
pub(super) async fn restore_codex_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &MaterializedResumeSession,
    reuse_result: SandboxReuseResult,
) -> RunnerResult<SessionRestoreDiagnostics> {
    let original_session_id = session.cli_agent_session_id();
    let thread_id = CodexThreadId::parse(original_session_id)
        .ok_or_else(|| RunnerError::Internal("invalid codex session_id".into()))?;
    let session_id = thread_id.as_str();
    let session_filename_key = thread_id.filename_key();

    let timestamp = codex_restore_rollout_timestamp(session, chrono::Utc::now());
    let fallback_path = codex_fallback_rollout_path(session_id, timestamp);
    let (rollout_path, path_source) = if reuse_result == SandboxReuseResult::Reused {
        match lookup_codex_rollout_path(sandbox, &thread_id).await? {
            Some(path) => (path, CodexRolloutPathSource::CodexIndex),
            None => (fallback_path, CodexRolloutPathSource::ReusedFallback),
        }
    } else {
        (fallback_path, CodexRolloutPathSource::NonReusedFallback)
    };

    let (session_history, zstd) = if let Some(bytes) = session.codex_zstd_history() {
        (bytes, true)
    } else {
        (session.history_bytes(), false)
    };
    let session_path = rollout_path.physical_path(zstd);
    let staging_path = format!("{session_path}.vm0tmp-{}", context.run_id);
    let restore = CodexRestoreRequest {
        session_id,
        session_filename_key: &session_filename_key,
        session_path: &session_path,
        staging_path: &staging_path,
    };

    run_codex_restore_script(sandbox, CodexRestorePhase::Prepare, &restore).await?;

    write_session_history_file(sandbox, &staging_path, session_history).await?;

    run_codex_restore_script(sandbox, CodexRestorePhase::Commit, &restore).await?;

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
        destination_source = path_source.as_str(),
        "restored session history",
    );
    Ok(diagnostics)
}

async fn lookup_codex_rollout_path(
    sandbox: &dyn Sandbox,
    thread_id: &CodexThreadId,
) -> RunnerResult<Option<CodexRolloutPath>> {
    let command = [
        quote_shell_arg(guest::RUN_AGENT),
        "resolve-codex-rollout-path".to_string(),
        quote_shell_arg(thread_id.as_str()),
    ]
    .join(" ");
    let result = sandbox
        .exec_with_diagnostic_label(
            &ExecRequest {
                cmd: &command,
                timeout: CODEX_THREAD_PATH_LOOKUP_TIMEOUT,
                env: &[],
                sudo: false,
                expected_exit_codes: &[],
                stdin_bytes: None,
                output_limits: CODEX_THREAD_PATH_LOOKUP_OUTPUT_LIMITS,
            },
            "codex-thread-path-lookup",
        )
        .await?;
    if !helper_exec_succeeded(&result) {
        return Err(RunnerError::Internal(format_helper_exec_failure(
            "codex thread path lookup",
            &result,
        )));
    }
    let report_bytes = result.stdout.strip_suffix(b"\n").unwrap_or(&result.stdout);
    if result.stdout_truncated || report_bytes.len() > CODEX_THREAD_PATH_LOOKUP_REPORT_MAX_BYTES {
        return Err(RunnerError::Internal(
            "codex thread path lookup returned an oversized report".into(),
        ));
    }
    let report =
        serde_json::from_slice::<CodexThreadPathLookupReport>(report_bytes).map_err(|_| {
            RunnerError::Internal("codex thread path lookup returned an invalid report".into())
        })?;
    match report {
        CodexThreadPathLookupReport::Found { path } => CodexRolloutPath::parse(&path, thread_id)
            .map(Some)
            .ok_or_else(|| RunnerError::Internal("invalid codex rollout path".into())),
        CodexThreadPathLookupReport::NotFound {} => Ok(None),
    }
}

async fn run_codex_restore_script(
    sandbox: &dyn Sandbox,
    phase: CodexRestorePhase,
    restore: &CodexRestoreRequest<'_>,
) -> RunnerResult<()> {
    let command = codex_session_restore_command(CODEX_HOME);
    let env = [
        ("VM0_CODEX_RESTORE_MODE", phase.mode()),
        ("VM0_CODEX_RESTORE_SESSION_ID", restore.session_id),
        (
            "VM0_CODEX_RESTORE_SESSION_FILENAME_KEY",
            restore.session_filename_key,
        ),
        ("VM0_CODEX_RESTORE_SESSION_PATH", restore.session_path),
        ("VM0_CODEX_RESTORE_STAGING_PATH", restore.staging_path),
    ];
    let result = sandbox
        .exec_with_diagnostic_label(
            &ExecRequest {
                cmd: &command,
                timeout: DEFAULT_EXEC_TIMEOUT,
                env: &env,
                sudo: false,
                expected_exit_codes: &[],
                stdin_bytes: None,
                output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
            },
            phase.diagnostic_label(),
        )
        .await?;
    if !helper_exec_succeeded(&result) {
        return Err(RunnerError::Internal(format_helper_exec_failure(
            phase.operation(),
            &result,
        )));
    }
    Ok(())
}

fn codex_session_restore_command(codex_home: &str) -> String {
    let codex_home = quote_shell_arg(codex_home);
    format!("codex_home={codex_home}\n{CODEX_SESSION_RESTORE_SCRIPT}")
}

fn exact_path_components(raw: &str) -> Option<[&str; 4]> {
    let mut components = raw.split('/');
    let parsed = [
        components.next()?,
        components.next()?,
        components.next()?,
        components.next()?,
    ];
    if components.next().is_some()
        || parsed
            .iter()
            .any(|component| component.is_empty() || matches!(*component, "." | ".."))
    {
        return None;
    }
    Some(parsed)
}

fn valid_timestamp(timestamp: &str) -> bool {
    chrono::NaiveDateTime::parse_from_str(timestamp, "%Y-%m-%dT%H-%M-%S").is_ok()
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

    fn staging_path(restore_path: &Path) -> PathBuf {
        PathBuf::from(format!("{}.vm0tmp-test", restore_path.display()))
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
        let staging_path = staging_path(restore_path);
        if staging_path.parent().is_some_and(Path::is_dir) {
            fs::write(&staging_path, "replacement").unwrap();
        }
        cleanup_command(codex_home, restore_path, session_id, session_filename_key)
            .output()
            .unwrap()
    }

    fn run_cleanup_with_budget(codex_home: &Path, restore_path: &Path, budget: &str) -> Output {
        fs::write(staging_path(restore_path), "replacement").unwrap();
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
        let staging_path = staging_path(restore_path);
        command
            .arg("-c")
            .arg(codex_session_restore_command(
                codex_home.to_str().expect("test path should be utf-8"),
            ))
            .env("VM0_CODEX_RESTORE_MODE", "commit")
            .env("VM0_CODEX_RESTORE_SESSION_ID", session_id)
            .env(
                "VM0_CODEX_RESTORE_SESSION_FILENAME_KEY",
                session_filename_key,
            )
            .env(
                "VM0_CODEX_RESTORE_SESSION_PATH",
                restore_path.to_str().expect("test path should be utf-8"),
            )
            .env(
                "VM0_CODEX_RESTORE_STAGING_PATH",
                staging_path.to_str().expect("test path should be utf-8"),
            );
        command
    }

    fn prepare_command(codex_home: &Path, restore_path: &Path) -> Command {
        let mut command =
            cleanup_command(codex_home, restore_path, SESSION_ID, SESSION_ID_NO_DASHES);
        command.env("VM0_CODEX_RESTORE_MODE", "prepare");
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
        let command = codex_session_restore_command(CODEX_HOME);

        assert!(command.contains("codex_home='/home/user/.codex'"));
        assert!(command.contains("root=\"$codex_home/sessions\""));
        assert!(command.contains("scan_budget="));
        assert!(command.contains("find \"$root\" -mindepth 1 -print0"));
        assert!(command.contains("xargs -0"));
        assert!(command.contains("prepare|commit"));
        assert!(command.contains("mv -fT"));
        assert!(!command.contains("-delete"));
        assert!(!command.contains("for path in \"$dir\"/*"));
    }

    #[test]
    fn restore_prepare_rejects_existing_staging_without_touching_target() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let restore_path = restore_path(&codex_home);
        let staging_path = staging_path(&restore_path);
        create_file(&restore_path);
        fs::write(&restore_path, "original").unwrap();
        create_file(&staging_path);

        let output = prepare_command(&codex_home, &restore_path)
            .output()
            .unwrap();

        assert_failure_contains(&output, "codex restore staging path already exists");
        assert_eq!(fs::read_to_string(&restore_path).unwrap(), "original");
        assert!(staging_path.is_file());
    }

    #[test]
    fn restore_prepare_rejects_symlink_target() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let restore_path = restore_path(&codex_home);
        let unrelated = temp.path().join("unrelated");
        create_file(&unrelated);
        fs::create_dir_all(restore_path.parent().unwrap()).unwrap();
        symlink(&unrelated, &restore_path).unwrap();

        let output = prepare_command(&codex_home, &restore_path)
            .output()
            .unwrap();

        assert_failure_contains(&output, "codex restore target is a symlink");
        assert_eq!(fs::read_to_string(&unrelated).unwrap(), "test");
    }

    #[test]
    fn restore_commit_rejects_symlink_staging_without_touching_target() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let restore_path = restore_path(&codex_home);
        let staging_path = staging_path(&restore_path);
        let unrelated = temp.path().join("unrelated");
        create_file(&restore_path);
        fs::write(&restore_path, "original").unwrap();
        create_file(&unrelated);
        symlink(&unrelated, &staging_path).unwrap();

        let output = cleanup_command(&codex_home, &restore_path, SESSION_ID, SESSION_ID_NO_DASHES)
            .output()
            .unwrap();

        assert_failure_contains(&output, "codex restore staging path is a symlink");
        assert_eq!(fs::read_to_string(&restore_path).unwrap(), "original");
        assert_eq!(fs::read_to_string(&unrelated).unwrap(), "test");
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
        assert!(!matching_jsonl.exists());
        assert!(!matching_zst.exists());
        assert!(!matching_tmp.exists());
        assert!(!matching_no_dash.exists());
        assert!(!matching_newline.exists());
        assert!(!matching_non_layout.exists());
        assert!(!matching_symlink.exists());
        assert!(matching_directory.exists());
        assert!(unrelated.exists());
        assert_eq!(fs::read_to_string(&restore_path).unwrap(), "replacement");
    }

    #[test]
    fn cleanup_script_fails_when_scan_budget_exceeded_without_deleting_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let restore_path = restore_path(&codex_home);
        let restore_dir = restore_path.parent().unwrap();
        fs::create_dir_all(restore_dir).unwrap();
        let matching_jsonl = restore_dir.join(format!("rollout-a-{SESSION_ID}.jsonl"));
        fs::write(&restore_path, "original").unwrap();
        create_file(&matching_jsonl);

        let output = run_cleanup_with_budget(&codex_home, &restore_path, "1");

        assert_failure_contains(&output, "codex session cleanup exceeded scan budget");
        assert!(matching_jsonl.exists());
        assert_eq!(fs::read_to_string(&restore_path).unwrap(), "original");
        assert!(staging_path(&restore_path).is_file());
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
        create_file(&staging_path(&restore_path));

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

        let output = prepare_command(&codex_home, &restore_path)
            .env("TMPDIR", temp.path().join("missing-tmp"))
            .output()
            .unwrap();

        assert_success(&output);
        assert!(restore_path.parent().unwrap().is_dir());
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
    fn cleanup_script_rejects_restore_path_with_extra_date_depth() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let restore_path = codex_home
            .join("sessions/2026/06/04/extra")
            .join(format!("rollout-2026-06-04T07-18-08-{SESSION_ID}.jsonl"));

        let output = run_cleanup(&codex_home, &restore_path);

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
