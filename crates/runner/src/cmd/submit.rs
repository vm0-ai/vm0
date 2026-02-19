//! `runner submit` — send a job to a locally running runner over Unix socket.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::Args;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use crate::error::{RunnerError, RunnerResult};
use crate::provider::{JobRequest, JobResponse};

#[derive(Args)]
pub struct SubmitArgs {
    /// Path to the Unix socket
    #[arg(long)]
    socket: PathBuf,
    /// Job prompt
    #[arg(long)]
    prompt: String,
    /// Working directory inside the VM
    #[arg(long, default_value = "/workspace")]
    working_dir: String,
    /// Agent type
    #[arg(long, default_value = "claude-code")]
    cli_agent_type: String,
}

pub async fn run_submit(args: SubmitArgs) -> RunnerResult<ExitCode> {
    let mut stream = UnixStream::connect(&args.socket).await.map_err(|e| {
        RunnerError::Config(format!("connect to socket {}: {e}", args.socket.display()))
    })?;

    let request = JobRequest {
        prompt: args.prompt,
        working_dir: args.working_dir,
        cli_agent_type: args.cli_agent_type,
        vars: None,
        environment: None,
        user_timezone: None,
    };

    let json = serde_json::to_vec(&request)
        .map_err(|e| RunnerError::Internal(format!("serialize request: {e}")))?;

    stream
        .write_all(&json)
        .await
        .map_err(|e| RunnerError::Internal(format!("write to socket: {e}")))?;
    stream
        .shutdown()
        .await
        .map_err(|e| RunnerError::Internal(format!("shutdown write: {e}")))?;

    // Read response until EOF
    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .await
        .map_err(|e| RunnerError::Internal(format!("read response: {e}")))?;

    let response: JobResponse = serde_json::from_slice(&buf)
        .map_err(|e| RunnerError::Internal(format!("parse response: {e}")))?;

    // Write response as JSON to stdout for machine-parseable output.
    // The buf is already valid JSON from the server, write it directly.
    use std::io::Write;
    std::io::stdout().write_all(&buf).ok();
    std::io::stdout().write_all(b"\n").ok();

    if response.exit_code == 0 {
        Ok(ExitCode::SUCCESS)
    } else {
        Ok(ExitCode::FAILURE)
    }
}
