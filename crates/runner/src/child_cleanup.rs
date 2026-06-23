use tokio::runtime::Handle;
use tracing::{debug, warn};

/// Kill a child from a synchronous drop fallback and reap it on the active runtime.
///
/// Normal async shutdown paths should still use explicit `wait().await`. This
/// helper exists for abnormal drop/cancellation fallback paths where awaiting
/// directly is impossible.
pub(crate) fn kill_and_reap_child_on_drop(
    label: &'static str,
    child: &mut Option<tokio::process::Child>,
) {
    let Some(mut child) = child.take() else {
        return;
    };
    let pid = child.id();

    match child.try_wait() {
        Ok(Some(status)) => {
            debug!(
                label,
                ?pid,
                code = status.code(),
                "child already exited during drop cleanup"
            );
            return;
        }
        Ok(None) => {}
        Err(error) => {
            warn!(label, ?pid, error = %error, "failed to check child status during drop cleanup");
        }
    }

    if let Err(error) = child.start_kill() {
        warn!(label, ?pid, error = %error, "failed to kill child during drop cleanup");
    }

    match child.try_wait() {
        Ok(Some(status)) => {
            debug!(
                label,
                ?pid,
                code = status.code(),
                "child exited during drop cleanup"
            );
            return;
        }
        Ok(None) => {}
        Err(error) => {
            warn!(label, ?pid, error = %error, "failed to recheck child status during drop cleanup");
        }
    }

    let Ok(handle) = Handle::try_current() else {
        warn!(
            label,
            ?pid,
            "cannot spawn child reaper without an active tokio runtime"
        );
        return;
    };

    handle.spawn(async move {
        if let Err(error) = child.wait().await {
            warn!(label, ?pid, error = %error, "failed to reap child after drop cleanup");
        }
    });
}

#[cfg(test)]
#[cfg(target_os = "linux")]
mod tests {
    use super::*;
    use std::path::Path;
    use std::time::Duration;

    fn process_exists(pid: u32) -> bool {
        Path::new(&format!("/proc/{pid}")).exists()
    }

    async fn wait_for_process_exit(pid: u32) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if !process_exists(pid) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for pid {pid} to be reaped"));
    }

    #[tokio::test]
    async fn drop_cleanup_kills_and_reaps_running_child() {
        let child = tokio::process::Command::new("sleep")
            .arg("60")
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let mut child = Some(child);

        kill_and_reap_child_on_drop("test-running-child", &mut child);

        assert!(child.is_none());
        wait_for_process_exit(pid).await;
    }

    #[tokio::test]
    async fn drop_cleanup_reaps_already_exited_child() {
        let child = tokio::process::Command::new("true").spawn().unwrap();
        let pid = child.id().unwrap();
        let mut child = Some(child);

        tokio::time::sleep(Duration::from_millis(50)).await;
        kill_and_reap_child_on_drop("test-exited-child", &mut child);

        assert!(child.is_none());
        wait_for_process_exit(pid).await;
    }
}
