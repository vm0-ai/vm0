//! Bounded root netfilter trace capture for guest DNS readiness diagnostics.

use std::collections::VecDeque;
use std::io;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio::time::{Duration, Instant, timeout, timeout_at};
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::guest_dns_readiness::{
    GUEST_DNS_READINESS_MAX_ATTEMPTS, GUEST_DNS_READINESS_PACKET_BYTES,
};
use crate::network::{make_pool_dns_filter_comment, parse_netns_name};

const MAX_PACKETS: usize = 256;
const MAX_HEADERS_PER_PACKET: usize = 4;
const MAX_IDENTIFIER_BYTES: usize = 64;
const MAX_STEPS_PER_PACKET: usize = 16;
const MAX_TRACE_LINE_BYTES: usize = 1_024;
const MAX_RULE_DETAIL_BYTES: usize = 192;
const MAX_STDERR_BYTES: usize = 1_024;
const MAX_REPORTED_PACKETS: usize = GUEST_DNS_READINESS_MAX_ATTEMPTS as usize;
const MONITOR_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const TRACE_CAPTURE_WAIT: Duration = Duration::from_millis(250);
const READ_CHUNK_BYTES: usize = 4 * 1_024;
const READINESS_DNS_IPV4: &str = "8.8.8.8";

static NEXT_MONITOR_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct GuestDnsNetfilterTraceCursor {
    monitor_id: u64,
    sequence: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct GuestDnsNetfilterTraceReader {
    state: Arc<Mutex<TraceState>>,
    changed: Arc<Notify>,
}

#[derive(Clone, Debug)]
pub(crate) enum GuestDnsNetfilterTraceAttachment {
    Disabled,
    Unavailable(&'static str),
    Enabled(GuestDnsNetfilterTraceReader),
}

impl GuestDnsNetfilterTraceAttachment {
    pub(crate) fn unavailable(reason: &'static str) -> Self {
        Self::Unavailable(reason)
    }

    pub(crate) fn enabled(reader: GuestDnsNetfilterTraceReader) -> Self {
        Self::Enabled(reader)
    }

    pub(crate) fn cursor(&self) -> Option<GuestDnsNetfilterTraceCursor> {
        match self {
            Self::Enabled(reader) => Some(reader.cursor()),
            Self::Disabled | Self::Unavailable(_) => None,
        }
    }

    pub(crate) async fn capture(
        &self,
        cursor: Option<GuestDnsNetfilterTraceCursor>,
        namespace: &str,
        host_device: &str,
        peer_ip: &str,
        dns_port: u16,
        readiness_attempts: u16,
    ) -> Option<GuestDnsNetfilterTraceReport> {
        match self {
            Self::Disabled => None,
            Self::Unavailable(reason) => {
                Some(GuestDnsNetfilterTraceReport::attachment_unavailable(reason))
            }
            Self::Enabled(reader) => Some(match cursor {
                Some(cursor) => {
                    reader
                        .capture(
                            cursor,
                            namespace,
                            host_device,
                            peer_ip,
                            dns_port,
                            readiness_attempts,
                        )
                        .await
                }
                None => GuestDnsNetfilterTraceReport::baseline_unavailable(),
            }),
        }
    }
}

pub(crate) struct GuestDnsNetfilterTraceMonitor {
    reader: GuestDnsNetfilterTraceReader,
    cancel: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl GuestDnsNetfilterTraceMonitor {
    pub(crate) async fn start() -> io::Result<Self> {
        let mut command = Command::new("xtables-monitor");
        command.args(["--trace", "--ipv4"]);
        Self::start_command(command).await
    }

    async fn start_command(mut command: Command) -> io::Result<Self> {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn()?;
        let (stdout, stderr) = take_pipes(&mut child).await?;
        let state = Arc::new(Mutex::new(TraceState::new(
            NEXT_MONITOR_ID.fetch_add(1, Ordering::Relaxed),
        )));
        let changed = Arc::new(Notify::new());
        let reader = GuestDnsNetfilterTraceReader {
            state: Arc::clone(&state),
            changed: Arc::clone(&changed),
        };
        let cancel = CancellationToken::new();
        let task = tokio::spawn(supervise_monitor(
            child,
            stdout,
            stderr,
            state,
            changed,
            cancel.clone(),
        ));
        Ok(Self {
            reader,
            cancel,
            task: Some(task),
        })
    }

    pub(crate) fn reader(&self) -> GuestDnsNetfilterTraceReader {
        self.reader.clone()
    }

    pub(crate) async fn shutdown(&mut self) {
        self.cancel.cancel();
        let Some(mut task) = self.task.take() else {
            return;
        };
        if timeout(MONITOR_SHUTDOWN_TIMEOUT, &mut task).await.is_err() {
            task.abort();
            let _ = task.await;
        }
    }
}

impl Drop for GuestDnsNetfilterTraceMonitor {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn take_pipes(child: &mut Child) -> io::Result<(ChildStdout, ChildStderr)> {
    match (child.stdout.take(), child.stderr.take()) {
        (Some(stdout), Some(stderr)) => Ok((stdout, stderr)),
        _ => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            Err(io::Error::other("xtables-monitor pipe unavailable"))
        }
    }
}

async fn supervise_monitor(
    mut child: Child,
    stdout: impl AsyncRead + Unpin + Send + 'static,
    stderr: impl AsyncRead + Unpin + Send + 'static,
    state: Arc<Mutex<TraceState>>,
    changed: Arc<Notify>,
    cancel: CancellationToken,
) {
    let stdout_state = Arc::clone(&state);
    let stdout_changed = Arc::clone(&changed);
    let stdout_task = tokio::spawn(async move {
        if let Err(error) =
            read_trace_stream(stdout, stdout_state.clone(), stdout_changed.clone()).await
        {
            lock_state(&stdout_state).set_unavailable(format!("stdout read failed: {error}"));
            stdout_changed.notify_waiters();
        }
    });
    let stderr_task = tokio::spawn(read_bounded_output(stderr, MAX_STDERR_BYTES));

    let stopped = tokio::select! {
        () = cancel.cancelled() => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            true
        }
        result = child.wait() => {
            let detail = match result {
                Ok(status) => format!("xtables-monitor exited with {status}"),
                Err(error) => format!("xtables-monitor wait failed: {error}"),
            };
            lock_state(&state).set_unavailable(detail);
            changed.notify_waiters();
            false
        }
    };

    let _ = stdout_task.await;
    let stderr = match stderr_task.await {
        Ok(Ok(stderr)) => stderr,
        Ok(Err(error)) => format!("stderr read failed: {error}"),
        Err(error) => format!("stderr task failed: {error}"),
    };
    let mut state = lock_state(&state);
    if stopped {
        state.status = TraceMonitorStatus::Stopped;
    } else if !stderr.is_empty() {
        state.append_unavailable_detail(&stderr);
    }
    if !stopped && let TraceMonitorStatus::Unavailable(detail) = &state.status {
        warn!(detail, "root netfilter trace monitor exited unexpectedly");
    }
}

async fn read_trace_stream(
    reader: impl AsyncRead + Unpin,
    state: Arc<Mutex<TraceState>>,
    changed: Arc<Notify>,
) -> io::Result<()> {
    read_bounded_lines(reader, MAX_TRACE_LINE_BYTES, |line, truncated| {
        let mut state = lock_state(&state);
        if truncated {
            state.truncated_lines = state.truncated_lines.saturating_add(1);
        } else {
            state.ingest(&line);
        }
        drop(state);
        changed.notify_waiters();
    })
    .await
}

async fn read_bounded_lines(
    mut reader: impl AsyncRead + Unpin,
    limit: usize,
    mut on_line: impl FnMut(String, bool),
) -> io::Result<()> {
    let mut chunk = [0_u8; READ_CHUNK_BYTES];
    let mut line = Vec::with_capacity(limit);
    let mut truncated = false;
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            if !line.is_empty() || truncated {
                on_line(String::from_utf8_lossy(&line).into_owned(), truncated);
            }
            return Ok(());
        }
        for byte in chunk.iter().copied().take(read) {
            if byte == b'\n' {
                on_line(String::from_utf8_lossy(&line).into_owned(), truncated);
                line.clear();
                truncated = false;
            } else if line.len() < limit {
                line.push(byte);
            } else {
                truncated = true;
            }
        }
    }
}

async fn read_bounded_output(
    mut reader: impl AsyncRead + Unpin,
    limit: usize,
) -> io::Result<String> {
    let mut chunk = [0_u8; READ_CHUNK_BYTES];
    let mut output = Vec::with_capacity(limit);
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            return Ok(String::from_utf8_lossy(&output).trim().to_string());
        }
        let remaining = limit.saturating_sub(output.len());
        output.extend(chunk.iter().copied().take(read.min(remaining)));
    }
}

fn lock_state(state: &Mutex<TraceState>) -> MutexGuard<'_, TraceState> {
    match state.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

#[derive(Debug)]
struct TraceState {
    monitor_id: u64,
    next_sequence: u64,
    packets: VecDeque<TracePacket>,
    evicted_packets: u64,
    malformed_lines: u64,
    truncated_lines: u64,
    status: TraceMonitorStatus,
}

impl TraceState {
    fn new(monitor_id: u64) -> Self {
        Self {
            monitor_id,
            next_sequence: 1,
            packets: VecDeque::with_capacity(MAX_PACKETS),
            evicted_packets: 0,
            malformed_lines: 0,
            truncated_lines: 0,
            status: TraceMonitorStatus::Running,
        }
    }

    fn ingest(&mut self, line: &str) {
        match parse_monitor_line(line) {
            Some(ParsedMonitorLine::Packet {
                family,
                packet_id,
                header,
            }) => self.ingest_packet(family, packet_id, header),
            Some(ParsedMonitorLine::Trace {
                family,
                packet_id,
                step,
            }) => self.ingest_trace(family, packet_id, step),
            None if !line.trim().is_empty() => {
                self.malformed_lines = self.malformed_lines.saturating_add(1);
            }
            None => {}
        }
    }

    fn ingest_packet(&mut self, family: u8, packet_id: String, header: TracePacketHeader) {
        let existing = self
            .packets
            .iter()
            .rposition(|packet| {
                packet.family == family && packet.packet_id == packet_id && !packet.complete
            })
            .and_then(|position| self.packets.get_mut(position));
        if let Some(packet) = existing {
            packet.push_header(header);
            return;
        }
        let mut packet = TracePacket::new(self.next_sequence, family, packet_id);
        self.next_sequence = self.next_sequence.saturating_add(1);
        packet.push_header(header);
        self.push_packet(packet);
    }

    fn ingest_trace(&mut self, family: u8, packet_id: String, step: TraceStep) {
        let existing = self
            .packets
            .iter()
            .rposition(|packet| {
                packet.family == family && packet.packet_id == packet_id && !packet.complete
            })
            .and_then(|position| self.packets.get_mut(position));
        if let Some(packet) = existing {
            packet.push_step(step);
            return;
        }
        let mut packet = TracePacket::new(self.next_sequence, family, packet_id);
        self.next_sequence = self.next_sequence.saturating_add(1);
        packet.push_step(step);
        self.push_packet(packet);
    }

    fn push_packet(&mut self, packet: TracePacket) {
        if self.packets.len() == MAX_PACKETS {
            self.packets.pop_front();
            self.evicted_packets = self.evicted_packets.saturating_add(1);
        }
        self.packets.push_back(packet);
    }

    fn set_unavailable(&mut self, detail: String) {
        self.status =
            TraceMonitorStatus::Unavailable(bounded_string(detail.trim(), MAX_STDERR_BYTES));
    }

    fn append_unavailable_detail(&mut self, detail: &str) {
        let TraceMonitorStatus::Unavailable(current) = &mut self.status else {
            return;
        };
        let combined = format!("{current}; {}", detail.trim());
        *current = bounded_string(&combined, MAX_STDERR_BYTES);
    }
}

#[derive(Debug)]
enum TraceMonitorStatus {
    Running,
    Unavailable(String),
    Stopped,
}

#[derive(Clone, Debug)]
struct TracePacket {
    sequence: u64,
    family: u8,
    packet_id: String,
    headers: Vec<TracePacketHeader>,
    steps: Vec<TraceStep>,
    farthest_observed_boundary: Option<RootNetfilterBoundary>,
    truncated: bool,
    complete: bool,
}

impl TracePacket {
    fn new(sequence: u64, family: u8, packet_id: String) -> Self {
        Self {
            sequence,
            family,
            packet_id,
            headers: Vec::new(),
            steps: Vec::new(),
            farthest_observed_boundary: None,
            truncated: false,
            complete: false,
        }
    }

    fn push_header(&mut self, header: TracePacketHeader) {
        if self.headers.len() < MAX_HEADERS_PER_PACKET {
            self.headers.push(header);
        } else {
            self.truncated = true;
        }
    }

    fn push_step(&mut self, step: TraceStep) {
        self.farthest_observed_boundary =
            RootNetfilterBoundary::farthest(self.farthest_observed_boundary, step.boundary());
        self.complete |= step.is_terminal();
        if self.steps.len() < MAX_STEPS_PER_PACKET {
            self.steps.push(step);
        } else {
            self.truncated = true;
        }
    }

    fn readiness_header(
        &self,
        namespace: &str,
        host_device: &str,
        peer_ip: &str,
    ) -> Option<&TracePacketHeader> {
        let traces_udp_readiness_rule = self.steps.iter().any(|step| {
            step.table == "raw"
                && step.chain == "PREROUTING"
                && step.rule.as_deref().is_some_and(|rule| {
                    rule_has_option_value(rule, "-p", "udp")
                        && rule_has_option_value(rule, "--dport", "53")
                        && rule_has_exact_packet_length(rule, GUEST_DNS_READINESS_PACKET_BYTES)
                        && rule_has_option_value(rule, "--comment", namespace)
                        && rule_has_option_value(rule, "-j", "TRACE")
                })
        });
        self.headers.iter().find(|header| {
            header.input.as_deref() == Some(host_device)
                && header.source.as_deref() == Some(peer_ip)
                && header.destination.as_deref() == Some(READINESS_DNS_IPV4)
                && header.length == Some(GUEST_DNS_READINESS_PACKET_BYTES)
                && (header
                    .protocol
                    .as_deref()
                    .is_some_and(|protocol| protocol.eq_ignore_ascii_case("udp"))
                    || traces_udp_readiness_rule)
                && header.destination_port == Some(53)
        })
    }

    fn report(
        &self,
        namespace: &str,
        host_device: &str,
        peer_ip: &str,
        dns_port: u16,
    ) -> Option<TracePacketReport> {
        let original_header = self
            .readiness_header(namespace, host_device, peer_ip)?
            .clone();
        let dns_port_value = dns_port;
        let dns_port = dns_port.to_string();
        let nat_prerouting_reached = self
            .steps
            .iter()
            .any(|step| step.table == "nat" && step.chain == "PREROUTING");
        let dns_redirect_matched = self.steps.iter().any(|step| {
            step.table == "nat"
                && step.chain == "PREROUTING"
                && step.rule.as_deref().is_some_and(|rule| {
                    rule_has_option_value(rule, "-p", "udp")
                        && rule_has_option_value(rule, "--dport", "53")
                        && rule_has_option_value(rule, "--comment", namespace)
                        && rule_has_option_value(rule, "-j", "REDIRECT")
                        && (rule_has_option_value(rule, "--to-port", &dns_port)
                            || rule_has_option_value(rule, "--to-ports", &dns_port))
                })
        });
        let post_redirect_header = self
            .headers
            .iter()
            .find(|header| {
                header.input.as_deref() == Some(host_device)
                    && header.source.as_deref() == Some(peer_ip)
                    && header.destination.as_deref() != Some(READINESS_DNS_IPV4)
                    && header.destination_port == Some(dns_port_value)
            })
            .cloned();
        let filter_forward_reached = self
            .steps
            .iter()
            .any(|step| step.table == "filter" && step.chain == "FORWARD");
        let filter_input_reached = self
            .steps
            .iter()
            .any(|step| step.table == "filter" && step.chain == "INPUT");
        let pool_input_comment =
            parse_netns_name(namespace).map(|name| make_pool_dns_filter_comment(name.pool_index));
        let pool_input_rule_reached = self.steps.iter().any(|step| {
            step.table == "filter"
                && step.chain == "INPUT"
                && step.kind == "rule"
                && step.verdict == "CONTINUE"
                && step.rule.as_deref().is_some_and(|rule| {
                    rule_has_option_value(rule, "-p", "udp")
                        && rule_has_option_value(rule, "--dport", &dns_port)
                        && pool_input_comment.as_deref().is_some_and(|comment| {
                            rule_has_option_value(rule, "--comment", comment)
                        })
                        && !rule_has_option_value(rule, "-j", "REJECT")
                })
        });
        let input_policy_accepted = self.steps.iter().any(|step| {
            step.table == "filter"
                && step.chain == "INPUT"
                && step.kind == "policy"
                && step.verdict == "ACCEPT"
        });
        let mut observed = vec![RootNetfilterObservation::RawPreroutingTrace];
        if nat_prerouting_reached {
            observed.extend([
                RootNetfilterObservation::RawPreroutingContinued,
                RootNetfilterObservation::RootConntrackHookPassed,
                RootNetfilterObservation::NatPrerouting,
            ]);
        }
        if dns_redirect_matched {
            observed.push(RootNetfilterObservation::DnsRedirect);
        }
        if post_redirect_header.is_some() {
            observed.push(RootNetfilterObservation::PostRedirectHeader);
        }
        if filter_forward_reached {
            observed.push(RootNetfilterObservation::FilterForward);
        }
        if filter_input_reached {
            observed.push(RootNetfilterObservation::FilterInput);
        }
        if pool_input_rule_reached {
            observed.push(RootNetfilterObservation::PoolDnsInputRule);
        }
        if input_policy_accepted {
            observed.push(RootNetfilterObservation::InputPolicyAccepted);
        }
        Some(TracePacketReport {
            sequence: self.sequence,
            family: self.family,
            packet_id: self.packet_id.clone(),
            source_port: original_header.source_port,
            post_redirect_destination: post_redirect_header
                .as_ref()
                .and_then(|header| header.destination.clone()),
            observed,
            farthest_observed_boundary: self.farthest_observed_boundary,
            truncated: self.truncated,
            complete: self.complete,
        })
    }
}

fn rule_has_option_value(rule: &str, option: &str, expected: &str) -> bool {
    rule_option_value(rule, option) == Some(expected)
}

fn rule_has_exact_packet_length(rule: &str, expected: u64) -> bool {
    let Some(value) = rule_option_value(rule, "--length") else {
        return false;
    };
    let (minimum, maximum) = value.split_once(':').unwrap_or((value, value));
    minimum.parse() == Ok(expected) && maximum.parse() == Ok(expected)
}

fn rule_option_value<'a>(rule: &'a str, option: &str) -> Option<&'a str> {
    let mut tokens = rule.split_whitespace();
    while let Some(token) = tokens.next() {
        if token == option {
            return tokens.next();
        }
    }
    None
}

#[derive(Clone, Debug)]
struct TracePacketHeader {
    input: Option<String>,
    source: Option<String>,
    destination: Option<String>,
    length: Option<u64>,
    protocol: Option<String>,
    source_port: Option<u16>,
    destination_port: Option<u16>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum RootNetfilterObservation {
    RawPreroutingTrace,
    RawPreroutingContinued,
    RootConntrackHookPassed,
    NatPrerouting,
    DnsRedirect,
    PostRedirectHeader,
    FilterForward,
    FilterInput,
    PoolDnsInputRule,
    InputPolicyAccepted,
}

#[derive(Clone, Debug, Serialize)]
struct TracePacketReport {
    sequence: u64,
    family: u8,
    packet_id: String,
    source_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    post_redirect_destination: Option<String>,
    observed: Vec<RootNetfilterObservation>,
    farthest_observed_boundary: Option<RootNetfilterBoundary>,
    truncated: bool,
    complete: bool,
}

#[derive(Clone, Debug)]
struct TraceStep {
    table: String,
    chain: String,
    kind: String,
    verdict: String,
    rule: Option<String>,
}

impl TraceStep {
    fn boundary(&self) -> Option<RootNetfilterBoundary> {
        match (self.table.as_str(), self.chain.as_str()) {
            ("raw", "PREROUTING") => Some(RootNetfilterBoundary::RawPrerouting),
            ("nat", "PREROUTING") => Some(RootNetfilterBoundary::NatPrerouting),
            ("filter", "FORWARD") => Some(RootNetfilterBoundary::FilterForward),
            ("filter", "INPUT") => Some(RootNetfilterBoundary::FilterInput),
            _ => None,
        }
    }

    fn is_terminal(&self) -> bool {
        matches!(self.verdict.as_str(), "DROP" | "REJECT")
            || (self.table == "filter" && self.verdict == "ACCEPT")
            || (self.kind == "policy"
                && self.table == "filter"
                && matches!(self.chain.as_str(), "INPUT" | "FORWARD" | "OUTPUT"))
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
enum RootNetfilterBoundary {
    RawPrerouting,
    NatPrerouting,
    FilterForward,
    FilterInput,
}

impl RootNetfilterBoundary {
    fn farthest(current: Option<Self>, candidate: Option<Self>) -> Option<RootNetfilterBoundary> {
        match (current, candidate) {
            (Some(current), Some(candidate)) => Some(current.max(candidate)),
            (Some(current), None) => Some(current),
            (None, Some(candidate)) => Some(candidate),
            (None, None) => None,
        }
    }
}

enum ParsedMonitorLine {
    Packet {
        family: u8,
        packet_id: String,
        header: TracePacketHeader,
    },
    Trace {
        family: u8,
        packet_id: String,
        step: TraceStep,
    },
}

fn parse_monitor_line(line: &str) -> Option<ParsedMonitorLine> {
    let trimmed = line.trim();
    if trimmed.starts_with("PACKET:") {
        parse_packet_line(trimmed)
    } else if trimmed.starts_with("TRACE:") {
        parse_trace_line(trimmed)
    } else {
        None
    }
}

fn parse_packet_line(line: &str) -> Option<ParsedMonitorLine> {
    let mut tokens = line.split_whitespace();
    (tokens.next()? == "PACKET:").then_some(())?;
    let family = tokens.next()?.parse().ok()?;
    let packet_id = checked_identifier(tokens.next()?)?.to_string();
    let mut header = TracePacketHeader {
        input: None,
        source: None,
        destination: None,
        length: None,
        protocol: None,
        source_port: None,
        destination_port: None,
    };
    for token in tokens {
        let Some((key, value)) = token.split_once('=') else {
            continue;
        };
        match key {
            "IN" => header.input = checked_identifier(value).map(str::to_string),
            "SRC" => header.source = checked_identifier(value).map(str::to_string),
            "DST" => header.destination = checked_identifier(value).map(str::to_string),
            "LEN" => header.length = value.parse().ok(),
            "PROTO" => header.protocol = checked_identifier(value).map(str::to_string),
            "SPT" | "SPORT" => header.source_port = value.parse().ok(),
            "DPT" | "DPORT" => header.destination_port = value.parse().ok(),
            _ => {}
        }
    }
    Some(ParsedMonitorLine::Packet {
        family,
        packet_id,
        header,
    })
}

fn parse_trace_line(line: &str) -> Option<ParsedMonitorLine> {
    let mut tokens = line.split_whitespace();
    (tokens.next()? == "TRACE:").then_some(())?;
    let family = tokens.next()?.parse().ok()?;
    let packet_id = checked_identifier(tokens.next()?)?.to_string();
    let descriptor = tokens.next()?;
    let mut descriptor_parts = descriptor.split(':');
    let table = checked_identifier(descriptor_parts.next()?)?.to_string();
    let chain = checked_identifier(descriptor_parts.next()?)?.to_string();
    let kind = checked_identifier(descriptor_parts.next()?)?.to_string();
    let verdict = checked_identifier(descriptor_parts.next_back()?)?.to_string();
    let rule = {
        let detail = tokens.collect::<Vec<_>>().join(" ");
        (!detail.is_empty()).then(|| bounded_string(&detail, MAX_RULE_DETAIL_BYTES))
    };
    Some(ParsedMonitorLine::Trace {
        family,
        packet_id,
        step: TraceStep {
            table,
            chain,
            kind,
            verdict,
            rule,
        },
    })
}

fn checked_identifier(value: &str) -> Option<&str> {
    (value.len() <= MAX_IDENTIFIER_BYTES).then_some(value)
}

fn bounded_string(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    format!("{} [truncated]", &value[..end])
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum TraceReportStatus {
    Captured,
    NoMatchingPacket,
    BufferTruncated,
    BaselineUnavailable,
    AttachmentUnavailable,
    MonitorUnavailable,
    CursorMismatch,
}

#[derive(Clone, Debug, Serialize)]
struct TraceMonitorSnapshot {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

impl TraceMonitorSnapshot {
    fn from_status(status: &TraceMonitorStatus) -> Self {
        match status {
            TraceMonitorStatus::Running => Self {
                state: "running",
                detail: None,
            },
            TraceMonitorStatus::Unavailable(detail) => Self {
                state: "unavailable",
                detail: Some(detail.clone()),
            },
            TraceMonitorStatus::Stopped => Self {
                state: "stopped",
                detail: None,
            },
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct GuestDnsNetfilterTraceReport {
    status: TraceReportStatus,
    monitor: TraceMonitorSnapshot,
    matched_packets: usize,
    evicted_packets: u64,
    malformed_lines: u64,
    truncated_lines: u64,
    packets: Vec<TracePacketReport>,
}

impl GuestDnsNetfilterTraceReport {
    fn attachment_unavailable(reason: &str) -> Self {
        Self {
            status: TraceReportStatus::AttachmentUnavailable,
            monitor: TraceMonitorSnapshot {
                state: "unavailable",
                detail: Some(reason.to_string()),
            },
            matched_packets: 0,
            evicted_packets: 0,
            malformed_lines: 0,
            truncated_lines: 0,
            packets: Vec::new(),
        }
    }

    fn baseline_unavailable() -> Self {
        Self {
            status: TraceReportStatus::BaselineUnavailable,
            monitor: TraceMonitorSnapshot {
                state: "unknown",
                detail: None,
            },
            matched_packets: 0,
            evicted_packets: 0,
            malformed_lines: 0,
            truncated_lines: 0,
            packets: Vec::new(),
        }
    }

    fn complete_for(&self, expected_packets: usize) -> bool {
        self.packets.iter().filter(|packet| packet.complete).count() >= expected_packets
            || matches!(self.status, TraceReportStatus::CursorMismatch)
    }
}

impl GuestDnsNetfilterTraceReader {
    fn cursor(&self) -> GuestDnsNetfilterTraceCursor {
        let state = lock_state(&self.state);
        GuestDnsNetfilterTraceCursor {
            monitor_id: state.monitor_id,
            sequence: state.next_sequence.saturating_sub(1),
        }
    }

    async fn capture(
        &self,
        cursor: GuestDnsNetfilterTraceCursor,
        namespace: &str,
        host_device: &str,
        peer_ip: &str,
        dns_port: u16,
        readiness_attempts: u16,
    ) -> GuestDnsNetfilterTraceReport {
        let deadline = Instant::now() + TRACE_CAPTURE_WAIT;
        let expected_packets = usize::from(readiness_attempts);
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let report = self.capture_now(cursor, namespace, host_device, peer_ip, dns_port);
            if expected_packets == 0 || report.complete_for(expected_packets) {
                return report;
            }
            if timeout_at(deadline, &mut notified).await.is_err() {
                return self.capture_now(cursor, namespace, host_device, peer_ip, dns_port);
            }
        }
    }

    fn capture_now(
        &self,
        cursor: GuestDnsNetfilterTraceCursor,
        namespace: &str,
        host_device: &str,
        peer_ip: &str,
        dns_port: u16,
    ) -> GuestDnsNetfilterTraceReport {
        let state = lock_state(&self.state);
        if cursor.monitor_id != state.monitor_id {
            return GuestDnsNetfilterTraceReport {
                status: TraceReportStatus::CursorMismatch,
                monitor: TraceMonitorSnapshot::from_status(&state.status),
                matched_packets: 0,
                evicted_packets: state.evicted_packets,
                malformed_lines: state.malformed_lines,
                truncated_lines: state.truncated_lines,
                packets: Vec::new(),
            };
        }

        let matches = state
            .packets
            .iter()
            .filter(|packet| packet.sequence > cursor.sequence)
            .filter_map(|packet| packet.report(namespace, host_device, peer_ip, dns_port))
            .collect::<Vec<_>>();
        let matched_packets = matches.len();
        let first_reported = matched_packets.saturating_sub(MAX_REPORTED_PACKETS);
        let packets: Vec<_> = matches.into_iter().skip(first_reported).collect();
        let buffer_truncated = state
            .packets
            .front()
            .is_some_and(|packet| packet.sequence > cursor.sequence.saturating_add(1));
        let status = if !packets.is_empty() {
            TraceReportStatus::Captured
        } else if buffer_truncated {
            TraceReportStatus::BufferTruncated
        } else if matches!(state.status, TraceMonitorStatus::Running) {
            TraceReportStatus::NoMatchingPacket
        } else {
            TraceReportStatus::MonitorUnavailable
        };
        GuestDnsNetfilterTraceReport {
            status,
            monitor: TraceMonitorSnapshot::from_status(&state.status),
            matched_packets,
            evicted_packets: state.evicted_packets,
            malformed_lines: state.malformed_lines,
            truncated_lines: state.truncated_lines,
            packets,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGINAL_PACKET: &str =
        "PACKET: 2 6379008e IN=vm0-ve-00-01 SRC=10.200.0.2 DST=8.8.8.8 LEN=67 SPORT=49152 DPORT=53";
    const POST_NAT_PACKET: &str = "PACKET: 2 6379008e IN=vm0-ve-00-01 SRC=10.200.0.2 DST=10.200.0.1 LEN=67 SPORT=49152 DPORT=5300";
    const READINESS_TRACE_RULE: &str = " TRACE: 2 6379008e raw:PREROUTING:rule:0x1:CONTINUE -4 -t raw -A PREROUTING -i vm0-ve-00-01 -s 10.200.0.2/32 -d 8.8.8.8/32 -p udp --dport 53 -m length --length 67 -m comment --comment vm0-ns-00-01 -j TRACE";

    fn reader_and_state() -> (GuestDnsNetfilterTraceReader, Arc<Mutex<TraceState>>) {
        let state = Arc::new(Mutex::new(TraceState::new(7)));
        (
            GuestDnsNetfilterTraceReader {
                state: Arc::clone(&state),
                changed: Arc::new(Notify::new()),
            },
            state,
        )
    }

    fn ingest_verified_fixture(state: &Mutex<TraceState>) {
        let lines = [
            ORIGINAL_PACKET,
            READINESS_TRACE_RULE,
            " TRACE: 2 6379008e raw:PREROUTING:policy:ACCEPT",
            " TRACE: 2 6379008e nat:PREROUTING:rule:0x2:ACCEPT -4 -t nat -A PREROUTING -i vm0-ve-00-01 -s 10.200.0.2/32 -p udp --dport 53 -m comment --comment vm0-ns-00-01 -j REDIRECT --to-ports 5300",
            POST_NAT_PACKET,
            " TRACE: 2 6379008e filter:INPUT:rule:0x3:CONTINUE -4 -t filter -A INPUT -i vm0-ve-00-+ -p udp --dport 5300 -m comment --comment vm0-ns-00-dns",
            " TRACE: 2 6379008e filter:INPUT:policy:ACCEPT",
        ];
        let mut state = lock_state(state);
        for line in lines {
            state.ingest(line);
        }
    }

    #[test]
    fn parses_verified_trace_and_reports_farthest_root_hook() {
        let (reader, state) = reader_and_state();
        let cursor = reader.cursor();
        ingest_verified_fixture(&state);

        let report = reader.capture_now(cursor, "vm0-ns-00-01", "vm0-ve-00-01", "10.200.0.2", 5300);
        let value = serde_json::to_value(report).unwrap();

        assert_eq!(value["status"], "captured");
        assert_eq!(value["matched_packets"], 1);
        assert_eq!(
            value["packets"][0]["farthest_observed_boundary"],
            "filter_input"
        );
        assert_eq!(
            value["packets"][0]["post_redirect_destination"],
            "10.200.0.1"
        );
        assert_eq!(
            value["packets"][0]["observed"],
            serde_json::json!([
                "raw_prerouting_trace",
                "raw_prerouting_continued",
                "root_conntrack_hook_passed",
                "nat_prerouting",
                "dns_redirect",
                "post_redirect_header",
                "filter_input",
                "pool_dns_input_rule",
                "input_policy_accepted"
            ])
        );
    }

    #[test]
    fn excludes_packets_before_cursor_and_non_readiness_packets() {
        let (reader, state) = reader_and_state();
        ingest_verified_fixture(&state);
        let cursor = reader.cursor();
        lock_state(&state).ingest(
            "PACKET: 2 other IN=vm0-ve-00-01 SRC=10.200.0.2 DST=192.0.2.1 LEN=67 PROTO=UDP SPT=1 DPT=53",
        );

        let report = reader.capture_now(cursor, "vm0-ns-00-01", "vm0-ve-00-01", "10.200.0.2", 5300);

        assert!(matches!(report.status, TraceReportStatus::NoMatchingPacket));
    }

    #[test]
    fn excludes_interleaved_other_runner_packet() {
        let (reader, state) = reader_and_state();
        let cursor = reader.cursor();
        let mut state = lock_state(&state);
        for line in [
            "PACKET: 2 other IN=vm0-ve-01-01 SRC=10.200.4.2 DST=8.8.8.8 LEN=67 SPORT=49152 DPORT=53",
            "TRACE: 2 other raw:PREROUTING:rule:0x1:CONTINUE -4 -t raw -A PREROUTING -i vm0-ve-01-01 -s 10.200.4.2/32 -d 8.8.8.8/32 -p udp --dport 53 -m length --length 67 -m comment --comment vm0-ns-01-01 -j TRACE",
            "TRACE: 2 other filter:INPUT:policy:ACCEPT",
        ] {
            state.ingest(line);
        }
        drop(state);

        let report = reader.capture_now(cursor, "vm0-ns-00-01", "vm0-ve-00-01", "10.200.0.2", 5300);

        assert!(matches!(report.status, TraceReportStatus::NoMatchingPacket));
    }

    #[test]
    fn reports_forward_drop_without_claiming_redirect_or_input_progress() {
        let (reader, state) = reader_and_state();
        let cursor = reader.cursor();
        let mut state = lock_state(&state);
        for line in [
            ORIGINAL_PACKET,
            READINESS_TRACE_RULE,
            "TRACE: 2 6379008e raw:PREROUTING:policy:ACCEPT",
            "TRACE: 2 6379008e nat:PREROUTING:policy:ACCEPT",
            "TRACE: 2 6379008e filter:FORWARD:rule:0x4:DROP -4 -t filter -A FORWARD -i vm0-ve-00-01 -s 10.200.0.2/32 -p udp --dport 53 -m comment --comment vm0-ns-00-01 -j DROP",
        ] {
            state.ingest(line);
        }
        drop(state);

        let report = reader.capture_now(cursor, "vm0-ns-00-01", "vm0-ve-00-01", "10.200.0.2", 5300);
        let value = serde_json::to_value(report).unwrap();
        let observed = value["packets"][0]["observed"].as_array().unwrap();

        assert!(observed.contains(&serde_json::json!("filter_forward")));
        assert!(!observed.contains(&serde_json::json!("dns_redirect")));
        assert!(!observed.contains(&serde_json::json!("filter_input")));
        assert_eq!(
            value["packets"][0]["farthest_observed_boundary"],
            "filter_forward"
        );
        assert_eq!(value["packets"][0]["complete"], true);
    }

    #[test]
    fn completed_packet_id_reuse_keeps_three_attempt_report_bounded() {
        let (reader, state) = reader_and_state();
        ingest_verified_fixture(&state);
        let cursor = reader.cursor();
        for _ in 0..3 {
            ingest_verified_fixture(&state);
        }

        let report = reader.capture_now(cursor, "vm0-ns-00-01", "vm0-ve-00-01", "10.200.0.2", 5300);
        let output = serde_json::to_string(&report).unwrap();

        assert!(matches!(report.status, TraceReportStatus::Captured));
        assert_eq!(report.matched_packets, 3);
        assert_eq!(report.packets.len(), 3);
        assert!(
            output.len() < 1_536,
            "trace report was {} bytes",
            output.len()
        );
    }

    #[tokio::test]
    async fn capture_waits_for_expected_packet_and_keeps_report_bounded() {
        let (reader, state) = reader_and_state();
        let cursor = reader.cursor();
        let changed = Arc::clone(&reader.changed);
        let capture = reader.capture(
            cursor,
            "vm0-ns-00-01",
            "vm0-ve-00-01",
            "10.200.0.2",
            5300,
            1,
        );
        tokio::pin!(capture);
        assert!(
            futures_util::poll!(capture.as_mut()).is_pending(),
            "capture should wait for the expected packet"
        );
        ingest_verified_fixture(&state);
        changed.notify_waiters();

        let report = capture.await;
        let output = serde_json::to_string(&report).unwrap();

        assert!(matches!(report.status, TraceReportStatus::Captured));
        assert_eq!(report.matched_packets, 1);
        assert!(output.len() < 2 * 1024);
    }

    #[tokio::test]
    async fn bounded_line_reader_discards_oversized_lines_and_keeps_following_lines() {
        let input = format!(
            "{}\n{ORIGINAL_PACKET}\n",
            "x".repeat(MAX_TRACE_LINE_BYTES + 10)
        );
        let mut observed = Vec::new();

        read_bounded_lines(input.as_bytes(), MAX_TRACE_LINE_BYTES, |line, truncated| {
            observed.push((line, truncated));
        })
        .await
        .unwrap();

        assert_eq!(observed.len(), 2);
        assert!(observed.first().is_some_and(|(_, truncated)| *truncated));
        assert_eq!(observed.get(1), Some(&(ORIGINAL_PACKET.to_string(), false)));
    }

    #[test]
    fn packet_and_step_bounds_are_explicit() {
        let (_, state) = reader_and_state();
        let mut state = lock_state(&state);
        state.ingest(ORIGINAL_PACKET);
        for _ in 0..(MAX_HEADERS_PER_PACKET + 2) {
            state.ingest(POST_NAT_PACKET);
        }
        for _ in 0..(MAX_STEPS_PER_PACKET + 2) {
            state.ingest("TRACE: 2 6379008e raw:PREROUTING:rule:0x1:CONTINUE");
        }

        let packet = state.packets.back().unwrap();
        assert_eq!(packet.headers.len(), MAX_HEADERS_PER_PACKET);
        assert_eq!(packet.steps.len(), MAX_STEPS_PER_PACKET);
        assert!(packet.truncated);
    }

    #[test]
    fn exact_packet_length_accepts_single_value_and_equal_range() {
        assert!(rule_has_exact_packet_length("--length 67", 67));
        assert!(rule_has_exact_packet_length("--length 67:67", 67));
        assert!(!rule_has_exact_packet_length("--length 66:67", 67));
    }

    #[tokio::test]
    async fn process_exit_marks_monitor_unavailable() {
        let mut command = Command::new("sh");
        command.arg("-c").arg("printf 'monitor failed' >&2; exit 3");
        let mut monitor = GuestDnsNetfilterTraceMonitor::start_command(command)
            .await
            .unwrap();

        for _ in 0..50 {
            if matches!(
                lock_state(&monitor.reader.state).status,
                TraceMonitorStatus::Unavailable(_)
            ) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        {
            let state = lock_state(&monitor.reader.state);
            assert!(matches!(state.status, TraceMonitorStatus::Unavailable(_)));
        }
        monitor.shutdown().await;
    }

    #[tokio::test]
    async fn shutdown_kills_and_reaps_monitor_process() {
        let mut command = Command::new("sleep");
        command.arg("60");
        let mut monitor = GuestDnsNetfilterTraceMonitor::start_command(command)
            .await
            .unwrap();

        monitor.shutdown().await;

        assert!(monitor.task.is_none());
        assert!(matches!(
            lock_state(&monitor.reader.state).status,
            TraceMonitorStatus::Stopped
        ));
    }
}
