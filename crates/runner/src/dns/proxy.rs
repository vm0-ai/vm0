use std::process::Stdio;

use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;
use tracing::info;

use sandbox_fc::{DNS_DIAGNOSTIC_HOSTNAME, DNS_READINESS_HOSTNAME, DNS_READINESS_IPV4};

use super::log::tail_stderr;
use super::port::DnsPortReservation;
use crate::child_cleanup::kill_and_reap_child_on_drop;
use crate::network_log_drain::{DrainableLineReaderExit, NetworkLogDrainProducer};
use crate::network_log_manager::NetworkLogManager;

/// Handle to the dnsmasq process and its log monitor.
pub struct DnsProxy {
    cancel: CancellationToken,
    task: Option<tokio::task::JoinHandle<DrainableLineReaderExit>>,
    child: Option<tokio::process::Child>,
    drain: NetworkLogDrainProducer,
    port: u16,
}

impl DnsProxy {
    /// Await the log monitor task, or pend forever after its completion has
    /// already been consumed.
    pub(crate) async fn wait(&mut self) -> Result<DrainableLineReaderExit, tokio::task::JoinError> {
        let result = match self.task.as_mut() {
            Some(task) => task.await,
            None => std::future::pending().await,
        };
        self.task = None;
        result
    }

    /// Kill dnsmasq when necessary and wait for it to be reaped.
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

    /// Stop the DNS proxy and wait for cleanup.
    pub async fn stop(mut self) {
        self.cancel.cancel();
        self.kill_and_reap_child().await;
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
        info!("dns proxy stopped");
    }

    /// Return the port dnsmasq is listening on.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Return a clone of the DNS network-log drain producer.
    ///
    /// `NetworkLogDrainCoordinator` uses this to ask the dnsmasq stderr reader
    /// task to drain complete log rows already visible to that task.
    pub(crate) fn drain_producer(&self) -> NetworkLogDrainProducer {
        self.drain.clone()
    }

    /// Create a noop handle for testing. No `dnsmasq` process is spawned.
    #[cfg(test)]
    pub fn noop() -> Self {
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let (drain, mut drain_rx) = NetworkLogDrainProducer::channel("dns");
        Self {
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
            port: 0,
        }
    }

    async fn from_started_child(
        mut child: tokio::process::Child,
        port: u16,
        network_log_manager: NetworkLogManager,
    ) -> std::io::Result<Self> {
        let Some(stderr) = child.stderr.take() else {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(std::io::Error::other("failed to capture dnsmasq stderr"));
        };

        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let (drain, drain_rx) = NetworkLogDrainProducer::channel("dns");
        let task = tokio::spawn(tail_stderr(stderr, network_log_manager, token, drain_rx));

        Ok(Self {
            cancel,
            task: Some(task),
            child: Some(child),
            drain,
            port,
        })
    }

    #[cfg(test)]
    pub(crate) async fn from_test_child(
        child: tokio::process::Child,
        network_log_manager: NetworkLogManager,
    ) -> std::io::Result<Self> {
        Self::from_started_child(child, 0, network_log_manager).await
    }

    /// Replace the stderr monitor with a task that panics when triggered.
    #[cfg(test)]
    pub(crate) async fn replace_monitor_with_panic_trigger_for_test(
        &mut self,
    ) -> std::sync::Arc<tokio::sync::Notify> {
        let task = self.task.take().expect("DNS monitor task should exist");
        task.abort();
        let error = task
            .await
            .expect_err("aborted DNS monitor task should return a join error");
        assert!(
            error.is_cancelled(),
            "aborted DNS monitor task should be cancelled: {error}",
        );

        let token = self.cancel.clone();
        let trigger = std::sync::Arc::new(tokio::sync::Notify::new());
        let task_trigger = std::sync::Arc::clone(&trigger);
        let (drain, mut drain_rx) = NetworkLogDrainProducer::channel("dns");
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
                        panic!("simulated DNS monitor task panic");
                    }
                }
            }
        }));
        trigger
    }
}

impl Drop for DnsProxy {
    /// Kill dnsmasq and abort the log task if `stop()` was never called.
    ///
    /// Prevents orphaned dnsmasq processes when shutdown misses the explicit
    /// async `stop()` path. The cleanup helper also reaps children that already
    /// exited before drop.
    fn drop(&mut self) {
        kill_and_reap_child_on_drop("dnsmasq", &mut self.child);
        self.cancel.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

/// Start dnsmasq and spawn a background task to parse its query log.
///
/// dnsmasq listens on a dynamically allocated port and forwards to upstream DNS.
/// The port is reserved before netns setup so iptables can redirect to a stable
/// value, then released immediately before spawning dnsmasq.
pub async fn start_on_reserved_port(
    reservation: DnsPortReservation,
    interface_pattern: String,
    network_log_manager: NetworkLogManager,
) -> std::io::Result<DnsProxy> {
    let port = reservation.port();
    drop(reservation);
    try_start(port, &interface_pattern, network_log_manager).await
}

/// Try to start dnsmasq on the given port. Returns the proxy handle on success.
async fn try_start(
    port: u16,
    interface_pattern: &str,
    network_log_manager: NetworkLogManager,
) -> std::io::Result<DnsProxy> {
    let expected_parent = nix::unistd::getpid();
    let mut command = tokio::process::Command::new("dnsmasq");
    command
        .args(dnsmasq_args(port, interface_pattern))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // SAFETY: `set_pdeathsig` and `getppid` are async-signal-safe. Checking the
    // parent after installing the signal closes the fork-to-prctl race: if the
    // runner already exited, the child fails before exec instead of creating an
    // unowned wildcard listener.
    unsafe {
        command.pre_exec(move || {
            nix::sys::prctl::set_pdeathsig(nix::sys::signal::Signal::SIGKILL)
                .map_err(std::io::Error::from)?;
            if nix::unistd::getppid() != expected_parent {
                return Err(std::io::Error::from_raw_os_error(nix::libc::ESRCH));
            }
            Ok(())
        });
    }

    let mut child = command.spawn()?;

    // Give dnsmasq a moment to bind, then verify it's still running.
    // Catches port-already-in-use, missing binary (spawn itself errors),
    // and bad config that causes immediate exit.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    match child.try_wait() {
        Ok(Some(status)) => {
            let stderr = read_child_stderr(&mut child).await;
            return Err(dnsmasq_immediate_exit_error(status, &stderr));
        }
        Err(e) => {
            let _ = child.kill().await;
            return Err(std::io::Error::other(format!(
                "dnsmasq process check failed: {e}"
            )));
        }
        Ok(None) => {} // still running — good
    }

    let proxy = DnsProxy::from_started_child(child, port, network_log_manager).await?;
    info!(port, "dns proxy started");
    Ok(proxy)
}

fn dnsmasq_immediate_exit_error(status: std::process::ExitStatus, stderr: &str) -> std::io::Error {
    let trimmed = stderr.trim();
    let message = if trimmed.is_empty() {
        format!("dnsmasq exited immediately with {status}")
    } else {
        format!("dnsmasq exited immediately with {status}: {trimmed}")
    };
    std::io::Error::new(dnsmasq_immediate_exit_error_kind(trimmed), message)
}

fn dnsmasq_immediate_exit_error_kind(stderr: &str) -> std::io::ErrorKind {
    if stderr
        .to_ascii_lowercase()
        .contains("address already in use")
    {
        std::io::ErrorKind::AddrInUse
    } else {
        std::io::ErrorKind::Other
    }
}

async fn read_child_stderr(child: &mut tokio::process::Child) -> String {
    let Some(mut stderr) = child.stderr.take() else {
        return String::new();
    };
    let mut output = String::new();
    if stderr.read_to_string(&mut output).await.is_err() {
        return String::new();
    }
    output
}

fn dnsmasq_args(port: u16, interface_pattern: &str) -> Vec<String> {
    vec![
        "--no-daemon".into(),
        "--no-resolv".into(),
        "--port".into(),
        port.to_string(),
        // Keep dnsmasq's default wildcard sockets so VM host-side veth churn
        // cannot rebuild a per-address listener set in its query event loop.
        // --interface still validates the arrival interface for every request.
        format!("--interface={interface_pattern}"),
        format!("--address=/{DNS_READINESS_HOSTNAME}/{DNS_READINESS_IPV4}"),
        format!("--local=/{DNS_READINESS_HOSTNAME}/"),
        format!("--address=/{DNS_DIAGNOSTIC_HOSTNAME}/{DNS_READINESS_IPV4}"),
        format!("--local=/{DNS_DIAGNOSTIC_HOSTNAME}/"),
        "--server".into(),
        "8.8.8.8".into(),
        "--server".into(),
        "8.8.4.4".into(),
        "--log-queries=extra".into(),
        "--log-facility=-".into(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dnsmasq_args_use_wildcard_sockets_with_vm_interface_access_control() {
        let args = dnsmasq_args(5353, "vm0-ve-0a-*");

        assert!(args.contains(&"--interface=vm0-ve-0a-*".to_string()));
        assert!(!args.contains(&"--bind-dynamic".to_string()));
        assert!(!args.contains(&"--bind-interfaces".to_string()));
    }

    #[test]
    fn dnsmasq_args_preserve_port_upstream_and_logging_config() {
        let args = dnsmasq_args(5353, "vm0-ve-0a-*");

        assert_eq!(
            args,
            vec![
                "--no-daemon",
                "--no-resolv",
                "--port",
                "5353",
                "--interface=vm0-ve-0a-*",
                "--address=/vm0-readiness.invalid/192.0.2.1",
                "--local=/vm0-readiness.invalid/",
                "--address=/vm0-diagnostic.invalid/192.0.2.1",
                "--local=/vm0-diagnostic.invalid/",
                "--server",
                "8.8.8.8",
                "--server",
                "8.8.4.4",
                "--log-queries=extra",
                "--log-facility=-",
            ]
        );
    }

    #[test]
    fn dnsmasq_immediate_exit_error_kind_detects_port_race() {
        let stderr =
            "dnsmasq: failed to create listening socket for 127.0.0.1: Address already in use";

        assert_eq!(
            dnsmasq_immediate_exit_error_kind(stderr),
            std::io::ErrorKind::AddrInUse
        );
    }

    #[test]
    fn dnsmasq_immediate_exit_error_kind_keeps_non_port_errors_fatal() {
        let stderr =
            "dnsmasq: failed to create listening socket for 10.200.52.97: Too many open files";

        assert_eq!(
            dnsmasq_immediate_exit_error_kind(stderr),
            std::io::ErrorKind::Other
        );
    }
}
