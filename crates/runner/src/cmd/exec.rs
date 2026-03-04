//! Execute a command inside a running VM for live debugging.
//!
//! Discovers the sandbox's control socket by scanning `/run/vm0/sock/`
//! for directories matching the given run ID prefix.

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use clap::Args;
use sandbox_fc::control::{ExecRequest, ExecResponse};
use sandbox_fc::{RuntimePaths, SockPaths};

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

pub async fn run_exec(args: ExecArgs) -> RunnerResult<ExitCode> {
    let sock_path = resolve_control_socket(&args.run_id)?;

    let command = args.command.join(" ");
    let request = ExecRequest {
        command,
        timeout_secs: args.timeout,
        sudo: args.sudo,
    };

    let timeout = Duration::from_secs(u64::from(args.timeout) + 5);
    let response = sandbox_fc::control::send_exec(&sock_path, &request, timeout)
        .await
        .map_err(|e| RunnerError::Config(format!("failed to connect to sandbox: {e}")))?;

    match response {
        ExecResponse::Success {
            exit_code,
            stdout,
            stderr,
        } => {
            let stdout_bytes = BASE64
                .decode(&stdout)
                .map_err(|e| RunnerError::Config(format!("decode stdout: {e}")))?;
            let stderr_bytes = BASE64
                .decode(&stderr)
                .map_err(|e| RunnerError::Config(format!("decode stderr: {e}")))?;

            let out = std::io::stdout();
            let err = std::io::stderr();
            let _ = out.lock().write_all(&stdout_bytes);
            let _ = err.lock().write_all(&stderr_bytes);

            // Propagate the actual exit code for debugging utility.
            // Truncate to u8 like shells do (e.g. 256 → 0, -1 → 255).
            Ok(ExitCode::from(exit_code as u8))
        }
        ExecResponse::Error { error } => {
            eprintln!("error: {error}");
            Ok(ExitCode::FAILURE)
        }
    }
}

// ---------------------------------------------------------------------------
// Control socket discovery
// ---------------------------------------------------------------------------

/// Find the control socket for a given run ID (full UUID or prefix).
///
/// Scans `/run/vm0/sock/` for directories matching the prefix that
/// contain a `control.sock` file.
fn resolve_control_socket(input: &str) -> RunnerResult<PathBuf> {
    if input.is_empty() {
        return Err(RunnerError::Config("run_id must not be empty".into()));
    }

    let runtime = RuntimePaths::new();
    let sock_parent = runtime.sock_base();

    let entries = std::fs::read_dir(&sock_parent).map_err(|e| {
        RunnerError::Config(format!(
            "cannot read {}: {e} (is a sandbox running?)",
            sock_parent.display()
        ))
    })?;

    let mut matches: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if !name_str.starts_with(input) {
            continue;
        }
        let control_sock = SockPaths::new(entry.path()).control_sock();
        if control_sock.exists() {
            matches.push((name_str.to_owned(), control_sock));
        }
    }

    match matches.as_slice() {
        [] => Err(RunnerError::Config(format!(
            "no running sandbox matches '{input}' (no control.sock found)"
        ))),
        [single] => Ok(single.1.clone()),
        _ => {
            let ids: Vec<&str> = matches.iter().map(|(id, _)| id.as_str()).collect();
            Err(RunnerError::Config(format!(
                "ambiguous prefix '{input}', matches: {}",
                ids.join(", ")
            )))
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_control_socket_empty_input() {
        let result = resolve_control_socket("");
        let Err(e) = result else {
            panic!("expected error");
        };
        assert!(e.to_string().contains("must not be empty"));
    }
}
