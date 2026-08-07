use std::io;
use std::process::{Output, Stdio};
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tracing::warn;

use crate::child_cleanup::kill_and_reap_child_on_drop;

const HOST_OOM_CHECK_TIMEOUT: Duration = Duration::from_secs(5);

struct HostOomDiagnostic {
    child: Option<Child>,
}

impl HostOomDiagnostic {
    fn spawn(command: &mut Command) -> io::Result<Self> {
        let child = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        Ok(Self { child: Some(child) })
    }

    #[cfg(test)]
    fn pid(&self) -> Option<u32> {
        self.child.as_ref().and_then(Child::id)
    }

    async fn output(mut self, timeout: Duration) -> io::Result<Option<Output>> {
        let (mut stdout, mut stderr) = {
            let child = self
                .child
                .as_mut()
                .ok_or_else(|| io::Error::other("host OOM diagnostic child is not owned"))?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| io::Error::other("host OOM diagnostic stdout is not piped"))?;
            let stderr = child
                .stderr
                .take()
                .ok_or_else(|| io::Error::other("host OOM diagnostic stderr is not piped"))?;
            (stdout, stderr)
        };
        let result = {
            let child = self
                .child
                .as_mut()
                .ok_or_else(|| io::Error::other("host OOM diagnostic child is not owned"))?;
            tokio::time::timeout(timeout, async move {
                let mut stdout_bytes = Vec::new();
                let mut stderr_bytes = Vec::new();
                let (status, _, _) = tokio::try_join!(
                    child.wait(),
                    stdout.read_to_end(&mut stdout_bytes),
                    stderr.read_to_end(&mut stderr_bytes),
                )?;
                Ok::<Output, io::Error>(Output {
                    status,
                    stdout: stdout_bytes,
                    stderr: stderr_bytes,
                })
            })
            .await
        };

        match result {
            Ok(Ok(output)) => {
                self.child = None;
                Ok(Some(output))
            }
            Ok(Err(error)) => {
                self.kill_and_reap().await;
                Err(error)
            }
            Err(_) => {
                self.kill_and_reap().await;
                Ok(None)
            }
        }
    }

    async fn kill_and_reap(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        let _ = child.start_kill();
        if child.wait().await.is_ok() {
            self.child = None;
        }
    }
}

impl Drop for HostOomDiagnostic {
    fn drop(&mut self) {
        kill_and_reap_child_on_drop("host OOM diagnostic", &mut self.child);
    }
}

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
    let diagnostic = match HostOomDiagnostic::spawn(&mut Command::new("dmesg")) {
        Ok(diagnostic) => diagnostic,
        Err(error) => {
            warn!(pid, error = %error, "failed to run dmesg for OOM check");
            return false;
        }
    };
    check_host_oom_diagnostic(pid, diagnostic, HOST_OOM_CHECK_TIMEOUT).await
}

async fn check_host_oom_diagnostic(
    pid: u32,
    diagnostic: HostOomDiagnostic,
    timeout: Duration,
) -> bool {
    let result = diagnostic.output(timeout).await;
    match result {
        Ok(Some(out)) if out.status.success() => {
            host_dmesg_indicates_oom(&String::from_utf8_lossy(&out.stdout), pid)
        }
        Ok(Some(out)) => {
            warn!(pid, exit_code = out.status.code(), "dmesg failed");
            false
        }
        Ok(None) => {
            warn!(pid, "host dmesg OOM check timed out");
            false
        }
        Err(error) => {
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
    use crate::process::read_process_stat;

    const PROCESS_EXIT_TIMEOUT: Duration = Duration::from_secs(2);

    async fn process_starttime(pid: u32) -> Option<u64> {
        read_process_stat(pid).await.map(|stat| stat.starttime)
    }

    async fn wait_for_process_exit(pid: u32, starttime: u64) -> io::Result<()> {
        tokio::time::timeout(PROCESS_EXIT_TIMEOUT, async {
            while process_starttime(pid).await == Some(starttime) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| {
            io::Error::other(format!(
                "timed out waiting for diagnostic process {pid} to be reaped"
            ))
        })
    }

    fn long_lived_diagnostic() -> io::Result<HostOomDiagnostic> {
        let mut command = Command::new("sleep");
        command.arg("60");
        HostOomDiagnostic::spawn(&mut command)
    }

    #[tokio::test]
    async fn timeout_kills_and_reaps_diagnostic_child() -> io::Result<()> {
        let diagnostic = long_lived_diagnostic()?;
        let child_pid = diagnostic
            .pid()
            .ok_or_else(|| io::Error::other("diagnostic process must be running"))?;
        let starttime = process_starttime(child_pid)
            .await
            .ok_or_else(|| io::Error::other("diagnostic process must exist"))?;

        assert!(!check_host_oom_diagnostic(42, diagnostic, Duration::ZERO).await);
        assert_ne!(process_starttime(child_pid).await, Some(starttime));
        Ok(())
    }

    #[tokio::test]
    async fn cancellation_kills_and_reaps_diagnostic_child() -> io::Result<()> {
        let diagnostic = long_lived_diagnostic()?;
        let child_pid = diagnostic
            .pid()
            .ok_or_else(|| io::Error::other("diagnostic process must be running"))?;
        let starttime = process_starttime(child_pid)
            .await
            .ok_or_else(|| io::Error::other("diagnostic process must exist"))?;
        let task = tokio::spawn(check_host_oom_diagnostic(
            42,
            diagnostic,
            Duration::from_secs(60),
        ));

        task.abort();
        assert!(matches!(task.await, Err(error) if error.is_cancelled()));
        wait_for_process_exit(child_pid, starttime).await?;
        Ok(())
    }

    #[tokio::test]
    async fn successful_diagnostic_captures_stdout_for_oom_detection() -> io::Result<()> {
        let mut command = Command::new("printf");
        command.arg("oom-kill:task=firecracker,pid=42");
        let diagnostic = HostOomDiagnostic::spawn(&mut command)?;

        assert!(check_host_oom_diagnostic(42, diagnostic, Duration::from_secs(2)).await);
        Ok(())
    }
}
