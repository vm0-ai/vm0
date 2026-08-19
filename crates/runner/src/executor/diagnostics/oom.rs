use std::time::Duration;

use tokio::process::Command;
use tracing::warn;

use crate::bounded_command::{
    BoundedCommandError, BoundedCommandOutcome, CommandOutputCapture, run_output_bounded,
};

const HOST_OOM_CHECK_TIMEOUT: Duration = Duration::from_secs(5);

/// Returns true if dmesg output indicates an OOM kill.
pub(in crate::executor) fn dmesg_indicates_oom(stdout: &str) -> bool {
    let lower = stdout.to_lowercase();
    lower.contains("out of memory") || lower.contains("oom-kill") || lower.contains("oom_reaper")
}

/// Checks host `dmesg` output for OOM evidence naming a specific Firecracker process.
///
/// Invokes `dmesg` directly under the runner's current privileges. After a
/// five-second execution deadline, the child is terminated and reaped before
/// returning. Returns `false` when the command exits unsuccessfully, execution
/// fails, or the operation times out.
pub(in crate::executor) async fn check_host_oom(pid: u32) -> bool {
    check_host_oom_command(pid, Command::new("dmesg"), HOST_OOM_CHECK_TIMEOUT).await
}

async fn check_host_oom_command(pid: u32, command: Command, timeout: Duration) -> bool {
    match run_output_bounded(
        command,
        "dmesg",
        CommandOutputCapture::StdoutAndStderr,
        timeout,
    )
    .await
    {
        Ok(BoundedCommandOutcome::Exited(output)) if output.status.success() => {
            host_dmesg_indicates_oom(&String::from_utf8_lossy(&output.stdout), pid)
        }
        Ok(BoundedCommandOutcome::Exited(output)) => {
            warn!(pid, exit_code = output.status.code(), "dmesg failed");
            false
        }
        Ok(BoundedCommandOutcome::TimedOut) => {
            warn!(pid, "host dmesg OOM check timed out");
            false
        }
        Err(BoundedCommandError::Spawn(error) | BoundedCommandError::Wait(error)) => {
            warn!(pid, error = %error, "failed to run dmesg for OOM check");
            false
        }
        Err(BoundedCommandError::Lifecycle(error)) => {
            warn!(pid, error = %error, "failed to run dmesg for OOM check");
            false
        }
    }
}

/// Returns `true` when host `dmesg` output contains the case-sensitive
/// `oom-kill` marker and the `task=firecracker,pid=<pid>` substring.
///
/// The two substrings are searched independently across the full output and
/// need not occur in the same log record. The predicate does not require a
/// memory-cgroup constraint marker. The character after the PID must not be a
/// digit, avoiding prefix matches such as `pid=1234` matching `pid=12345`.
pub(in crate::executor) fn host_dmesg_indicates_oom(dmesg: &str, pid: u32) -> bool {
    if !dmesg.contains("oom-kill") {
        return false;
    }
    let needle = format!("task=firecracker,pid={pid}");
    let mut start = 0;
    while let Some(pos) = dmesg[start..].find(&needle) {
        let abs = start + pos + needle.len();
        // Accept if needle is at end of string or next char is not a digit.
        match dmesg.as_bytes().get(abs) {
            Some(c) if c.is_ascii_digit() => {
                // Prefix match (e.g. pid=1234 inside pid=12345) — keep searching.
                start = abs;
            }
            _ => return true,
        }
    }
    false
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn timed_out_command_is_not_oom_evidence() {
        let mut command = Command::new("sleep");
        command.arg("60");

        assert!(!check_host_oom_command(42, command, Duration::ZERO).await);
    }

    #[tokio::test]
    async fn unsuccessful_command_is_not_oom_evidence() {
        let command = Command::new("false");

        assert!(!check_host_oom_command(42, command, Duration::from_secs(2)).await);
    }

    #[tokio::test]
    async fn successful_command_captures_stdout_for_oom_detection() {
        let mut command = Command::new("printf");
        command.arg("oom-kill:task=firecracker,pid=42");

        assert!(check_host_oom_command(42, command, Duration::from_secs(2)).await);
    }
}
