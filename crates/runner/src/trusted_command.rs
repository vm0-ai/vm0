#![allow(dead_code)]

use std::time::Duration;

use sandbox::{
    BoundedExecOutputEvent, BoundedExecRequest, BoundedExecResult, ExecRequest, Sandbox,
};
use thiserror::Error;
use tokio::sync::mpsc;
use uuid::Uuid;

const MIN_REDACT_VALUE_LEN: usize = 4;
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) struct TrustedCommandRequest<'a> {
    pub(crate) script: &'a str,
    pub(crate) stdin: &'a [u8],
    pub(crate) env: &'a [(&'a str, &'a str)],
    pub(crate) working_dir: Option<&'a str>,
    pub(crate) timeout: Duration,
    pub(crate) stdin_limit_bytes: usize,
    pub(crate) stdout_limit_bytes: u32,
    pub(crate) stderr_limit_bytes: u32,
    pub(crate) output_tx: Option<mpsc::Sender<BoundedExecOutputEvent>>,
    pub(crate) redact_values: &'a [&'a str],
    pub(crate) sudo: bool,
}

#[derive(Debug, Error)]
pub(crate) enum TrustedCommandError {
    #[error("invalid environment variable name: {0}")]
    InvalidEnvName(String),
    #[error("stdin length {actual} exceeds limit {limit}")]
    StdinTooLarge { actual: usize, limit: usize },
    #[error("working directory cannot be empty")]
    EmptyWorkingDir,
    #[error(transparent)]
    Sandbox(#[from] sandbox::SandboxError),
}

pub(crate) async fn run_trusted_bash(
    sandbox: &dyn Sandbox,
    request: TrustedCommandRequest<'_>,
) -> Result<BoundedExecResult, TrustedCommandError> {
    validate_request(&request)?;

    let script_path = format!("/tmp/vm0-trusted-command-{}.sh", Uuid::new_v4());
    let patterns = redaction_patterns(request.env, request.redact_values);
    let (output_tx, bridge) = redacting_output_bridge(request.output_tx, patterns.clone());

    let write_result = sandbox
        .write_file(&script_path, request.script.as_bytes())
        .await;
    if let Err(err) = write_result {
        cleanup_script(sandbox, &script_path).await;
        return Err(err.into());
    }

    let command = launcher_command(&script_path, request.working_dir);
    let result = sandbox
        .bounded_exec(&BoundedExecRequest {
            cmd: &command,
            timeout: request.timeout,
            env: request.env,
            sudo: request.sudo,
            stdin: request.stdin,
            stdout_limit_bytes: request.stdout_limit_bytes,
            stderr_limit_bytes: request.stderr_limit_bytes,
            output_tx,
        })
        .await;

    cleanup_script(sandbox, &script_path).await;
    if let Some(bridge) = bridge {
        finish_output_bridge(bridge).await;
    }

    let mut result = result?;
    result.stdout = redact_bytes(&result.stdout, &patterns);
    result.stderr = redact_bytes(&result.stderr, &patterns);
    Ok(result)
}

async fn finish_output_bridge(mut bridge: tokio::task::JoinHandle<()>) {
    tokio::select! {
        _ = &mut bridge => {}
        _ = tokio::time::sleep(Duration::from_millis(100)) => {
            bridge.abort();
        }
    }
}

fn validate_request(request: &TrustedCommandRequest<'_>) -> Result<(), TrustedCommandError> {
    if request.stdin.len() > request.stdin_limit_bytes {
        return Err(TrustedCommandError::StdinTooLarge {
            actual: request.stdin.len(),
            limit: request.stdin_limit_bytes,
        });
    }
    for (key, _) in request.env {
        if !is_valid_env_name(key) {
            return Err(TrustedCommandError::InvalidEnvName((*key).to_string()));
        }
    }
    if request.working_dir.is_some_and(str::is_empty) {
        return Err(TrustedCommandError::EmptyWorkingDir);
    }
    Ok(())
}

fn is_valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

fn launcher_command(script_path: &str, working_dir: Option<&str>) -> String {
    let script = shell_quote(script_path);
    match working_dir {
        Some(dir) => format!("cd {} && bash {script}", shell_quote(dir)),
        None => format!("bash {script}"),
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

async fn cleanup_script(sandbox: &dyn Sandbox, script_path: &str) {
    let _ = sandbox
        .exec(&ExecRequest {
            cmd: &format!("rm -f {}", shell_quote(script_path)),
            timeout: CLEANUP_TIMEOUT,
            env: &[],
            sudo: false,
        })
        .await;
}

fn redaction_patterns(env: &[(&str, &str)], explicit: &[&str]) -> Vec<Vec<u8>> {
    let mut patterns = Vec::new();
    for value in explicit {
        push_redaction_pattern(&mut patterns, value.as_bytes());
    }
    for (key, value) in env {
        if is_sensitive_env_key(key) {
            push_redaction_pattern(&mut patterns, value.as_bytes());
        }
    }
    patterns
}

fn push_redaction_pattern(patterns: &mut Vec<Vec<u8>>, value: &[u8]) {
    if value.len() >= MIN_REDACT_VALUE_LEN && !patterns.iter().any(|existing| existing == value) {
        patterns.push(value.to_vec());
    }
}

fn is_sensitive_env_key(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "API_KEY",
        "AUTH",
        "CREDENTIAL",
    ]
    .iter()
    .any(|needle| key.contains(needle))
}

fn redacting_output_bridge(
    caller_tx: Option<mpsc::Sender<BoundedExecOutputEvent>>,
    patterns: Vec<Vec<u8>>,
) -> (
    Option<mpsc::Sender<BoundedExecOutputEvent>>,
    Option<tokio::task::JoinHandle<()>>,
) {
    let Some(caller_tx) = caller_tx else {
        return (None, None);
    };

    let (internal_tx, mut internal_rx) = mpsc::channel::<BoundedExecOutputEvent>(32);
    let bridge = tokio::spawn(async move {
        while let Some(mut event) = internal_rx.recv().await {
            event.chunk = redact_bytes(&event.chunk, &patterns);
            if caller_tx.send(event).await.is_err() {
                break;
            }
        }
    });
    (Some(internal_tx), Some(bridge))
}

fn redact_bytes(input: &[u8], patterns: &[Vec<u8>]) -> Vec<u8> {
    let mut output = input.to_vec();
    for pattern in patterns {
        output = replace_all_bytes(&output, pattern, b"[REDACTED]");
    }
    output
}

fn replace_all_bytes(input: &[u8], needle: &[u8], replacement: &[u8]) -> Vec<u8> {
    if needle.is_empty() {
        return input.to_vec();
    }

    let mut output = Vec::with_capacity(input.len());
    let mut offset = 0usize;
    while offset < input.len() {
        if input
            .get(offset..)
            .is_some_and(|remaining| remaining.starts_with(needle))
        {
            output.extend_from_slice(replacement);
            offset += needle.len();
        } else if let Some(byte) = input.get(offset) {
            output.push(*byte);
            offset += 1;
        } else {
            break;
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use sandbox::{BoundedExecOutputStream, BoundedExecStatus};
    use sandbox_mock::MockSandbox;

    fn request<'a>(script: &'a str) -> TrustedCommandRequest<'a> {
        TrustedCommandRequest {
            script,
            stdin: &[],
            env: &[],
            working_dir: None,
            timeout: Duration::from_secs(5),
            stdin_limit_bytes: 1024,
            stdout_limit_bytes: 1024,
            stderr_limit_bytes: 1024,
            output_tx: None,
            redact_values: &[],
            sudo: false,
        }
    }

    #[tokio::test]
    async fn writes_script_and_executes_script_path_only() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_bounded_exec_result(Ok(BoundedExecResult {
            status: BoundedExecStatus::Exited { exit_code: 0 },
            stdout: b"ok".to_vec(),
            stderr: Vec::new(),
            stdout_truncated: false,
            stderr_truncated: false,
            duration_ms: 1,
        }));

        let result = run_trusted_bash(&sandbox, request("echo secret-script-body"))
            .await
            .unwrap();

        assert_eq!(result.stdout, b"ok");
        let writes = sandbox.write_file_calls();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].content, b"echo secret-script-body");
        assert!(writes[0].path.starts_with("/tmp/vm0-trusted-command-"));

        let calls = sandbox.bounded_exec_calls();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].cmd.contains(&writes[0].path));
        assert!(!calls[0].cmd.contains("secret-script-body"));
    }

    #[tokio::test]
    async fn rejects_invalid_env_before_guest_writes() {
        let sandbox = MockSandbox::new("test");
        let mut req = request("echo hi");
        req.env = &[("BAD;NAME", "value")];

        let err = run_trusted_bash(&sandbox, req).await.unwrap_err();

        assert!(matches!(err, TrustedCommandError::InvalidEnvName(_)));
        assert!(sandbox.write_file_calls().is_empty());
        assert!(sandbox.bounded_exec_calls().is_empty());
    }

    #[tokio::test]
    async fn redacts_final_and_streamed_output() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_bounded_exec_output_events(vec![BoundedExecOutputEvent {
            stream: BoundedExecOutputStream::Stdout,
            sequence: 0,
            chunk: b"token=supersecret".to_vec(),
            truncated: false,
        }]);
        sandbox.push_bounded_exec_result(Ok(BoundedExecResult {
            status: BoundedExecStatus::Exited { exit_code: 0 },
            stdout: b"stdout supersecret".to_vec(),
            stderr: b"stderr supersecret".to_vec(),
            stdout_truncated: false,
            stderr_truncated: false,
            duration_ms: 1,
        }));

        let (tx, mut rx) = mpsc::channel(4);
        let mut req = request("echo hi");
        req.env = &[("API_TOKEN", "supersecret")];
        req.output_tx = Some(tx);

        let result = run_trusted_bash(&sandbox, req).await.unwrap();
        let streamed = rx.recv().await.unwrap();

        assert_eq!(streamed.chunk, b"token=[REDACTED]");
        assert_eq!(result.stdout, b"stdout [REDACTED]");
        assert_eq!(result.stderr, b"stderr [REDACTED]");
    }

    #[tokio::test]
    async fn rejects_oversized_stdin_before_guest_writes() {
        let sandbox = MockSandbox::new("test");
        let mut req = request("cat");
        req.stdin = b"too much";
        req.stdin_limit_bytes = 3;

        let err = run_trusted_bash(&sandbox, req).await.unwrap_err();

        assert!(matches!(err, TrustedCommandError::StdinTooLarge { .. }));
        assert!(sandbox.write_file_calls().is_empty());
        assert!(sandbox.bounded_exec_calls().is_empty());
    }
}
