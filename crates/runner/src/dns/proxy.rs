use std::process::Stdio;

use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::log::tail_stderr;
use super::port::DnsPortReservation;
use crate::network_log_drain::NetworkLogDrainProducer;
use crate::network_log_manager::NetworkLogManager;

/// Handle to the dnsmasq process and its log monitor.
pub struct DnsProxy {
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
    child: Option<tokio::process::Child>,
    drain: NetworkLogDrainProducer,
    port: u16,
}

impl DnsProxy {
    /// Stop the DNS proxy and wait for cleanup.
    pub async fn stop(mut self) {
        self.cancel.cancel();
        if let Some(ref mut child) = self.child {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        let _ = (&mut self.task).await;
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
            task: tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = token.cancelled() => break,
                        request = drain_rx.recv() => {
                            let Some(request) = request else {
                                break;
                            };
                            request.ack();
                        }
                    }
                }
            }),
            child: None,
            drain,
            port: 0,
        }
    }
}

impl Drop for DnsProxy {
    /// Kill dnsmasq and abort the log task if `stop()` was never called.
    ///
    /// Prevents orphaned dnsmasq processes when `run_start()` fails after
    /// `start_on_reserved_port()` (e.g., live-runner publish error). Harmless
    /// if `stop()` already ran — `start_kill` on an exited child is a no-op.
    fn drop(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.start_kill();
        }
        self.cancel.cancel();
        self.task.abort();
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
    let mut child = tokio::process::Command::new("dnsmasq")
        .args(dnsmasq_args(port, interface_pattern))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;

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

    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill().await;
        return Err(std::io::Error::other("failed to capture dnsmasq stderr"));
    };

    let cancel = CancellationToken::new();
    let token = cancel.clone();
    let (drain, drain_rx) = NetworkLogDrainProducer::channel("dns");
    let task = tokio::spawn(async move {
        if let Err(e) = tail_stderr(stderr, network_log_manager, token, drain_rx).await {
            warn!(error = %e, "dns log monitor exited");
        }
    });

    info!(port, "dns proxy started");
    Ok(DnsProxy {
        cancel,
        task,
        child: Some(child),
        drain,
        port,
    })
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
        // VM host-side veth devices are created after dnsmasq starts.
        format!("--interface={interface_pattern}"),
        "--bind-dynamic".into(),
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
    fn dnsmasq_args_restrict_listener_to_vm_interface_pattern() {
        let args = dnsmasq_args(5353, "vm0-ve-0a-*");

        assert!(args.contains(&"--interface=vm0-ve-0a-*".to_string()));
        assert!(args.contains(&"--bind-dynamic".to_string()));
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
                "--bind-dynamic",
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
