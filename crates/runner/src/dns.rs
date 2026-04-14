//! DNS proxy for sandbox VMs using dnsmasq.
//!
//! Spawns a dnsmasq process that serves as the DNS resolver for all VMs.
//! DNS queries are intercepted via iptables REDIRECT (PREROUTING chain)
//! and forwarded to upstream resolvers (8.8.8.8, 8.8.4.4).
//!
//! Defense-in-depth:
//! - Layer 1: iptables REDIRECT → dnsmasq port (working path, preserves source IP)
//! - Layer 2: iptables DROP external UDP 53 / TCP 853 (bypass prevention)
//!
//! VM resolv.conf points to an external nameserver (e.g. 8.8.8.8) as a dummy
//! target. The REDIRECT rule in PREROUTING intercepts all UDP 53 from the VM
//! subnet and redirects to dnsmasq before the packet reaches FORWARD/POSTROUTING.
//!
//! Log format: dnsmasq `--log-queries` outputs to stderr, parsed by a background
//! async task that writes per-VM network JSONL entries (same pattern as kmsg_log).

use std::path::Path;
use std::process::Stdio;

use chrono::Utc;
use tokio::io::AsyncBufReadExt;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::kmsg_log::IpLogMap;

/// Handle to the dnsmasq process and its log monitor.
pub struct DnsProxy {
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
    child: Option<tokio::process::Child>,
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

    /// Create a noop handle for testing. No `dnsmasq` process is spawned.
    #[cfg(test)]
    pub fn noop() -> Self {
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        Self {
            cancel,
            task: tokio::spawn(async move { token.cancelled().await }),
            child: None,
            port: 0,
        }
    }
}

impl Drop for DnsProxy {
    /// Kill dnsmasq and abort the log task if `stop()` was never called.
    ///
    /// Prevents orphaned dnsmasq processes when `run_start()` fails after
    /// `dns::start()` (e.g., runtime creation error). Harmless if `stop()`
    /// already ran — `start_kill` on an exited child is a no-op.
    fn drop(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.start_kill();
        }
        self.cancel.cancel();
        self.task.abort();
    }
}

/// Find an available port by binding to port 0.
///
/// Checks both TCP and UDP because dnsmasq binds both protocols.
fn find_available_port() -> std::io::Result<u16> {
    let tcp = std::net::TcpListener::bind("0.0.0.0:0")?;
    let port = tcp.local_addr()?.port();
    let _udp = std::net::UdpSocket::bind(("0.0.0.0", port))?;
    Ok(port)
}

/// Start dnsmasq and spawn a background task to parse its query log.
///
/// dnsmasq listens on a dynamically allocated port and forwards to upstream DNS.
/// Retries up to 3 times with a fresh port if the initial bind fails (TOCTOU race).
pub async fn start(ip_log_map: IpLogMap) -> std::io::Result<DnsProxy> {
    const MAX_ATTEMPTS: u32 = 3;
    let mut last_err = None;
    for attempt in 1..=MAX_ATTEMPTS {
        let port = match find_available_port() {
            Ok(p) => p,
            Err(e) => {
                warn!(attempt, error = %e, "failed to find available port");
                last_err = Some(e);
                continue;
            }
        };
        match try_start(port, &ip_log_map).await {
            Ok(proxy) => return Ok(proxy),
            Err(e) => {
                if attempt < MAX_ATTEMPTS {
                    warn!(port, attempt, error = %e, "dnsmasq failed to start, retrying with new port");
                } else {
                    warn!(port, attempt, error = %e, "dnsmasq failed to start, all attempts exhausted");
                }
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("dnsmasq failed to start")))
}

/// Try to start dnsmasq on the given port. Returns the proxy handle on success.
async fn try_start(port: u16, ip_log_map: &IpLogMap) -> std::io::Result<DnsProxy> {
    let port_str = port.to_string();

    let mut child = tokio::process::Command::new("dnsmasq")
        .args([
            "--no-daemon",
            "--no-resolv",
            "--port",
            &port_str,
            "--server",
            "8.8.8.8",
            "--server",
            "8.8.4.4",
            "--log-queries",
            "--log-facility=-",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;

    // Give dnsmasq a moment to bind, then verify it's still running.
    // Catches port-already-in-use, missing binary (spawn itself errors),
    // and bad config that causes immediate exit.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    match child.try_wait() {
        Ok(Some(status)) => {
            return Err(std::io::Error::other(format!(
                "dnsmasq exited immediately with {status}"
            )));
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
    let ip_log_map = ip_log_map.clone();
    let task = tokio::spawn(async move {
        if let Err(e) = tail_stderr(stderr, &ip_log_map, token).await {
            warn!(error = %e, "dns log monitor exited");
        }
    });

    info!(port, "dns proxy started");
    Ok(DnsProxy {
        cancel,
        task,
        child: Some(child),
        port,
    })
}

/// Tail dnsmasq stderr and write DNS query entries to per-VM network JSONL.
///
/// dnsmasq `--log-queries --log-facility=-` outputs lines like:
/// ```text
/// dnsmasq[1234]: query[A] api.github.com from 10.200.0.2
/// dnsmasq[1234]: forwarded api.github.com to 8.8.8.8
/// dnsmasq[1234]: reply api.github.com is 140.82.121.4
/// ```
///
/// We only parse `query[...]` lines — they contain the domain and source IP.
async fn tail_stderr(
    stderr: tokio::process::ChildStderr,
    ip_log_map: &IpLogMap,
    cancel: CancellationToken,
) -> std::io::Result<()> {
    let mut lines = tokio::io::BufReader::new(stderr).lines();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            result = lines.next_line() => {
                let line = match result {
                    Ok(Some(l)) => l,
                    Ok(None) => {
                        if !cancel.is_cancelled() {
                            warn!("dnsmasq exited unexpectedly (stderr EOF)");
                        }
                        break;
                    }
                    Err(e) => {
                        warn!(error = %e, "dnsmasq stderr read error");
                        break;
                    }
                };

                if let Some(entry) = parse_query_line(&line) {
                    let log_path = {
                        let map = ip_log_map.lock().await;
                        map.get(&entry.source_ip).cloned()
                    };
                    if let Some(path) = log_path {
                        write_jsonl(&path, &entry);
                    }
                }
            }
        }
    }
    Ok(())
}

/// Parsed DNS query entry.
struct DnsQueryEntry {
    source_ip: String,
    domain: String,
}

/// Parse a dnsmasq query log line.
///
/// Matches: `dnsmasq[PID]: query[TYPE] DOMAIN from IP`
fn parse_query_line(line: &str) -> Option<DnsQueryEntry> {
    // Find "query[" marker
    let q_start = line.find("query[")?;
    let q_end = line[q_start..].find(']')? + q_start;

    // Domain is after "] "
    let after_bracket = line.get(q_end + 2..)?;
    let domain_end = after_bracket.find(' ')?;
    let domain = after_bracket[..domain_end].to_string();

    // Source IP is after " from "
    let from_pos = after_bracket.find(" from ")?;
    let ip_start = from_pos + 6;
    let ip_str = after_bracket.get(ip_start..)?;
    // IP ends at whitespace or end of string
    let ip_end = ip_str
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(ip_str.len());
    let source_ip = ip_str[..ip_end].to_string();

    if source_ip.is_empty() {
        return None;
    }

    Some(DnsQueryEntry { source_ip, domain })
}

/// Append a JSON line to the network log file.
fn write_jsonl(path: &Path, entry: &DnsQueryEntry) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    // [NETWORK_LOG_FIELDS] — keep in sync with all network log schemas
    let json = serde_json::json!({
        "timestamp": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "type": "dns",
        "host": entry.domain,
        "port": 53,
    });

    let mut line = serde_json::to_string(&json).unwrap_or_default();
    line.push('\n');

    let result = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o644)
        .open(path)
        .and_then(|mut f| f.write_all(line.as_bytes()));

    if let Err(e) = result {
        debug!(path = %path.display(), error = %e, "failed to write dns network log");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_a_query() {
        let line = "dnsmasq[1234]: query[A] example.com from 10.200.0.2";
        let entry = parse_query_line(line).unwrap();
        assert_eq!(entry.source_ip, "10.200.0.2");
        assert_eq!(entry.domain, "example.com");
    }

    #[test]
    fn parse_aaaa_query() {
        let line = "dnsmasq[5678]: query[AAAA] google.com from 10.200.0.6";
        let entry = parse_query_line(line).unwrap();
        assert_eq!(entry.source_ip, "10.200.0.6");
        assert_eq!(entry.domain, "google.com");
    }

    #[test]
    fn parse_mx_query() {
        let line = "dnsmasq[9999]: query[MX] mail.example.com from 10.200.0.10";
        let entry = parse_query_line(line).unwrap();
        assert_eq!(entry.domain, "mail.example.com");
    }

    #[test]
    fn parse_txt_query() {
        let line = "dnsmasq[1111]: query[TXT] _dmarc.example.com from 10.200.0.2";
        let entry = parse_query_line(line).unwrap();
        assert_eq!(entry.domain, "_dmarc.example.com");
    }

    #[test]
    fn ignore_reply_lines() {
        let line = "dnsmasq[1234]: reply example.com is 93.184.216.34";
        assert!(parse_query_line(line).is_none());
    }

    #[test]
    fn ignore_forwarded_lines() {
        let line = "dnsmasq[1234]: forwarded example.com to 8.8.8.8";
        assert!(parse_query_line(line).is_none());
    }

    #[test]
    fn ignore_malformed() {
        assert!(parse_query_line("").is_none());
        assert!(parse_query_line("not a dns log").is_none());
        assert!(parse_query_line("dnsmasq[1]: query[A]").is_none());
    }

    #[test]
    fn parse_ip_with_port_suffix() {
        // Some dnsmasq versions append #port to the source address.
        let line = "dnsmasq[1234]: query[A] example.com from 10.200.0.2#54321";
        let entry = parse_query_line(line).unwrap();
        assert_eq!(entry.source_ip, "10.200.0.2");
        assert_eq!(entry.domain, "example.com");
    }

    #[test]
    fn parse_domain_containing_from() {
        let line = "dnsmasq[1234]: query[A] from.example.com from 10.200.0.2";
        let entry = parse_query_line(line).unwrap();
        assert_eq!(entry.domain, "from.example.com");
        assert_eq!(entry.source_ip, "10.200.0.2");
    }

    #[test]
    fn ignore_ipv6_source() {
        // VMs use IPv4 only; IPv6 sources should be ignored.
        let line = "dnsmasq[1234]: query[A] example.com from ::1";
        assert!(parse_query_line(line).is_none());
    }

    #[test]
    fn parse_trailing_carriage_return() {
        let line = "dnsmasq[1234]: query[A] example.com from 10.200.0.2\r";
        let entry = parse_query_line(line).unwrap();
        assert_eq!(entry.source_ip, "10.200.0.2");
    }

    #[test]
    fn write_jsonl_creates_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dns.jsonl");
        let entry = DnsQueryEntry {
            source_ip: "10.200.0.2".to_string(),
            domain: "api.github.com".to_string(),
        };
        write_jsonl(&path, &entry);
        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(content.trim()).unwrap();
        assert_eq!(parsed["type"], "dns");
        assert_eq!(parsed["host"], "api.github.com");
        assert_eq!(parsed["port"], 53);
        assert!(parsed["timestamp"].is_string());
    }

    #[test]
    fn write_jsonl_appends_multiple_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dns.jsonl");
        for domain in ["a.com", "b.com", "c.com"] {
            write_jsonl(
                &path,
                &DnsQueryEntry {
                    source_ip: "10.0.0.1".to_string(),
                    domain: domain.to_string(),
                },
            );
        }
        let content = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 3);
        for (i, domain) in ["a.com", "b.com", "c.com"].iter().enumerate() {
            let parsed: serde_json::Value = serde_json::from_str(lines[i]).unwrap();
            assert_eq!(parsed["host"], *domain);
        }
    }

    #[test]
    fn find_available_port_returns_nonzero() {
        let port = find_available_port().unwrap();
        assert!(port > 0);
    }
}
