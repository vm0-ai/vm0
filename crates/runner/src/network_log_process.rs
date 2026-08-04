use tokio_util::sync::CancellationToken;

use crate::child_cleanup::kill_and_reap_child_on_drop;
use crate::network_log_drain::{DrainableLineReaderExit, NetworkLogDrainProducer};

/// Owns the common post-spawn lifecycle of a required network-log process.
pub(crate) struct NetworkLogProcess {
    child_label: &'static str,
    cancel: CancellationToken,
    task: Option<tokio::task::JoinHandle<DrainableLineReaderExit>>,
    child: Option<tokio::process::Child>,
    drain: NetworkLogDrainProducer,
}

impl NetworkLogProcess {
    pub(crate) fn new(
        child_label: &'static str,
        cancel: CancellationToken,
        task: tokio::task::JoinHandle<DrainableLineReaderExit>,
        child: tokio::process::Child,
        drain: NetworkLogDrainProducer,
    ) -> Self {
        Self {
            child_label,
            cancel,
            task: Some(task),
            child: Some(child),
            drain,
        }
    }

    /// Await the monitor task, or pend forever after its completion has
    /// already been consumed.
    ///
    /// Keeping the task in the owner lets the runner reactor select on it
    /// without taking ownership unless it actually completes.
    pub(crate) async fn wait(&mut self) -> Result<DrainableLineReaderExit, tokio::task::JoinError> {
        let result = match self.task.as_mut() {
            Some(task) => task.await,
            None => std::future::pending().await,
        };
        self.task = None;
        result
    }

    /// Kill the child when necessary and wait for it to be reaped.
    pub(crate) async fn kill_and_reap_child(&mut self) {
        let child_reaped = if let Some(ref mut child) = self.child {
            let _ = child.start_kill();
            child.wait().await.is_ok()
        } else {
            false
        };
        if child_reaped {
            self.child = None;
        }
    }

    /// Cancel the monitor task and wait for the child and task to finish.
    pub(crate) async fn stop(mut self) {
        self.cancel.cancel();
        self.kill_and_reap_child().await;
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }

    pub(crate) fn drain_producer(&self) -> NetworkLogDrainProducer {
        self.drain.clone()
    }

    /// Create a lifecycle owner without a child process for runner tests.
    #[cfg(test)]
    pub(crate) fn noop(child_label: &'static str, drain_source: &'static str) -> Self {
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let (drain, mut drain_rx) = NetworkLogDrainProducer::channel(drain_source);
        Self {
            child_label,
            cancel,
            task: Some(tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = token.cancelled() => {
                            return DrainableLineReaderExit::Cancelled;
                        }
                        request = drain_rx.recv() => {
                            let Some(request) = request else {
                                return DrainableLineReaderExit::DrainChannelClosed;
                            };
                            request.ack();
                        }
                    }
                }
            })),
            child: None,
            drain,
        }
    }

    /// Replace the monitor with a task that panics when triggered.
    #[cfg(test)]
    pub(crate) async fn replace_monitor_with_panic_trigger_for_test(
        &mut self,
        drain_source: &'static str,
    ) -> std::sync::Arc<tokio::sync::Notify> {
        let task = self.task.take().expect("monitor task should exist");
        task.abort();
        let error = task
            .await
            .expect_err("aborted monitor task should return a join error");
        assert!(
            error.is_cancelled(),
            "aborted monitor task should be cancelled: {error}",
        );

        let token = self.cancel.clone();
        let trigger = std::sync::Arc::new(tokio::sync::Notify::new());
        let task_trigger = std::sync::Arc::clone(&trigger);
        let (drain, mut drain_rx) = NetworkLogDrainProducer::channel(drain_source);
        self.drain = drain;
        self.task = Some(tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = token.cancelled() => {
                        return DrainableLineReaderExit::Cancelled;
                    }
                    request = drain_rx.recv() => {
                        let Some(request) = request else {
                            return DrainableLineReaderExit::DrainChannelClosed;
                        };
                        request.ack();
                    }
                    _ = task_trigger.notified() => {
                        panic!("simulated network-log monitor task panic");
                    }
                }
            }
        }));
        trigger
    }
}

impl Drop for NetworkLogProcess {
    fn drop(&mut self) {
        kill_and_reap_child_on_drop(self.child_label, &mut self.child);
        self.cancel.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

#[cfg(test)]
#[cfg(target_os = "linux")]
mod tests {
    use super::*;
    use crate::process::read_process_stat;
    use std::time::Duration;

    #[tokio::test]
    async fn drop_reaps_owned_child() {
        let child = tokio::process::Command::new("sleep")
            .arg("60")
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let starttime = read_process_stat(pid).await.unwrap().starttime;
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            task_cancel.cancelled().await;
            DrainableLineReaderExit::Cancelled
        });
        let (drain, _drain_rx) = NetworkLogDrainProducer::channel("drop-test");
        let process = NetworkLogProcess::new("drop-test", cancel, task, child, drain);

        drop(process);

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let observed_starttime = read_process_stat(pid).await.map(|stat| stat.starttime);
                if observed_starttime != Some(starttime) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("dropped network-log process should reap its child");
    }
}
