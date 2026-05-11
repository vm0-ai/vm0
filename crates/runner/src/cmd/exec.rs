//! Execute a command inside a running VM for live debugging.

use std::io::Write;
use std::process::ExitCode;
use std::time::Duration;

use clap::Args;
use sandbox::{
    RemoteExecOutputSink, RemoteExecStatus, RemoteExecTermination, SandboxControl,
    SandboxControlError,
};

use crate::error::{RunnerError, RunnerResult};
use crate::process;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

/// Arguments for executing a command inside an already-running sandbox.
///
/// The target is selected with either `--run` or `--sandbox`. Command arguments
/// after `--` are preserved as argv entries before being quoted for guest-side
/// shell execution.
#[derive(Args)]
#[command(group = clap::ArgGroup::new("target").required(true))]
pub struct ExecArgs {
    /// Target by run ID (full UUID or prefix) — resolved to a sandbox
    /// via status.json. Use this when you have a job ID from the
    /// dashboard.
    #[arg(long, group = "target")]
    run: Option<String>,

    /// Target by sandbox ID (full UUID or prefix) — used directly as
    /// the socket directory name. Visible in `runner doctor` output.
    #[arg(long, group = "target")]
    sandbox: Option<String>,

    /// Timeout in seconds for the command
    #[arg(long, default_value = "30")]
    timeout: u32,

    /// Run the command with sudo inside the VM
    #[arg(long)]
    sudo: bool,

    /// Command to execute inside the VM (after `--`).
    ///
    /// Arguments are preserved as argv — pipes, redirects, globs, and
    /// variable expansion must be invoked explicitly via a shell:
    ///
    /// ```text
    /// runner exec --sandbox <id> -- sh -c 'ls /tmp | wc -l'
    /// ```
    #[arg(last = true, required = true)]
    command: Vec<String>,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// POSIX shell-quote a single argument so its boundary is preserved when the
/// resulting command string is re-parsed by `sh -c` on the guest.
///
/// Arguments consisting entirely of alphanumerics and a small safe punctuation
/// set (`_-./:+@%`) pass through unquoted for readability. Anything else is
/// wrapped in single quotes, with embedded `'` escaped as `'\''`.
///
/// Note: `=` is intentionally excluded so that an argv like `["FOO=bar", ...]`
/// is emitted as `'FOO=bar' ...` and the guest shell treats it as a command
/// name rather than a variable assignment.
fn shell_quote(arg: &str) -> String {
    let is_safe = !arg.is_empty()
        && arg.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(b, b'_' | b'-' | b'.' | b'/' | b':' | b'+' | b'@' | b'%')
        });
    if is_safe {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

/// Executes the requested command inside a running sandbox.
///
/// `--sandbox` targets are used directly as sandbox identifiers. `--run`
/// targets are resolved through the current runner process state before
/// dispatching to [`SandboxControl::exec_remote`].
///
/// Guest stdout and stderr are streamed to local stdout and stderr as chunks
/// arrive. The guest process exit code is converted to [`ExitCode`] by
/// truncating to `u8`, matching shell behavior for values outside the 0-255
/// range. If bounded streaming truncates output, the CLI prints a local warning
/// and treats a would-be successful remote exit as local failure.
///
/// [`SandboxControlError::Remote`] values are printed to stderr and returned
/// as [`ExitCode::FAILURE`]. Other sandbox-control errors are propagated as
/// [`RunnerError::Config`].
pub async fn run_exec(args: ExecArgs, control: &dyn SandboxControl) -> RunnerResult<ExitCode> {
    let mut stdout = std::io::stdout();
    let mut stderr = std::io::stderr();
    run_exec_with_writers(args, control, &mut stdout, &mut stderr).await
}

async fn run_exec_with_writers<WOut, WErr>(
    args: ExecArgs,
    control: &dyn SandboxControl,
    stdout: &mut WOut,
    stderr: &mut WErr,
) -> RunnerResult<ExitCode>
where
    WOut: Write + Send,
    WErr: Write + Send,
{
    // Resolve the target to a sandbox_id string.
    let sandbox_id = if let Some(ref sid) = args.sandbox {
        sid.clone()
    } else if let Some(ref rid) = args.run {
        let discovered = process::discover_all().await;
        let mappings = process::collect_active_run_mappings(&discovered.runners).await;
        process::resolve_run_to_sandbox(rid, &mappings)?
    } else {
        // clap group guarantees one is set — this branch is unreachable.
        return Err(RunnerError::Config(
            "one of --run or --sandbox is required".into(),
        ));
    };

    let command = args
        .command
        .iter()
        .map(|a| shell_quote(a))
        .collect::<Vec<_>>()
        .join(" ");
    let timeout = Duration::from_secs(u64::from(args.timeout));

    let mut output = WriterOutputSink { stdout, stderr };
    match control
        .exec_remote(&sandbox_id, &command, timeout, args.sudo, &mut output)
        .await
    {
        Ok(status) => status_to_exit_code(status, output.stderr),
        Err(SandboxControlError::Remote(msg)) => {
            writeln!(output.stderr, "error: {msg}")?;
            Ok(ExitCode::FAILURE)
        }
        Err(e) if is_broken_pipe_control_error(&e) => Ok(ExitCode::SUCCESS),
        Err(e) => Err(RunnerError::Config(e.to_string())),
    }
}

fn is_broken_pipe_control_error(error: &SandboxControlError) -> bool {
    matches!(error, SandboxControlError::Io(e) if e.kind() == std::io::ErrorKind::BrokenPipe)
}

struct WriterOutputSink<'a, WOut, WErr> {
    stdout: &'a mut WOut,
    stderr: &'a mut WErr,
}

impl<WOut, WErr> RemoteExecOutputSink for WriterOutputSink<'_, WOut, WErr>
where
    WOut: Write + Send,
    WErr: Write + Send,
{
    fn stdout(&mut self, chunk: &[u8]) -> std::io::Result<()> {
        self.stdout.write_all(chunk)
    }

    fn stderr(&mut self, chunk: &[u8]) -> std::io::Result<()> {
        self.stderr.write_all(chunk)
    }
}

fn status_to_exit_code(
    status: RemoteExecStatus,
    stderr: &mut impl Write,
) -> RunnerResult<ExitCode> {
    if status.stdout_truncated {
        writeln!(stderr, "runner exec: stdout truncated")?;
    }
    if status.stderr_truncated {
        writeln!(stderr, "runner exec: stderr truncated")?;
    }

    match status.termination {
        RemoteExecTermination::Exited { exit_code } => {
            if exit_code == 0 && (status.stdout_truncated || status.stderr_truncated) {
                Ok(ExitCode::FAILURE)
            } else {
                Ok(ExitCode::from(exit_code as u8))
            }
        }
        RemoteExecTermination::TimedOut => {
            writeln!(stderr, "error: command timed out")?;
            Ok(ExitCode::from(124))
        }
        RemoteExecTermination::Cancelled => {
            write_non_exit_error(stderr, "command cancelled", status.diagnostic.as_deref())?;
            Ok(ExitCode::FAILURE)
        }
        RemoteExecTermination::StartFailed => {
            write_non_exit_error(
                stderr,
                "command failed to start",
                status.diagnostic.as_deref(),
            )?;
            Ok(ExitCode::FAILURE)
        }
        RemoteExecTermination::WaitFailed => {
            write_non_exit_error(stderr, "command wait failed", status.diagnostic.as_deref())?;
            Ok(ExitCode::FAILURE)
        }
    }
}

fn write_non_exit_error(
    stderr: &mut impl Write,
    message: &str,
    diagnostic: Option<&str>,
) -> std::io::Result<()> {
    if let Some(diagnostic) = diagnostic {
        writeln!(stderr, "error: {message}: {diagnostic}")
    } else {
        writeln!(stderr, "error: {message}")
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use sandbox::SandboxControlError;
    use sandbox_mock::{MockRemoteExecOutput, MockRemoteExecResponse, MockSandboxControl};

    use super::*;

    fn make_args(sandbox_id: &str, command: &str) -> ExecArgs {
        ExecArgs {
            run: None,
            sandbox: Some(sandbox_id.into()),
            timeout: 5,
            sudo: false,
            command: command.split_whitespace().map(String::from).collect(),
        }
    }

    fn make_args_vec(command: Vec<&str>) -> ExecArgs {
        ExecArgs {
            run: None,
            sandbox: Some("id".into()),
            timeout: 5,
            sudo: false,
            command: command.into_iter().map(String::from).collect(),
        }
    }

    async fn run_exec_capture(
        args: ExecArgs,
        control: &dyn SandboxControl,
    ) -> RunnerResult<(ExitCode, Vec<u8>, Vec<u8>)> {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let code = run_exec_with_writers(args, control, &mut stdout, &mut stderr).await?;
        Ok((code, stdout, stderr))
    }

    #[tokio::test]
    async fn success_propagates_exit_code() {
        let control = MockSandboxControl::new("/tmp");
        control.push_exec_remote_response(MockRemoteExecResponse {
            output: vec![MockRemoteExecOutput::Stdout(b"hello\n".to_vec())],
            result: Ok(RemoteExecStatus::exited(42)),
        });

        let (result, stdout, stderr) =
            run_exec_capture(make_args("test-id", "echo hello"), &control)
                .await
                .unwrap();
        assert_eq!(result, ExitCode::from(42));
        assert_eq!(stdout, b"hello\n");
        assert!(stderr.is_empty());
    }

    #[tokio::test]
    async fn zero_exit_code_returns_success() {
        let control = MockSandboxControl::new("/tmp");
        let (result, stdout, stderr) = run_exec_capture(make_args("test-id", "true"), &control)
            .await
            .unwrap();
        assert_eq!(result, ExitCode::SUCCESS);
        assert!(stdout.is_empty());
        assert!(stderr.is_empty());
    }

    #[tokio::test]
    async fn remote_error_prints_message_and_returns_failure() {
        let control = MockSandboxControl::new("/tmp");
        control.push_exec_remote_error(SandboxControlError::Remote("command failed".into()));

        let (result, stdout, stderr) = run_exec_capture(make_args("test-id", "fail"), &control)
            .await
            .unwrap();
        assert_eq!(result, ExitCode::FAILURE);
        assert!(stdout.is_empty());
        assert_eq!(stderr, b"error: command failed\n");
    }

    #[tokio::test]
    async fn not_found_error_propagates_as_runner_error() {
        let control = MockSandboxControl::new("/tmp");
        control.push_exec_remote_error(SandboxControlError::NotFound("no such sandbox".into()));

        let result = run_exec_capture(make_args("missing", "test"), &control).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn connection_error_propagates_as_runner_error() {
        let control = MockSandboxControl::new("/tmp");
        control.push_exec_remote_error(SandboxControlError::Connection("refused".into()));

        let result = run_exec_capture(make_args("test-id", "test"), &control).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn exit_code_truncated_to_u8() {
        let control = MockSandboxControl::new("/tmp");
        // 256 truncates to 0 via `as u8`
        control.push_exec_remote_status(RemoteExecStatus::exited(256));
        // -1 (0xFFFFFFFF) truncates to 255 via `as u8`
        control.push_exec_remote_status(RemoteExecStatus::exited(-1));

        let (r1, _, _) = run_exec_capture(make_args("id", "test"), &control)
            .await
            .unwrap();
        assert_eq!(r1, ExitCode::from(0));

        let (r2, _, _) = run_exec_capture(make_args("id", "test"), &control)
            .await
            .unwrap();
        assert_eq!(r2, ExitCode::from(255));
    }

    #[tokio::test]
    async fn truncation_with_zero_exit_returns_failure() {
        let control = MockSandboxControl::new("/tmp");
        control.push_exec_remote_status(RemoteExecStatus {
            termination: RemoteExecTermination::Exited { exit_code: 0 },
            stdout_truncated: true,
            stderr_truncated: false,
            diagnostic: None,
        });

        let (result, stdout, stderr) = run_exec_capture(make_args("id", "test"), &control)
            .await
            .unwrap();

        assert_eq!(result, ExitCode::FAILURE);
        assert!(stdout.is_empty());
        assert_eq!(stderr, b"runner exec: stdout truncated\n");
    }

    #[tokio::test]
    async fn truncation_with_nonzero_exit_preserves_remote_exit_code() {
        let control = MockSandboxControl::new("/tmp");
        control.push_exec_remote_status(RemoteExecStatus {
            termination: RemoteExecTermination::Exited { exit_code: 9 },
            stdout_truncated: false,
            stderr_truncated: true,
            diagnostic: None,
        });

        let (result, stdout, stderr) = run_exec_capture(make_args("id", "test"), &control)
            .await
            .unwrap();

        assert_eq!(result, ExitCode::from(9));
        assert!(stdout.is_empty());
        assert_eq!(stderr, b"runner exec: stderr truncated\n");
    }

    #[tokio::test]
    async fn timed_out_status_returns_timeout_exit_code() {
        let control = MockSandboxControl::new("/tmp");
        control.push_exec_remote_status(RemoteExecStatus {
            termination: RemoteExecTermination::TimedOut,
            stdout_truncated: false,
            stderr_truncated: false,
            diagnostic: None,
        });

        let (result, stdout, stderr) = run_exec_capture(make_args("id", "test"), &control)
            .await
            .unwrap();

        assert_eq!(result, ExitCode::from(124));
        assert!(stdout.is_empty());
        assert_eq!(stderr, b"error: command timed out\n");
    }

    #[tokio::test]
    async fn wait_failed_status_prints_diagnostic() {
        let control = MockSandboxControl::new("/tmp");
        control.push_exec_remote_status(RemoteExecStatus {
            termination: RemoteExecTermination::WaitFailed,
            stdout_truncated: false,
            stderr_truncated: false,
            diagnostic: Some("wait failed".into()),
        });

        let (result, stdout, stderr) = run_exec_capture(make_args("id", "test"), &control)
            .await
            .unwrap();

        assert_eq!(result, ExitCode::FAILURE);
        assert!(stdout.is_empty());
        assert_eq!(stderr, b"error: command wait failed: wait failed\n");
    }

    #[tokio::test]
    async fn start_failed_status_prints_diagnostic() {
        let control = MockSandboxControl::new("/tmp");
        control.push_exec_remote_status(RemoteExecStatus {
            termination: RemoteExecTermination::StartFailed,
            stdout_truncated: false,
            stderr_truncated: false,
            diagnostic: Some("permission denied".into()),
        });

        let (result, stdout, stderr) = run_exec_capture(make_args("id", "test"), &control)
            .await
            .unwrap();

        assert_eq!(result, ExitCode::FAILURE);
        assert!(stdout.is_empty());
        assert_eq!(
            stderr,
            b"error: command failed to start: permission denied\n"
        );
    }

    #[tokio::test]
    async fn cancelled_status_prints_message() {
        let control = MockSandboxControl::new("/tmp");
        control.push_exec_remote_status(RemoteExecStatus {
            termination: RemoteExecTermination::Cancelled,
            stdout_truncated: false,
            stderr_truncated: false,
            diagnostic: None,
        });

        let (result, stdout, stderr) = run_exec_capture(make_args("id", "test"), &control)
            .await
            .unwrap();

        assert_eq!(result, ExitCode::FAILURE);
        assert!(stdout.is_empty());
        assert_eq!(stderr, b"error: command cancelled\n");
    }

    struct BrokenPipeWriter;

    impl Write for BrokenPipeWriter {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed pipe"))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn stdout_broken_pipe_exits_success_without_config_error() {
        let control = MockSandboxControl::new("/tmp");
        control.push_exec_remote_response(MockRemoteExecResponse {
            output: vec![MockRemoteExecOutput::Stdout(b"hello\n".to_vec())],
            result: Ok(RemoteExecStatus::exited(0)),
        });

        let mut stdout = BrokenPipeWriter;
        let mut stderr = Vec::new();
        let result = run_exec_with_writers(
            make_args("test-id", "echo hello"),
            &control,
            &mut stdout,
            &mut stderr,
        )
        .await
        .unwrap();

        assert_eq!(result, ExitCode::SUCCESS);
        assert!(stderr.is_empty());
    }

    #[tokio::test]
    async fn stderr_broken_pipe_exits_success_without_config_error() {
        let control = MockSandboxControl::new("/tmp");
        control.push_exec_remote_response(MockRemoteExecResponse {
            output: vec![MockRemoteExecOutput::Stderr(b"warning\n".to_vec())],
            result: Ok(RemoteExecStatus::exited(0)),
        });

        let mut stdout = Vec::new();
        let mut stderr = BrokenPipeWriter;
        let result = run_exec_with_writers(
            make_args("test-id", "echo warning"),
            &control,
            &mut stdout,
            &mut stderr,
        )
        .await
        .unwrap();

        assert_eq!(result, ExitCode::SUCCESS);
        assert!(stdout.is_empty());
    }

    // ---- argument quoting -------------------------------------------------

    #[tokio::test]
    async fn safe_ascii_args_pass_through_unquoted() {
        let control = MockSandboxControl::new("/tmp");
        run_exec_capture(make_args_vec(vec!["ls", "-la", "/var/log"]), &control)
            .await
            .unwrap();

        assert_eq!(
            control.recorded_commands(),
            vec!["ls -la /var/log".to_string()],
        );
    }

    #[tokio::test]
    async fn arg_with_space_is_quoted_as_single_token() {
        let control = MockSandboxControl::new("/tmp");
        run_exec_capture(
            make_args_vec(vec!["cat", "/var/log/some file.log"]),
            &control,
        )
        .await
        .unwrap();

        assert_eq!(
            control.recorded_commands(),
            vec!["cat '/var/log/some file.log'".to_string()],
        );
    }

    #[tokio::test]
    async fn arg_with_single_quote_is_escaped() {
        let control = MockSandboxControl::new("/tmp");
        run_exec_capture(make_args_vec(vec!["echo", "it's"]), &control)
            .await
            .unwrap();

        assert_eq!(
            control.recorded_commands(),
            vec!["echo 'it'\\''s'".to_string()],
        );
    }

    #[tokio::test]
    async fn pipeline_inside_quoted_arg_is_preserved() {
        let control = MockSandboxControl::new("/tmp");
        run_exec_capture(
            make_args_vec(vec!["bash", "-c", "echo a | tr a b"]),
            &control,
        )
        .await
        .unwrap();

        assert_eq!(
            control.recorded_commands(),
            vec!["bash -c 'echo a | tr a b'".to_string()],
        );
    }

    #[tokio::test]
    async fn shell_metachar_in_arg_is_quoted() {
        let control = MockSandboxControl::new("/tmp");
        run_exec_capture(make_args_vec(vec!["echo", "$HOME"]), &control)
            .await
            .unwrap();

        // `$` must be quoted so the guest shell does not expand it.
        assert_eq!(
            control.recorded_commands(),
            vec!["echo '$HOME'".to_string()],
        );
    }

    #[tokio::test]
    async fn empty_arg_is_quoted() {
        let control = MockSandboxControl::new("/tmp");
        run_exec_capture(make_args_vec(vec!["echo", ""]), &control)
            .await
            .unwrap();

        assert_eq!(control.recorded_commands(), vec!["echo ''".to_string()]);
    }

    #[tokio::test]
    async fn assignment_syntax_arg_is_quoted() {
        let control = MockSandboxControl::new("/tmp");
        run_exec_capture(make_args_vec(vec!["FOO=bar", "env"]), &control)
            .await
            .unwrap();

        // `=` is not in the safe set, so `FOO=bar` is quoted. This prevents
        // the guest shell from interpreting it as a variable assignment —
        // it is treated as a command name, matching argv semantics.
        assert_eq!(
            control.recorded_commands(),
            vec!["'FOO=bar' env".to_string()],
        );
    }
}
