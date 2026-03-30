//! Execute a command inside a running VM for live debugging.

use std::io::Write;
use std::process::ExitCode;
use std::time::Duration;

use clap::Args;
use sandbox::{SandboxControl, SandboxControlError};

use crate::error::{RunnerError, RunnerResult};

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

#[derive(Args)]
pub struct ExecArgs {
    /// Run ID (full UUID or unique prefix)
    run_id: String,

    /// Timeout in seconds for the command
    #[arg(long, default_value = "30")]
    timeout: u32,

    /// Run the command with sudo inside the VM
    #[arg(long)]
    sudo: bool,

    /// Command to execute (after --)
    #[arg(last = true, required = true)]
    command: Vec<String>,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub async fn run_exec(args: ExecArgs, control: &dyn SandboxControl) -> RunnerResult<ExitCode> {
    let command = args.command.join(" ");
    let timeout = Duration::from_secs(u64::from(args.timeout));

    match control
        .exec_remote(&args.run_id, &command, timeout, args.sudo)
        .await
    {
        Ok(result) => {
            let out = std::io::stdout();
            let err = std::io::stderr();
            let _ = out.lock().write_all(&result.stdout);
            let _ = err.lock().write_all(&result.stderr);

            // Propagate the actual exit code for debugging utility.
            // Truncate to u8 like shells do (e.g. 256 → 0, -1 → 255).
            Ok(ExitCode::from(result.exit_code as u8))
        }
        Err(SandboxControlError::Remote(msg)) => {
            eprintln!("error: {msg}");
            Ok(ExitCode::FAILURE)
        }
        Err(e) => Err(RunnerError::Config(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use sandbox::{RemoteExecResult, SandboxControlError};
    use sandbox_mock::MockSandboxControl;

    use super::*;

    fn make_args(run_id: &str, command: &str) -> ExecArgs {
        ExecArgs {
            run_id: run_id.into(),
            timeout: 5,
            sudo: false,
            command: command.split_whitespace().map(String::from).collect(),
        }
    }

    #[tokio::test]
    async fn success_propagates_exit_code() {
        let control = MockSandboxControl::new("/tmp");
        control.push_exec_remote_result(Ok(RemoteExecResult {
            exit_code: 42,
            stdout: b"hello\n".to_vec(),
            stderr: Vec::new(),
        }));

        let result = run_exec(make_args("test-id", "echo hello"), &control)
            .await
            .unwrap();
        assert_eq!(result, ExitCode::from(42));
    }

    #[tokio::test]
    async fn zero_exit_code_returns_success() {
        let control = MockSandboxControl::new("/tmp");
        let result = run_exec(make_args("test-id", "true"), &control)
            .await
            .unwrap();
        assert_eq!(result, ExitCode::SUCCESS);
    }

    #[tokio::test]
    async fn remote_error_prints_message_and_returns_failure() {
        let control = MockSandboxControl::new("/tmp");
        control.push_exec_remote_result(Err(SandboxControlError::Remote("command failed".into())));

        let result = run_exec(make_args("test-id", "fail"), &control)
            .await
            .unwrap();
        assert_eq!(result, ExitCode::FAILURE);
    }

    #[tokio::test]
    async fn not_found_error_propagates_as_runner_error() {
        let control = MockSandboxControl::new("/tmp");
        control
            .push_exec_remote_result(Err(SandboxControlError::NotFound("no such sandbox".into())));

        let result = run_exec(make_args("missing", "test"), &control).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn connection_error_propagates_as_runner_error() {
        let control = MockSandboxControl::new("/tmp");
        control.push_exec_remote_result(Err(SandboxControlError::Connection("refused".into())));

        let result = run_exec(make_args("test-id", "test"), &control).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn exit_code_truncated_to_u8() {
        let control = MockSandboxControl::new("/tmp");
        // 256 truncates to 0 via `as u8`
        control.push_exec_remote_result(Ok(RemoteExecResult {
            exit_code: 256,
            stdout: Vec::new(),
            stderr: Vec::new(),
        }));
        // -1 (0xFFFFFFFF) truncates to 255 via `as u8`
        control.push_exec_remote_result(Ok(RemoteExecResult {
            exit_code: -1,
            stdout: Vec::new(),
            stderr: Vec::new(),
        }));

        let r1 = run_exec(make_args("id", "test"), &control).await.unwrap();
        assert_eq!(r1, ExitCode::from(0));

        let r2 = run_exec(make_args("id", "test"), &control).await.unwrap();
        assert_eq!(r2, ExitCode::from(255));
    }
}
