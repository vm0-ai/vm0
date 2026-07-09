use std::time::Duration;

use tracing::warn;

/// Returns true if dmesg output indicates an OOM kill.
pub(in crate::executor) fn dmesg_indicates_oom(stdout: &str) -> bool {
    let lower = stdout.to_lowercase();
    lower.contains("out of memory") || lower.contains("oom-kill") || lower.contains("oom_reaper")
}

/// Check host dmesg for a cgroup OOM kill of a specific firecracker process.
/// Reads the entire ring buffer (~512KB) directly — no shell wrapper needed
/// since the pure function handles filtering.  Times out after 5s to avoid
/// blocking if sudo hangs.
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

/// Returns true if host dmesg output contains an OOM kill record for the
/// given firecracker PID.  Checks that the character after the PID is not
/// a digit to avoid prefix matches (e.g. pid=1234 must not match pid=12345).
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
