use std::time::Duration;

use tracing::warn;

/// Returns true if dmesg output indicates an OOM kill.
pub(in crate::executor) fn dmesg_indicates_oom(stdout: &str) -> bool {
    let lower = stdout.to_lowercase();
    lower.contains("out of memory") || lower.contains("oom-kill") || lower.contains("oom_reaper")
}

/// Checks host `dmesg` output for OOM evidence naming a specific Firecracker process.
///
/// Invokes `dmesg` directly under the runner's current privileges and times out
/// after five seconds. Returns `false` when the command exits unsuccessfully,
/// cannot be started, or times out.
pub(in crate::executor) async fn check_host_oom(pid: u32) -> bool {
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::process::Command::new("dmesg").output().await
    })
    .await;
    match result {
        Ok(Ok(out)) if out.status.success() => {
            host_dmesg_indicates_oom(&String::from_utf8_lossy(&out.stdout), pid)
        }
        Ok(Ok(out)) => {
            warn!(pid, exit_code = out.status.code(), "dmesg failed");
            false
        }
        Ok(Err(e)) => {
            warn!(pid, error = %e, "failed to run dmesg for OOM check");
            false
        }
        Err(_) => {
            warn!(pid, "host dmesg OOM check timed out");
            false
        }
    }
}

/// Returns `true` when host `dmesg` output contains the case-sensitive
/// `oom-kill` marker and an exact `task=firecracker,pid=<pid>` token.
///
/// The marker and task token are searched independently across the output, so
/// this does not validate a memory-cgroup constraint. The character after the
/// PID must not be a digit, avoiding prefix matches such as `pid=1234` matching
/// `pid=12345`.
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
