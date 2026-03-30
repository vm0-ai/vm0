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
