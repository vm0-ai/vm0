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
//! Log format: dnsmasq `--log-queries=extra` outputs to stderr, parsed by a background
//! async task that submits per-VM network JSON rows through `NetworkLogManager`.

use std::{borrow::Cow, process::Stdio};

use chrono::{DateTime, Utc};
use tokio::io::{AsyncBufRead, AsyncBufReadExt};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::network_log_drain::{
    NetworkLogDrainProducer, NetworkLogDrainRequest, ReadyLine, poll_next_line_ready,
};
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
    const MAX_PORT_PROBE_ATTEMPTS: usize = 64;

    find_available_port_from(
        (0..MAX_PORT_PROBE_ATTEMPTS).map(|_| std::net::TcpListener::bind("0.0.0.0:0")),
    )
}

fn find_available_port_from<I>(tcp_candidates: I) -> std::io::Result<u16>
where
    I: IntoIterator<Item = std::io::Result<std::net::TcpListener>>,
{
    let mut last_addr_in_use = None;
    for tcp in tcp_candidates {
        let tcp = tcp?;
        let port = tcp.local_addr()?.port();
        match std::net::UdpSocket::bind(("0.0.0.0", port)) {
            Ok(_udp) => return Ok(port),
            Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
                last_addr_in_use = Some(err);
            }
            Err(err) => return Err(err),
        }
    }

    Err(last_addr_in_use.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AddrInUse,
            "could not find a port available for both TCP and UDP",
        )
    }))
}

/// Start dnsmasq and spawn a background task to parse its query log.
///
/// dnsmasq listens on a dynamically allocated port and forwards to upstream DNS.
/// Retries up to 3 times with a fresh port if the initial bind fails (TOCTOU race).
pub async fn start(network_log_manager: NetworkLogManager) -> std::io::Result<DnsProxy> {
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
        match try_start(port, network_log_manager.clone()).await {
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
async fn try_start(port: u16, network_log_manager: NetworkLogManager) -> std::io::Result<DnsProxy> {
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
            "--log-queries=extra",
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

/// Tail dnsmasq stderr and write DNS log entries to per-VM network JSONL.
///
/// dnsmasq `--log-queries=extra --log-facility=-` outputs lines like:
/// ```text
/// dnsmasq[1234]: 42 10.200.0.2/54321 query[A] api.github.com from 10.200.0.2
/// dnsmasq[1234]: 42 10.200.0.2/54321 forwarded api.github.com to 8.8.8.8
/// dnsmasq[1234]: 42 10.200.0.2/54321 reply api.github.com is 140.82.121.4
/// ```
///
/// We parse query and answer/result lines. `forwarded` lines are intentionally
/// not emitted as network-log rows because they describe resolver selection,
/// not a sandbox-visible DNS result.
async fn tail_stderr(
    stderr: tokio::process::ChildStderr,
    network_log_manager: NetworkLogManager,
    cancel: CancellationToken,
    drain_rx: mpsc::Receiver<NetworkLogDrainRequest>,
) -> std::io::Result<()> {
    tail_reader(
        tokio::io::BufReader::new(stderr),
        network_log_manager,
        cancel,
        drain_rx,
    )
    .await
}

async fn tail_reader<R>(
    reader: R,
    network_log_manager: NetworkLogManager,
    cancel: CancellationToken,
    mut drain_rx: mpsc::Receiver<NetworkLogDrainRequest>,
) -> std::io::Result<()>
where
    R: AsyncBufRead + Unpin,
{
    let mut lines = reader.lines();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            request = drain_rx.recv() => {
                let Some(request) = request else {
                    break;
                };
                let outcome = drain_ready_lines(&mut lines, &network_log_manager).await;
                request.ack();
                if let DrainOutcome::Stop(result) = outcome {
                    result?;
                    break;
                }
            }
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

                handle_dns_line(&network_log_manager, &line).await;
            }
        }
    }
    Ok(())
}

enum DrainOutcome {
    Continue,
    Stop(std::io::Result<()>),
}

async fn drain_ready_lines<R>(
    lines: &mut tokio::io::Lines<R>,
    network_log_manager: &NetworkLogManager,
) -> DrainOutcome
where
    R: AsyncBufRead + Unpin,
{
    loop {
        match poll_next_line_ready(lines) {
            Ok(ReadyLine::Line(line)) => handle_dns_line(network_log_manager, &line).await,
            Ok(ReadyLine::Pending) => return DrainOutcome::Continue,
            Ok(ReadyLine::Eof) => return DrainOutcome::Stop(Ok(())),
            Err(e) => return DrainOutcome::Stop(Err(e)),
        }
    }
}

async fn handle_dns_line(network_log_manager: &NetworkLogManager, line: &str) {
    if let Some(entry) = parse_dns_line(line) {
        // Capture the timestamp before handing the row to the manager so
        // it reflects DNS observation time, not delayed write time.
        let timestamp = Utc::now();
        append_dns_entry(network_log_manager, &entry, timestamp).await;
    }
}

/// Parsed DNS log entry.
struct DnsLogEntry<'a> {
    source_ip: &'a str,
    domain: &'a str,
    serial: &'a str,
    event: DnsEvent<'a>,
}

enum DnsEvent<'a> {
    Query {
        query_type: &'a str,
    },
    Result {
        kind: DnsResultKind,
        result: Cow<'a, str>,
    },
}

impl DnsEvent<'_> {
    fn name(&self) -> &'static str {
        match self {
            Self::Query { .. } => "query",
            Self::Result { kind, .. } => kind.name(),
        }
    }
}

enum DnsResultKind {
    Reply,
    Cached,
    Config,
}

impl DnsResultKind {
    fn parse(token: &str) -> Option<Self> {
        match token {
            "reply" => Some(Self::Reply),
            "cached" => Some(Self::Cached),
            "config" => Some(Self::Config),
            _ => None,
        }
    }

    fn name(&self) -> &'static str {
        match self {
            Self::Reply => "reply",
            Self::Cached => "cached",
            Self::Config => "config",
        }
    }
}

/// Parse a dnsmasq DNS log line.
///
/// Matches dnsmasq `--log-queries=extra` output:
///
/// - `dnsmasq[PID]: SERIAL IP/PORT query[TYPE] DOMAIN from IP`
/// - `dnsmasq[PID]: SERIAL IP/PORT reply DOMAIN is RESULT`
/// - `dnsmasq[PID]: SERIAL IP/PORT cached DOMAIN is RESULT`
/// - `dnsmasq[PID]: SERIAL IP/PORT config DOMAIN is RESULT`
fn parse_dns_line(line: &str) -> Option<DnsLogEntry<'_>> {
    let mut tokens = line.split_whitespace();
    let mut prev_prev = None;
    let mut prev = None;

    while let Some(token) = tokens.next() {
        if token.starts_with("query[")
            && let Some(entry) = parse_extra_query(prev_prev, prev, token, tokens.clone())
        {
            return Some(entry);
        }
        if matches!(token, "reply" | "cached" | "config")
            && let Some(entry) = parse_extra_result(prev_prev, prev, token, tokens.clone())
        {
            return Some(entry);
        }
        prev_prev = prev;
        prev = Some(token);
    }
    None
}

fn parse_extra_query<'a>(
    serial: Option<&'a str>,
    requestor: Option<&'a str>,
    token: &'a str,
    mut tokens: std::str::SplitWhitespace<'a>,
) -> Option<DnsLogEntry<'a>> {
    let (serial, source_ip) = parse_extra_prefix(serial, requestor)?;
    let query_type = parse_query_type(token)?;
    let domain = tokens.next()?;
    if tokens.next()? != "from" {
        return None;
    }
    extract_ipv4_requestor(tokens.next()?)?;
    Some(DnsLogEntry {
        source_ip,
        domain,
        serial,
        event: DnsEvent::Query { query_type },
    })
}

fn parse_extra_result<'a>(
    serial: Option<&'a str>,
    requestor: Option<&'a str>,
    token: &'a str,
    mut tokens: std::str::SplitWhitespace<'a>,
) -> Option<DnsLogEntry<'a>> {
    let (serial, source_ip) = parse_extra_prefix(serial, requestor)?;
    let kind = DnsResultKind::parse(token)?;
    let domain = tokens.next()?;
    if tokens.next()? != "is" {
        return None;
    }
    let first_result = tokens.next()?;
    let result = if tokens.clone().next().is_none() {
        Cow::Borrowed(first_result)
    } else {
        let mut result = first_result.to_string();
        for token in tokens {
            result.push(' ');
            result.push_str(token);
        }
        Cow::Owned(result)
    };
    Some(DnsLogEntry {
        source_ip,
        domain,
        serial,
        event: DnsEvent::Result { kind, result },
    })
}

fn parse_extra_prefix<'a>(
    serial: Option<&'a str>,
    requestor: Option<&'a str>,
) -> Option<(&'a str, &'a str)> {
    let serial = serial?;
    if serial.is_empty() || !serial.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let source_ip = extract_ipv4_requestor(requestor?)?;
    Some((serial, source_ip))
}

fn parse_query_type(token: &str) -> Option<&str> {
    let start = token.find('[')? + 1;
    let end = token[start..].find(']')? + start;
    let query_type = &token[start..end];
    if query_type.is_empty() {
        return None;
    }
    Some(query_type)
}

fn extract_ipv4_requestor(token: &str) -> Option<&str> {
    let ip = token.split(['/', '#']).next()?;
    if ip.parse::<std::net::Ipv4Addr>().is_ok() {
        Some(ip)
    } else {
        None
    }
}

async fn append_dns_entry(
    network_log_manager: &NetworkLogManager,
    entry: &DnsLogEntry<'_>,
    timestamp: DateTime<Utc>,
) -> bool {
    network_log_manager
        .append_for_ip(entry.source_ip, network_log_row(entry, timestamp))
        .await
}

fn network_log_row(entry: &DnsLogEntry<'_>, timestamp: DateTime<Utc>) -> serde_json::Value {
    // [NETWORK_LOG_FIELDS] — shared schema consumed by api-contracts.
    let mut json = serde_json::json!({
        "timestamp": timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "type": "dns",
        "host": entry.domain,
        "port": 53,
    });
    if let Some(object) = json.as_object_mut() {
        object.insert(
            "dns_event".to_string(),
            serde_json::Value::String(entry.event.name().to_string()),
        );
        match &entry.event {
            DnsEvent::Query { query_type } => {
                object.insert(
                    "dns_query_type".to_string(),
                    serde_json::Value::String((*query_type).to_string()),
                );
            }
            DnsEvent::Result { result, .. } => {
                object.insert(
                    "dns_result".to_string(),
                    serde_json::Value::String(result.to_string()),
                );
            }
        }
        object.insert(
            "dns_serial".to_string(),
            serde_json::Value::String(entry.serial.to_string()),
        );
    }

    json
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::RunId;
    use crate::network_log_drain::NetworkLogDrainContext;
    use tokio::io::AsyncWriteExt;

    fn assert_query_event(entry: &DnsLogEntry<'_>, expected_query_type: &str) {
        assert_eq!(entry.event.name(), "query");
        match &entry.event {
            DnsEvent::Query { query_type } => assert_eq!(*query_type, expected_query_type),
            DnsEvent::Result { .. } => panic!("expected query event"),
        }
    }

    fn assert_result_event(entry: &DnsLogEntry<'_>, expected_kind: &str, expected_result: &str) {
        assert_eq!(entry.event.name(), expected_kind);
        match &entry.event {
            DnsEvent::Result { result, .. } => assert_eq!(result.as_ref(), expected_result),
            DnsEvent::Query { .. } => panic!("expected result event"),
        }
    }

    #[test]
    fn parse_extra_query_with_serial_and_requestor() {
        let line = "dnsmasq[1234]: 42 10.200.0.2/54321 query[A] api.github.com from 10.200.0.2";
        let entry = parse_dns_line(line).unwrap();
        assert_eq!(entry.source_ip, "10.200.0.2");
        assert_eq!(entry.domain, "api.github.com");
        assert_query_event(&entry, "A");
        assert_eq!(entry.serial, "42");
    }

    #[test]
    fn parse_extra_query_with_hash_port_requestor() {
        let line = "dnsmasq[1234]: 42 10.200.0.2#54321 query[A] api.github.com from 10.200.0.2";
        let entry = parse_dns_line(line).unwrap();
        assert_eq!(entry.source_ip, "10.200.0.2");
        assert_eq!(entry.domain, "api.github.com");
        assert_eq!(entry.serial, "42");
    }

    #[test]
    fn parse_extra_query_with_syslog_prefix() {
        let line = "Apr 28 12:00:00 runner dnsmasq[1234]: 314 10.200.0.9/41234 query[AAAA] google.com from 10.200.0.9";
        let entry = parse_dns_line(line).unwrap();
        assert_eq!(entry.source_ip, "10.200.0.9");
        assert_eq!(entry.domain, "google.com");
        assert_query_event(&entry, "AAAA");
        assert_eq!(entry.serial, "314");
    }

    #[test]
    fn parse_dns_line_skips_unrelated_prefix_tokens() {
        let line = "Apr 28 config runner reply dnsmasq[1234]: 314 10.200.0.9/41234 query[AAAA] google.com from 10.200.0.9";
        let entry = parse_dns_line(line).unwrap();
        assert_eq!(entry.source_ip, "10.200.0.9");
        assert_eq!(entry.domain, "google.com");
        assert_query_event(&entry, "AAAA");
        assert_eq!(entry.serial, "314");
    }

    #[test]
    fn parse_dns_line_continues_after_failed_lookahead_candidate() {
        let line = "dnsmasq[1234]: 1 10.200.0.2/54321 reply 314 10.200.0.9/41234 query[AAAA] google.com from 10.200.0.9";
        let entry = parse_dns_line(line).unwrap();
        assert_eq!(entry.source_ip, "10.200.0.9");
        assert_eq!(entry.domain, "google.com");
        assert_query_event(&entry, "AAAA");
        assert_eq!(entry.serial, "314");
    }

    #[test]
    fn parse_dns_line_continues_after_failed_query_lookahead_candidate() {
        let line = "dnsmasq[1234]: 1 10.200.0.2/54321 query[A] 314 10.200.0.9/41234 reply api.github.com is 140.82.121.4";
        let entry = parse_dns_line(line).unwrap();
        assert_eq!(entry.source_ip, "10.200.0.9");
        assert_eq!(entry.domain, "api.github.com");
        assert_result_event(&entry, "reply", "140.82.121.4");
        assert_eq!(entry.serial, "314");
    }

    #[test]
    fn parse_extra_reply_result() {
        let line = "dnsmasq[1234]: 42 10.200.0.2/54321 reply api.github.com is 140.82.121.4";
        let entry = parse_dns_line(line).unwrap();
        assert_eq!(entry.source_ip, "10.200.0.2");
        assert_eq!(entry.domain, "api.github.com");
        assert_result_event(&entry, "reply", "140.82.121.4");
        assert_eq!(entry.serial, "42");
    }

    #[test]
    fn parse_extra_cached_result() {
        let line = "dnsmasq[1234]: 42 10.200.0.2/54321 cached api.github.com is 140.82.121.4";
        let entry = parse_dns_line(line).unwrap();
        assert_result_event(&entry, "cached", "140.82.121.4");
    }

    #[test]
    fn parse_extra_config_result() {
        let line =
            "dnsmasq[1234]: 42 10.200.0.2/54321 config metadata.google.internal is 169.254.169.254";
        let entry = parse_dns_line(line).unwrap();
        assert_eq!(entry.domain, "metadata.google.internal");
        assert_result_event(&entry, "config", "169.254.169.254");
    }

    #[test]
    fn parse_extra_negative_result() {
        let line = "dnsmasq[1234]: 42 10.200.0.2/54321 reply missing.example.com is NXDOMAIN";
        let entry = parse_dns_line(line).unwrap();
        assert_eq!(entry.domain, "missing.example.com");
        assert_result_event(&entry, "reply", "NXDOMAIN");
    }

    #[test]
    fn parse_extra_result_preserves_multi_token_result() {
        let line =
            "dnsmasq[1234]: 42 10.200.0.2/54321 reply example.com is <CNAME> target.example.com";
        let entry = parse_dns_line(line).unwrap();
        assert_result_event(&entry, "reply", "<CNAME> target.example.com");
    }

    #[test]
    fn parse_extra_result_with_trailing_carriage_return() {
        let line = "dnsmasq[1234]: 42 10.200.0.2/54321 reply example.com is 1.2.3.4\r";
        let entry = parse_dns_line(line).unwrap();
        assert_result_event(&entry, "reply", "1.2.3.4");
    }

    #[test]
    fn ignore_plain_log_queries_without_extra_metadata() {
        let line = "dnsmasq[1234]: query[A] example.com from 10.200.0.2";
        assert!(parse_dns_line(line).is_none());
    }

    #[test]
    fn ignore_plain_reply_lines_without_extra_metadata() {
        let line = "dnsmasq[1234]: reply example.com is 93.184.216.34";
        assert!(parse_dns_line(line).is_none());
    }

    #[test]
    fn ignore_forwarded_lines() {
        let extra = "dnsmasq[1234]: 42 10.200.0.2/54321 forwarded example.com to 8.8.8.8";
        assert!(parse_dns_line(extra).is_none());
    }

    #[test]
    fn ignore_malformed() {
        assert!(parse_dns_line("").is_none());
        assert!(parse_dns_line("not a dns log").is_none());
        assert!(parse_dns_line("dnsmasq[1]: query[A]").is_none());
        assert!(parse_dns_line("dnsmasq[1]: 42 10.200.0.2/54321 query[A]").is_none());
        assert!(parse_dns_line("dnsmasq[1]: 42 10.200.0.2/54321 reply example.com").is_none());
        assert!(
            parse_dns_line("dnsmasq[1]: abc 10.200.0.2/54321 reply example.com is 1.2.3.4")
                .is_none()
        );
    }

    #[test]
    fn parse_extra_domain_containing_from() {
        let line = "dnsmasq[1234]: 42 10.200.0.2/54321 query[A] from.example.com from 10.200.0.2";
        let entry = parse_dns_line(line).unwrap();
        assert_eq!(entry.domain, "from.example.com");
        assert_eq!(entry.source_ip, "10.200.0.2");
    }

    #[test]
    fn ignore_ipv6_source() {
        // VMs use IPv4 only; IPv6 sources should be ignored.
        let extra = "dnsmasq[1234]: 42 ::1/54321 reply example.com is 93.184.216.34";
        assert!(parse_dns_line(extra).is_none());
    }

    #[test]
    fn network_log_row_serializes_provided_timestamp() {
        // Locks the contract that row construction must use the provided
        // timestamp rather than calling `Utc::now()` internally.
        let entry = DnsLogEntry {
            source_ip: "10.200.0.2",
            domain: "example.com",
            serial: "42",
            event: DnsEvent::Query { query_type: "A" },
        };
        let ts = DateTime::parse_from_rfc3339("2024-01-15T10:30:45.123Z")
            .unwrap()
            .with_timezone(&Utc);
        let parsed = network_log_row(&entry, ts);
        assert_eq!(parsed["timestamp"], "2024-01-15T10:30:45.123Z");
    }

    #[test]
    fn network_log_row_serializes_query_fields() {
        let entry = DnsLogEntry {
            source_ip: "10.200.0.2",
            domain: "example.com",
            serial: "42",
            event: DnsEvent::Query { query_type: "AAAA" },
        };

        let parsed = network_log_row(&entry, Utc::now());

        assert_eq!(parsed["type"], "dns");
        assert_eq!(parsed["host"], "example.com");
        assert_eq!(parsed["port"], 53);
        assert_eq!(parsed["dns_event"], "query");
        assert_eq!(parsed["dns_query_type"], "AAAA");
        assert_eq!(parsed["dns_serial"], "42");
        assert_eq!(parsed.get("dns_result"), None);
    }

    #[tokio::test]
    async fn append_dns_entry_registered_source_writes_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dns.jsonl");
        let manager = NetworkLogManager::new();
        let _session = manager.register_source_ip("10.200.0.2", path.clone()).await;
        let entry = DnsLogEntry {
            source_ip: "10.200.0.2",
            domain: "api.github.com",
            serial: "42",
            event: DnsEvent::Result {
                kind: DnsResultKind::Reply,
                result: Cow::Borrowed("140.82.121.4"),
            },
        };
        assert!(append_dns_entry(&manager, &entry, Utc::now()).await);
        manager.flush_path(&path).await;
        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(content.trim()).unwrap();
        assert_eq!(parsed["type"], "dns");
        assert_eq!(parsed["host"], "api.github.com");
        assert_eq!(parsed["port"], 53);
        assert_eq!(parsed["dns_event"], "reply");
        assert_eq!(parsed["dns_result"], "140.82.121.4");
        assert_eq!(parsed["dns_serial"], "42");
        assert_eq!(parsed.get("dns_query_type"), None);
        assert!(parsed["timestamp"].is_string());
    }

    #[tokio::test]
    async fn append_dns_entry_appends_multiple_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dns.jsonl");
        let manager = NetworkLogManager::new();
        let _session = manager.register_source_ip("10.0.0.1", path.clone()).await;
        for domain in ["a.com", "b.com", "c.com"] {
            assert!(
                append_dns_entry(
                    &manager,
                    &DnsLogEntry {
                        source_ip: "10.0.0.1",
                        domain,
                        serial: "42",
                        event: DnsEvent::Result {
                            kind: DnsResultKind::Reply,
                            result: Cow::Borrowed("1.2.3.4"),
                        },
                    },
                    Utc::now(),
                )
                .await
            );
        }
        manager.flush_path(&path).await;
        let content = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 3);
        let hosts: std::collections::HashSet<String> = lines
            .iter()
            .map(|line| {
                let parsed: serde_json::Value = serde_json::from_str(line).unwrap();
                parsed["host"].as_str().unwrap().to_string()
            })
            .collect();
        assert_eq!(
            hosts,
            ["a.com", "b.com", "c.com"]
                .into_iter()
                .map(str::to_string)
                .collect()
        );
    }

    #[tokio::test]
    async fn append_dns_entry_preserves_multiple_answers_for_same_query() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dns.jsonl");
        let manager = NetworkLogManager::new();
        let _session = manager.register_source_ip("10.0.0.1", path.clone()).await;

        for result in ["140.82.121.3", "140.82.121.4"] {
            assert!(
                append_dns_entry(
                    &manager,
                    &DnsLogEntry {
                        source_ip: "10.0.0.1",
                        domain: "api.github.com",
                        serial: "42",
                        event: DnsEvent::Result {
                            kind: DnsResultKind::Reply,
                            result: Cow::Borrowed(result),
                        },
                    },
                    Utc::now(),
                )
                .await
            );
        }

        manager.flush_path(&path).await;
        let content = std::fs::read_to_string(&path).unwrap();
        let mut results: Vec<String> = content
            .lines()
            .map(|line| {
                let parsed: serde_json::Value = serde_json::from_str(line).unwrap();
                assert_eq!(parsed["host"], "api.github.com");
                assert_eq!(parsed["dns_event"], "reply");
                assert_eq!(parsed["dns_serial"], "42");
                parsed["dns_result"].as_str().unwrap().to_string()
            })
            .collect();
        results.sort();
        assert_eq!(results, ["140.82.121.3", "140.82.121.4"]);
    }

    #[tokio::test]
    async fn append_dns_entry_without_mapping_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ignored.jsonl");
        let manager = NetworkLogManager::new();

        assert!(
            !append_dns_entry(
                &manager,
                &DnsLogEntry {
                    source_ip: "10.0.0.1",
                    domain: "ignored.test",
                    serial: "42",
                    event: DnsEvent::Query { query_type: "A" },
                },
                Utc::now(),
            )
            .await
        );
        manager.flush_path(&path).await;
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn drain_barrier_processes_queued_dns_line_before_ack() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dns.jsonl");
        let manager = NetworkLogManager::new();
        let _session = manager.register_source_ip("10.0.0.1", path.clone()).await;
        let cancel = CancellationToken::new();
        let (producer, drain_rx) = NetworkLogDrainProducer::channel("dns-test");
        let (mut writer, reader) = tokio::io::duplex(1024);
        let task = tokio::spawn(tail_reader(
            tokio::io::BufReader::new(reader),
            manager.clone(),
            cancel.clone(),
            drain_rx,
        ));

        writer
            .write_all(b"dnsmasq[1234]: 42 10.0.0.1/54321 query[A] example.com from 10.0.0.1\n")
            .await
            .unwrap();

        producer
            .drain(
                NetworkLogDrainContext {
                    run_id: RunId::nil(),
                    source_ip: "10.0.0.1",
                    path: &path,
                    generation: 1,
                },
                std::time::Duration::from_secs(1),
            )
            .await;
        manager.flush_path(&path).await;

        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(content.trim()).unwrap();
        assert_eq!(parsed["type"], "dns");
        assert_eq!(parsed["host"], "example.com");
        assert_eq!(parsed["dns_event"], "query");

        cancel.cancel();
        drop(writer);
        task.await.unwrap().unwrap();
    }

    #[test]
    fn find_available_port_returns_nonzero() {
        let port = find_available_port().unwrap();
        assert!(port > 0);
    }

    fn bind_tcp_udp_pair() -> std::io::Result<(std::net::TcpListener, std::net::UdpSocket)> {
        const MAX_PORT_PROBE_ATTEMPTS: usize = 64;

        let mut last_addr_in_use = None;
        for _ in 0..MAX_PORT_PROBE_ATTEMPTS {
            let tcp = std::net::TcpListener::bind("0.0.0.0:0")?;
            let port = tcp.local_addr()?.port();
            match std::net::UdpSocket::bind(("0.0.0.0", port)) {
                Ok(udp) => return Ok((tcp, udp)),
                Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
                    last_addr_in_use = Some(err);
                }
                Err(err) => return Err(err),
            }
        }

        Err(last_addr_in_use.unwrap_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                "could not find a port available for both TCP and UDP",
            )
        }))
    }

    #[test]
    fn find_available_port_retries_when_udp_candidate_is_in_use() {
        let (busy_tcp, _busy_udp) = bind_tcp_udp_pair().unwrap();
        let (free_tcp, free_udp_probe) = bind_tcp_udp_pair().unwrap();
        let free_port = free_tcp.local_addr().unwrap().port();
        drop(free_udp_probe);

        let port = find_available_port_from([Ok(busy_tcp), Ok(free_tcp)]).unwrap();

        assert_eq!(port, free_port);
    }
}
