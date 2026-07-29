//! Attachment-local network evidence for terminal guest DNS readiness failures.
//!
//! This module takes best-effort counter snapshots around one network attachment's readiness
//! attempts and reports how far those attempts can be correlated across the namespace/root veth
//! boundary. The report is diagnostic only: capture failures and inconclusive evidence do not
//! decide whether a namespace is admitted to the pool or whether readiness should be retried.
//!
//! # Baseline lifecycle
//!
//! A [`GuestDnsNetworkEvidenceTarget`] identifies the attachment-facing state that makes a
//! [`GuestDnsNetworkEvidenceBaseline`] reusable: namespace, root veth, peer IP, and DNS proxy port.
//! The trace reader carried by its per-namespace root-netfilter attachment is runtime-wide
//! diagnostic capability rather than network identity, so the attachment is neither serialized
//! nor part of target equality.
//!
//! After acquiring a new namespace, the factory captures its first baseline concurrently with COW
//! preparation. A reused namespace instead carries a quiescent baseline captured during teardown
//! after the previous sandbox has stopped and before the network lease returns to the pool.
//! Baseline capture snapshots namespace `veth0`, the reciprocal root veth, and the exact namespace
//! MASQUERADE rule, then records the root-netfilter trace cursor.
//!
//! Terminal capture compares a baseline only with an equal current target. A mismatch makes
//! counter correlation inconclusive and prevents the old trace cursor from defining the current
//! trace window. Target equality prevents reuse across different attachment-facing configuration;
//! reciprocal and stable link-identity checks separately reject a recreated veth.
//!
//! # Counter correlation
//!
//! Each counter snapshot runs three bounded commands concurrently: namespace and root
//! `ip -statistics link` queries, and namespace `iptables-save -c -t nat`. Command and parse
//! failures are retained as unavailable capture values so terminal diagnostics remain best effort.
//! The only positive aggregate classification, `readiness_correlated_root_veth_rx`, requires:
//!
//! - a non-zero readiness-attempt count and available baseline and terminal surfaces;
//! - an equal target, reciprocal veth identities within both snapshots, and stable identities
//!   across the window;
//! - monotonic counters on every captured link field and the exact MASQUERADE rule;
//! - MASQUERADE packet and byte deltas equal to the attempt count and fixed readiness-packet size;
//! - namespace TX and root RX packet deltas equal to the attempt count;
//! - equal, non-zero namespace TX and root RX byte deltas; and
//! - no namespace TX or root RX error or drop delta.
//!
//! That classification proves exact attempt-correlated receipt at the root side of the veth. It
//! does not prove later root-netfilter traversal, delivery to the DNS proxy, upstream resolution,
//! or a guest-visible response. Zero attempts, unavailable surfaces, attachment identity changes,
//! and counter resets cannot form a comparable window. Other mismatches remain inconclusive
//! because unrelated traffic may make an otherwise valid counter window noisy; their reason names
//! the first failed exact-correlation condition, not a proven packet-loss location.
//!
//! The non-comparable-window reasons remain distinct in serialized output: `zero_attempts` means
//! there was no readiness-attempt window, `baseline_unavailable` or `terminal_unavailable` means a
//! complete before or after snapshot was unavailable, `identity_mismatch` means the target or veth
//! identities cannot be compared, and `counter_reset` means at least one captured counter
//! decreased. All are inconclusive states; none proves that traffic stopped at a particular
//! boundary.
//!
//! # Aggregate classification and independent observations
//!
//! The aggregate `classification` and `reason` answer whether every exact condition above holds.
//! [`CounterObservations`] separately evaluates the exact namespace MASQUERADE delta and aggregate
//! veth handoff from any valid deltas. Both observations can therefore be `observed` while the
//! aggregate classification is inconclusive, for example when unrelated veth traffic raises both
//! sides above the readiness-attempt count. These observations preserve partial evidence; they are
//! not independent root-cause or per-attempt classifications.
//!
//! # Report composition and bounds
//!
//! Terminal counter capture and root-netfilter trace capture run concurrently. The separately
//! bounded [`GuestDnsNetfilterTraceReport`] is embedded as another evidence dimension and never
//! changes the counter classification. Disabled tracing omits it; other trace availability and
//! capture states remain in the trace report itself.
//!
//! Baseline commands use [`BASELINE_COMMAND_TIMEOUT`], while the terminal caller supplies its
//! counter-command timeout and the trace subsystem owns its capture wait. Command and parse failure
//! details retain at most [`FAILURE_DETAIL_LIMIT_BYTES`] bytes plus a truncation marker. The
//! enclosing failure diagnostic owns the overall snapshot deadline. Report serialization also
//! remains best effort and falls back to a plain serialization-error string rather than affecting
//! readiness behavior.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::command::{CommandError, exec_with_timeout};
use crate::guest_dns_netfilter_trace::{
    GuestDnsNetfilterTraceAttachment, GuestDnsNetfilterTraceCursor, GuestDnsNetfilterTraceReport,
};
use crate::guest_dns_readiness::GUEST_DNS_READINESS_PACKET_BYTES;

const BASELINE_COMMAND_TIMEOUT: Duration = Duration::from_millis(250);
const PEER_DEVICE: &str = "veth0";
const EXPECTED_NAMESPACE_MASQUERADE_RULE: &str =
    "-A POSTROUTING -s 192.168.241.0/29 -o veth0 -j MASQUERADE";
const FAILURE_DETAIL_LIMIT_BYTES: usize = 256;

/// Attachment-facing identity and trace capability for one evidence window.
///
/// Equality deliberately covers only namespace, root veth, peer IP, and DNS proxy port. The
/// per-namespace trace attachment is cloned for capture, but its runtime-wide reader/capability is
/// neither serialized nor part of baseline compatibility.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct GuestDnsNetworkEvidenceTarget {
    namespace: String,
    host_device: String,
    peer_ip: String,
    dns_port: u16,
    #[serde(skip)]
    root_netfilter_trace: GuestDnsNetfilterTraceAttachment,
}

impl GuestDnsNetworkEvidenceTarget {
    /// Build a target from the network attachment currently assigned to a sandbox.
    pub(crate) fn new(
        namespace: &str,
        host_device: &str,
        peer_ip: &str,
        dns_port: u16,
        root_netfilter_trace: &GuestDnsNetfilterTraceAttachment,
    ) -> Self {
        Self {
            namespace: namespace.to_string(),
            host_device: host_device.to_string(),
            peer_ip: peer_ip.to_string(),
            dns_port,
            root_netfilter_trace: root_netfilter_trace.clone(),
        }
    }
}

impl PartialEq for GuestDnsNetworkEvidenceTarget {
    fn eq(&self, other: &Self) -> bool {
        self.namespace == other.namespace
            && self.host_device == other.host_device
            && self.peer_ip == other.peer_ip
            && self.dns_port == other.dns_port
    }
}

impl Eq for GuestDnsNetworkEvidenceTarget {}

/// Counter and root-trace position captured before one attachment's readiness attempts.
///
/// The target makes the snapshot attachment-specific. A baseline can originate from initial
/// namespace allocation or from quiescent teardown before that namespace is pooled for reuse.
#[derive(Debug)]
pub(crate) struct GuestDnsNetworkEvidenceBaseline {
    target: GuestDnsNetworkEvidenceTarget,
    capture: NetworkCapture,
    root_netfilter_trace_cursor: Option<GuestDnsNetfilterTraceCursor>,
}

/// Capture an attachment-specific baseline without making diagnostic availability fatal.
///
/// The three counter surfaces are queried concurrently with the fixed baseline command timeout.
/// Their individual failures remain in the snapshot; after counter capture, the target's current
/// root-trace cursor is recorded for the later terminal window.
pub(crate) async fn capture_guest_dns_network_evidence_baseline(
    target: GuestDnsNetworkEvidenceTarget,
) -> Arc<GuestDnsNetworkEvidenceBaseline> {
    let capture = capture_network_evidence(&target, BASELINE_COMMAND_TIMEOUT).await;
    let root_netfilter_trace_cursor = target.root_netfilter_trace.cursor();
    Arc::new(GuestDnsNetworkEvidenceBaseline {
        target,
        capture,
        root_netfilter_trace_cursor,
    })
}

/// Capture and serialize terminal counter and root-trace evidence.
///
/// Counter commands use `command_timeout`, while trace capture owns its separate wait bound. Both
/// captures run concurrently. A baseline whose target differs from `target` contributes neither a
/// comparable counter window nor its trace cursor. Serialization failure returns a diagnostic
/// fallback string instead of propagating into readiness handling.
pub(crate) async fn capture_guest_dns_network_evidence_report(
    target: GuestDnsNetworkEvidenceTarget,
    baseline: Option<&GuestDnsNetworkEvidenceBaseline>,
    readiness_attempts: u16,
    command_timeout: Duration,
) -> String {
    let trace_cursor = baseline
        .filter(|baseline| baseline.target == target)
        .and_then(|baseline| baseline.root_netfilter_trace_cursor);
    let capture_trace = async {
        target
            .root_netfilter_trace
            .capture(
                trace_cursor,
                &target.namespace,
                &target.host_device,
                &target.peer_ip,
                target.dns_port,
                readiness_attempts,
            )
            .await
    };
    let (terminal, root_netfilter_trace) = tokio::join!(
        capture_network_evidence(&target, command_timeout),
        capture_trace,
    );
    render_report(
        &target,
        baseline,
        &terminal,
        readiness_attempts,
        root_netfilter_trace.as_ref(),
    )
}

async fn capture_network_evidence(
    target: &GuestDnsNetworkEvidenceTarget,
    command_timeout: Duration,
) -> NetworkCapture {
    let namespace_link_args = [
        "-n",
        target.namespace.as_str(),
        "-j",
        "-s",
        "link",
        "show",
        "dev",
        PEER_DEVICE,
    ];
    let root_link_args = [
        "-j",
        "-s",
        "link",
        "show",
        "dev",
        target.host_device.as_str(),
    ];
    let namespace_nat_args = [
        "netns",
        "exec",
        target.namespace.as_str(),
        "iptables-save",
        "-c",
        "-t",
        "nat",
    ];

    let (namespace_link, root_link, namespace_nat) = tokio::join!(
        exec_with_timeout("ip", &namespace_link_args, command_timeout),
        exec_with_timeout("ip", &root_link_args, command_timeout),
        exec_with_timeout("ip", &namespace_nat_args, command_timeout),
    );

    NetworkCapture {
        namespace_link: link_capture(namespace_link, PEER_DEVICE),
        root_link: link_capture(root_link, &target.host_device),
        namespace_masquerade: masquerade_capture(namespace_nat),
    }
}

/// Best-effort snapshots of the three counter surfaces at one point in the evidence window.
#[derive(Debug, Serialize)]
struct NetworkCapture {
    namespace_link: CaptureValue<LinkSnapshot>,
    root_link: CaptureValue<LinkSnapshot>,
    namespace_masquerade: CaptureValue<PacketCounters>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", content = "value", rename_all = "snake_case")]
enum CaptureValue<T> {
    Captured(T),
    Unavailable(CaptureFailure),
}

#[derive(Debug, Serialize)]
struct CaptureFailure {
    kind: CaptureFailureKind,
    detail: String,
}

impl CaptureFailure {
    fn command(error: CommandError) -> Self {
        Self {
            kind: CaptureFailureKind::Command,
            detail: bounded_detail(error.to_string()),
        }
    }

    fn parse(detail: String) -> Self {
        Self {
            kind: CaptureFailureKind::Parse,
            detail: bounded_detail(detail),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CaptureFailureKind {
    Command,
    Parse,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct LinkSnapshot {
    ifindex: u32,
    link_index: u32,
    ifname: String,
    stats64: LinkStats,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
struct LinkStats {
    rx: PacketCounters,
    tx: PacketCounters,
}

impl LinkStats {
    fn checked_delta(self, before: Self) -> Option<Self> {
        Some(Self {
            rx: self.rx.checked_delta(before.rx)?,
            tx: self.tx.checked_delta(before.tx)?,
        })
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
struct PacketCounters {
    packets: u64,
    bytes: u64,
    errors: u64,
    dropped: u64,
}

impl PacketCounters {
    fn checked_delta(self, before: Self) -> Option<Self> {
        Some(Self {
            packets: self.packets.checked_sub(before.packets)?,
            bytes: self.bytes.checked_sub(before.bytes)?,
            errors: self.errors.checked_sub(before.errors)?,
            dropped: self.dropped.checked_sub(before.dropped)?,
        })
    }
}

fn link_capture(
    result: Result<String, CommandError>,
    expected_ifname: &str,
) -> CaptureValue<LinkSnapshot> {
    match result {
        Ok(output) => match parse_link_snapshot(&output, expected_ifname) {
            Ok(link) => CaptureValue::Captured(link),
            Err(error) => CaptureValue::Unavailable(CaptureFailure::parse(error)),
        },
        Err(error) => CaptureValue::Unavailable(CaptureFailure::command(error)),
    }
}

fn masquerade_capture(result: Result<String, CommandError>) -> CaptureValue<PacketCounters> {
    match result {
        Ok(output) => match parse_namespace_masquerade(&output) {
            Ok(counters) => CaptureValue::Captured(counters),
            Err(error) => CaptureValue::Unavailable(CaptureFailure::parse(error)),
        },
        Err(error) => CaptureValue::Unavailable(CaptureFailure::command(error)),
    }
}

fn parse_link_snapshot(output: &str, expected_ifname: &str) -> Result<LinkSnapshot, String> {
    let links = serde_json::from_str::<Vec<LinkSnapshot>>(output)
        .map_err(|error| format!("invalid link JSON: {error}"))?;
    let [link] = <[LinkSnapshot; 1]>::try_from(links).map_err(|links| {
        format!(
            "expected one link object for {expected_ifname}, found {}",
            links.len()
        )
    })?;
    if link.ifname != expected_ifname {
        return Err(format!(
            "expected interface {expected_ifname}, found {}",
            link.ifname
        ));
    }
    Ok(link)
}

fn parse_namespace_masquerade(output: &str) -> Result<PacketCounters, String> {
    let mut counters = output.lines().filter_map(|line| {
        let (counter_token, rule) = line.trim().split_once(' ')?;
        (rule.trim() == EXPECTED_NAMESPACE_MASQUERADE_RULE).then_some(counter_token)
    });
    let counter_token = counters
        .next()
        .ok_or_else(|| "exact namespace MASQUERADE rule not found".to_string())?;
    if counters.next().is_some() {
        return Err("duplicate exact namespace MASQUERADE rule".to_string());
    }
    parse_iptables_counters(counter_token)
}

fn parse_iptables_counters(token: &str) -> Result<PacketCounters, String> {
    let values = token
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .ok_or_else(|| format!("invalid iptables counter token: {token}"))?;
    let (packets, bytes) = values
        .split_once(':')
        .ok_or_else(|| format!("invalid iptables counter token: {token}"))?;
    Ok(PacketCounters {
        packets: packets
            .parse()
            .map_err(|_| format!("invalid iptables packet counter: {packets}"))?,
        bytes: bytes
            .parse()
            .map_err(|_| format!("invalid iptables byte counter: {bytes}"))?,
        errors: 0,
        dropped: 0,
    })
}

fn bounded_detail(detail: String) -> String {
    if detail.len() <= FAILURE_DETAIL_LIMIT_BYTES {
        return detail;
    }
    let mut end = FAILURE_DETAIL_LIMIT_BYTES;
    while !detail.is_char_boundary(end) {
        end -= 1;
    }
    format!("{} [truncated]", &detail[..end])
}

/// Aggregate result of exact readiness-attempt correlation across the veth boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum EvidenceClassification {
    ReadinessCorrelatedRootVethRx,
    Inconclusive,
}

/// First condition that determined the aggregate classification.
///
/// An inconclusive reason describes why exact correlation was unavailable or failed; it does not
/// by itself prove where a readiness packet was lost.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum EvidenceReason {
    ExactCorrelation,
    ZeroAttempts,
    BaselineUnavailable,
    TerminalUnavailable,
    IdentityMismatch,
    CounterReset,
    MasqueradePacketMismatch,
    MasqueradeByteMismatch,
    NamespaceTxPacketMismatch,
    RootRxPacketMismatch,
    VethByteMismatch,
    VethErrorOrDrop,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum EvidenceBoundary {
    RootVethRx,
}

/// Checked counter deltas retained after capture availability and identity validation.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
struct EvidenceDeltas {
    namespace_link: LinkStats,
    root_link: LinkStats,
    namespace_masquerade: PacketCounters,
}

/// Aggregate classification together with its proof boundary and any usable deltas.
///
/// Deltas remain available for mismatch reasons caused by a noisy or inconsistent window, allowing
/// independent observations without upgrading the aggregate result.
#[derive(Debug)]
struct EvidenceCorrelation {
    classification: EvidenceClassification,
    reason: EvidenceReason,
    farthest_observed_boundary: Option<EvidenceBoundary>,
    deltas: Option<EvidenceDeltas>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CounterObservationStatus {
    Observed,
    NotObserved,
    ZeroAttempts,
    BaselineUnavailable,
    TerminalUnavailable,
    IdentityMismatch,
    CounterReset,
    ErrorOrDrop,
}

/// Per-surface observations derived independently from the aggregate classification.
///
/// These fields preserve useful partial evidence from valid deltas, but neither field is a
/// per-attempt root-cause classification.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
struct CounterObservations {
    exact_namespace_masquerade: CounterObservationStatus,
    aggregate_veth_handoff: CounterObservationStatus,
}

impl CounterObservations {
    fn uniform(status: CounterObservationStatus) -> Self {
        Self {
            exact_namespace_masquerade: status,
            aggregate_veth_handoff: status,
        }
    }
}

impl EvidenceCorrelation {
    fn inconclusive(reason: EvidenceReason, deltas: Option<EvidenceDeltas>) -> Self {
        Self {
            classification: EvidenceClassification::Inconclusive,
            reason,
            farthest_observed_boundary: None,
            deltas,
        }
    }

    fn root_veth_rx(deltas: EvidenceDeltas) -> Self {
        Self {
            classification: EvidenceClassification::ReadinessCorrelatedRootVethRx,
            reason: EvidenceReason::ExactCorrelation,
            farthest_observed_boundary: Some(EvidenceBoundary::RootVethRx),
            deltas: Some(deltas),
        }
    }
}

/// Apply the exact attempt-correlation contract to baseline and terminal snapshots.
///
/// Capture availability and stable reciprocal identities are prerequisites for deltas. Only a
/// fully exact, monotonic window with no relevant namespace-TX or root-RX errors or drops reaches
/// the root-veth-RX boundary; all other states are inconclusive.
fn correlate(
    target: &GuestDnsNetworkEvidenceTarget,
    baseline: Option<&GuestDnsNetworkEvidenceBaseline>,
    terminal: &NetworkCapture,
    readiness_attempts: u16,
) -> EvidenceCorrelation {
    if readiness_attempts == 0 {
        return EvidenceCorrelation::inconclusive(EvidenceReason::ZeroAttempts, None);
    }
    let Some(baseline) = baseline else {
        return EvidenceCorrelation::inconclusive(EvidenceReason::BaselineUnavailable, None);
    };
    if baseline.target != *target {
        return EvidenceCorrelation::inconclusive(EvidenceReason::IdentityMismatch, None);
    }

    let CaptureValue::Captured(baseline_namespace_link) = &baseline.capture.namespace_link else {
        return EvidenceCorrelation::inconclusive(EvidenceReason::BaselineUnavailable, None);
    };
    let CaptureValue::Captured(baseline_root_link) = &baseline.capture.root_link else {
        return EvidenceCorrelation::inconclusive(EvidenceReason::BaselineUnavailable, None);
    };
    let CaptureValue::Captured(baseline_masquerade) = &baseline.capture.namespace_masquerade else {
        return EvidenceCorrelation::inconclusive(EvidenceReason::BaselineUnavailable, None);
    };
    let CaptureValue::Captured(terminal_namespace_link) = &terminal.namespace_link else {
        return EvidenceCorrelation::inconclusive(EvidenceReason::TerminalUnavailable, None);
    };
    let CaptureValue::Captured(terminal_root_link) = &terminal.root_link else {
        return EvidenceCorrelation::inconclusive(EvidenceReason::TerminalUnavailable, None);
    };
    let CaptureValue::Captured(terminal_masquerade) = &terminal.namespace_masquerade else {
        return EvidenceCorrelation::inconclusive(EvidenceReason::TerminalUnavailable, None);
    };

    if !reciprocal_identity(baseline_namespace_link, baseline_root_link)
        || !reciprocal_identity(terminal_namespace_link, terminal_root_link)
        || !same_identity(baseline_namespace_link, terminal_namespace_link)
        || !same_identity(baseline_root_link, terminal_root_link)
    {
        return EvidenceCorrelation::inconclusive(EvidenceReason::IdentityMismatch, None);
    }

    let Some(namespace_link_delta) = terminal_namespace_link
        .stats64
        .checked_delta(baseline_namespace_link.stats64)
    else {
        return EvidenceCorrelation::inconclusive(EvidenceReason::CounterReset, None);
    };
    let Some(root_link_delta) = terminal_root_link
        .stats64
        .checked_delta(baseline_root_link.stats64)
    else {
        return EvidenceCorrelation::inconclusive(EvidenceReason::CounterReset, None);
    };
    let Some(namespace_masquerade_delta) = terminal_masquerade.checked_delta(*baseline_masquerade)
    else {
        return EvidenceCorrelation::inconclusive(EvidenceReason::CounterReset, None);
    };
    let deltas = EvidenceDeltas {
        namespace_link: namespace_link_delta,
        root_link: root_link_delta,
        namespace_masquerade: namespace_masquerade_delta,
    };
    let expected_packets = u64::from(readiness_attempts);

    if deltas.namespace_masquerade.packets != expected_packets {
        return EvidenceCorrelation::inconclusive(
            EvidenceReason::MasqueradePacketMismatch,
            Some(deltas),
        );
    }
    if deltas.namespace_masquerade.bytes != expected_packets * GUEST_DNS_READINESS_PACKET_BYTES {
        return EvidenceCorrelation::inconclusive(
            EvidenceReason::MasqueradeByteMismatch,
            Some(deltas),
        );
    }
    if deltas.namespace_link.tx.packets != expected_packets {
        return EvidenceCorrelation::inconclusive(
            EvidenceReason::NamespaceTxPacketMismatch,
            Some(deltas),
        );
    }
    if deltas.root_link.rx.packets != expected_packets {
        return EvidenceCorrelation::inconclusive(
            EvidenceReason::RootRxPacketMismatch,
            Some(deltas),
        );
    }
    if deltas.namespace_link.tx.bytes == 0
        || deltas.namespace_link.tx.bytes != deltas.root_link.rx.bytes
    {
        return EvidenceCorrelation::inconclusive(EvidenceReason::VethByteMismatch, Some(deltas));
    }
    if deltas.namespace_link.tx.errors != 0
        || deltas.namespace_link.tx.dropped != 0
        || deltas.root_link.rx.errors != 0
        || deltas.root_link.rx.dropped != 0
    {
        return EvidenceCorrelation::inconclusive(EvidenceReason::VethErrorOrDrop, Some(deltas));
    }

    EvidenceCorrelation::root_veth_rx(deltas)
}

/// Preserve independent MASQUERADE and aggregate veth-handoff observations from valid deltas.
///
/// A noisy window can produce positive observations even when [`correlate`] rejects exact attempt
/// correlation. States without usable deltas are propagated uniformly instead.
fn observe_counters(
    correlation: &EvidenceCorrelation,
    readiness_attempts: u16,
) -> CounterObservations {
    let Some(deltas) = correlation.deltas else {
        let status = match correlation.reason {
            EvidenceReason::ZeroAttempts => CounterObservationStatus::ZeroAttempts,
            EvidenceReason::BaselineUnavailable => CounterObservationStatus::BaselineUnavailable,
            EvidenceReason::TerminalUnavailable => CounterObservationStatus::TerminalUnavailable,
            EvidenceReason::IdentityMismatch => CounterObservationStatus::IdentityMismatch,
            EvidenceReason::CounterReset => CounterObservationStatus::CounterReset,
            // These reasons normally retain deltas. Missing deltas cannot
            // support a positive independent observation.
            EvidenceReason::ExactCorrelation
            | EvidenceReason::MasqueradePacketMismatch
            | EvidenceReason::MasqueradeByteMismatch
            | EvidenceReason::NamespaceTxPacketMismatch
            | EvidenceReason::RootRxPacketMismatch
            | EvidenceReason::VethByteMismatch
            | EvidenceReason::VethErrorOrDrop => CounterObservationStatus::NotObserved,
        };
        return CounterObservations::uniform(status);
    };

    let expected_packets = u64::from(readiness_attempts);
    let exact_namespace_masquerade = if deltas.namespace_masquerade.packets == expected_packets
        && deltas.namespace_masquerade.bytes == expected_packets * GUEST_DNS_READINESS_PACKET_BYTES
    {
        CounterObservationStatus::Observed
    } else {
        CounterObservationStatus::NotObserved
    };
    let veth_error_or_drop = deltas.namespace_link.tx.errors != 0
        || deltas.namespace_link.tx.dropped != 0
        || deltas.root_link.rx.errors != 0
        || deltas.root_link.rx.dropped != 0;
    let aggregate_veth_handoff = if veth_error_or_drop {
        CounterObservationStatus::ErrorOrDrop
    } else if deltas.namespace_link.tx.packets > 0
        && deltas.namespace_link.tx.packets == deltas.root_link.rx.packets
        && deltas.namespace_link.tx.bytes == deltas.root_link.rx.bytes
    {
        CounterObservationStatus::Observed
    } else {
        CounterObservationStatus::NotObserved
    };

    CounterObservations {
        exact_namespace_masquerade,
        aggregate_veth_handoff,
    }
}

fn reciprocal_identity(namespace_link: &LinkSnapshot, root_link: &LinkSnapshot) -> bool {
    namespace_link.ifindex == root_link.link_index && namespace_link.link_index == root_link.ifindex
}

fn same_identity(baseline: &LinkSnapshot, terminal: &LinkSnapshot) -> bool {
    baseline.ifname == terminal.ifname
        && baseline.ifindex == terminal.ifindex
        && baseline.link_index == terminal.link_index
}

/// Serialized counter evidence with an optional, independently interpreted root trace.
///
/// `classification`, `reason`, and `farthest_observed_boundary` describe aggregate exact
/// correlation. `counter_observations` preserves per-surface evidence, while the baseline,
/// terminal, and delta fields expose the bounded inputs used for both interpretations.
#[derive(Serialize)]
struct EvidenceReport<'a> {
    target: &'a GuestDnsNetworkEvidenceTarget,
    readiness_attempts: u16,
    classification: EvidenceClassification,
    reason: EvidenceReason,
    farthest_observed_boundary: Option<EvidenceBoundary>,
    counter_observations: CounterObservations,
    baseline: Option<&'a NetworkCapture>,
    terminal: &'a NetworkCapture,
    deltas: Option<&'a EvidenceDeltas>,
    #[serde(skip_serializing_if = "Option::is_none")]
    root_netfilter_trace: Option<&'a GuestDnsNetfilterTraceReport>,
}

/// Correlate snapshots, derive independent observations, and serialize the composed report.
fn render_report(
    target: &GuestDnsNetworkEvidenceTarget,
    baseline: Option<&GuestDnsNetworkEvidenceBaseline>,
    terminal: &NetworkCapture,
    readiness_attempts: u16,
    root_netfilter_trace: Option<&GuestDnsNetfilterTraceReport>,
) -> String {
    let correlation = correlate(target, baseline, terminal, readiness_attempts);
    let counter_observations = observe_counters(&correlation, readiness_attempts);
    let report = EvidenceReport {
        target,
        readiness_attempts,
        classification: correlation.classification,
        reason: correlation.reason,
        farthest_observed_boundary: correlation.farthest_observed_boundary,
        counter_observations,
        baseline: baseline.map(|baseline| &baseline.capture),
        terminal,
        deltas: correlation.deltas.as_ref(),
        root_netfilter_trace,
    };
    match serde_json::to_string(&report) {
        Ok(output) => output,
        Err(error) => format!("serialization_error={error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINK_JSON: &str = r#"[{
        "ifindex": 1471341,
        "link_index": 3,
        "ifname": "vm0-ve-06-41",
        "stats64": {
            "rx": {"bytes": 891, "packets": 12, "errors": 0, "dropped": 0},
            "tx": {"bytes": 907, "packets": 12, "errors": 0, "dropped": 0}
        }
    }]"#;

    fn counters(packets: u64, bytes: u64) -> PacketCounters {
        PacketCounters {
            packets,
            bytes,
            errors: 0,
            dropped: 0,
        }
    }

    fn link(
        ifname: &str,
        ifindex: u32,
        link_index: u32,
        rx: PacketCounters,
        tx: PacketCounters,
    ) -> LinkSnapshot {
        LinkSnapshot {
            ifindex,
            link_index,
            ifname: ifname.to_string(),
            stats64: LinkStats { rx, tx },
        }
    }

    fn exact_capture() -> NetworkCapture {
        NetworkCapture {
            namespace_link: CaptureValue::Captured(link(
                PEER_DEVICE,
                3,
                100,
                counters(20, 2_000),
                counters(10, 810),
            )),
            root_link: CaptureValue::Captured(link(
                "vm0-ve-00-01",
                100,
                3,
                counters(10, 810),
                counters(20, 2_000),
            )),
            namespace_masquerade: CaptureValue::Captured(counters(7, 469)),
        }
    }

    fn terminal_exact_capture() -> NetworkCapture {
        NetworkCapture {
            namespace_link: CaptureValue::Captured(link(
                PEER_DEVICE,
                3,
                100,
                counters(20, 2_000),
                counters(13, 1_053),
            )),
            root_link: CaptureValue::Captured(link(
                "vm0-ve-00-01",
                100,
                3,
                counters(13, 1_053),
                counters(20, 2_000),
            )),
            namespace_masquerade: CaptureValue::Captured(counters(10, 670)),
        }
    }

    fn target() -> GuestDnsNetworkEvidenceTarget {
        GuestDnsNetworkEvidenceTarget::new(
            "vm0-ns-00-01",
            "vm0-ve-00-01",
            "10.200.0.2",
            5300,
            &GuestDnsNetfilterTraceAttachment::Disabled,
        )
    }

    fn baseline(capture: NetworkCapture) -> GuestDnsNetworkEvidenceBaseline {
        GuestDnsNetworkEvidenceBaseline {
            target: target(),
            capture,
            root_netfilter_trace_cursor: None,
        }
    }

    fn unavailable<T>() -> CaptureValue<T> {
        CaptureValue::Unavailable(CaptureFailure::parse("unavailable".to_string()))
    }

    #[test]
    fn parses_verified_link_json_shape() {
        let link = parse_link_snapshot(LINK_JSON, "vm0-ve-06-41").unwrap();

        assert_eq!(link.ifindex, 1_471_341);
        assert_eq!(link.link_index, 3);
        assert_eq!(link.stats64.rx, counters(12, 891));
        assert_eq!(link.stats64.tx, counters(12, 907));
    }

    #[test]
    fn rejects_missing_multiple_and_wrong_link_objects() {
        assert!(parse_link_snapshot("[]", "veth0").is_err());
        assert!(parse_link_snapshot("[{}, {}]", "veth0").is_err());
        assert!(parse_link_snapshot(LINK_JSON, "veth0").is_err());
        assert!(parse_link_snapshot("not-json", "veth0").is_err());
    }

    #[test]
    fn parses_only_the_exact_namespace_masquerade_rule() {
        let output = [
            "# Generated by iptables-save",
            "*nat",
            ":POSTROUTING ACCEPT [1:67]",
            "[3:201] -A POSTROUTING -s 192.168.241.0/29 -o veth0 -j MASQUERADE",
            "COMMIT",
        ]
        .join("\n");

        assert_eq!(
            parse_namespace_masquerade(&output).unwrap(),
            counters(3, 201)
        );
    }

    #[test]
    fn rejects_missing_duplicate_and_malformed_masquerade_counters() {
        assert!(parse_namespace_masquerade("*nat\nCOMMIT").is_err());
        let exact = "[3:201] -A POSTROUTING -s 192.168.241.0/29 -o veth0 -j MASQUERADE";
        assert!(parse_namespace_masquerade(&format!("{exact}\n{exact}")).is_err());
        assert!(
            parse_namespace_masquerade(
                "[three:201] -A POSTROUTING -s 192.168.241.0/29 -o veth0 -j MASQUERADE"
            )
            .is_err()
        );
        assert!(
            parse_namespace_masquerade(
                "[3:201] -A POSTROUTING -s 192.168.241.1/29 -o veth0 -j MASQUERADE"
            )
            .is_err()
        );
    }

    #[test]
    fn exact_attempt_and_veth_progress_reaches_root_rx() {
        let baseline = baseline(exact_capture());
        let terminal = terminal_exact_capture();

        let correlation = correlate(&target(), Some(&baseline), &terminal, 3);

        assert_eq!(
            correlation.classification,
            EvidenceClassification::ReadinessCorrelatedRootVethRx
        );
        assert_eq!(correlation.reason, EvidenceReason::ExactCorrelation);
        assert_eq!(
            correlation.farthest_observed_boundary,
            Some(EvidenceBoundary::RootVethRx)
        );
        let deltas = correlation.deltas.unwrap();
        assert_eq!(deltas.namespace_masquerade, counters(3, 201));
        assert_eq!(deltas.namespace_link.tx, counters(3, 243));
        assert_eq!(deltas.root_link.rx, counters(3, 243));
    }

    #[test]
    fn partial_noisy_and_inconsistent_progress_is_inconclusive() {
        let cases = [
            (
                EvidenceReason::MasqueradePacketMismatch,
                counters(9, 603),
                counters(13, 1_053),
                counters(13, 1_053),
            ),
            (
                EvidenceReason::MasqueradeByteMismatch,
                counters(10, 669),
                counters(13, 1_053),
                counters(13, 1_053),
            ),
            (
                EvidenceReason::NamespaceTxPacketMismatch,
                counters(10, 670),
                counters(12, 972),
                counters(13, 1_053),
            ),
            (
                EvidenceReason::RootRxPacketMismatch,
                counters(10, 670),
                counters(13, 1_053),
                counters(12, 972),
            ),
            (
                EvidenceReason::VethByteMismatch,
                counters(10, 670),
                counters(13, 1_052),
                counters(13, 1_053),
            ),
        ];

        for (reason, masquerade, namespace_tx, root_rx) in cases {
            let baseline = baseline(exact_capture());
            let mut terminal = terminal_exact_capture();
            terminal.namespace_masquerade = CaptureValue::Captured(masquerade);
            if let CaptureValue::Captured(namespace_link) = &mut terminal.namespace_link {
                namespace_link.stats64.tx = namespace_tx;
            }
            if let CaptureValue::Captured(root_link) = &mut terminal.root_link {
                root_link.stats64.rx = root_rx;
            }

            let correlation = correlate(&target(), Some(&baseline), &terminal, 3);

            assert_eq!(
                correlation.classification,
                EvidenceClassification::Inconclusive
            );
            assert_eq!(correlation.reason, reason);
            assert!(correlation.deltas.is_some());
        }
    }

    #[test]
    fn noisy_veth_window_preserves_independent_positive_observations() {
        let baseline = baseline(exact_capture());
        let mut terminal = terminal_exact_capture();
        if let CaptureValue::Captured(namespace_link) = &mut terminal.namespace_link {
            namespace_link.stats64.tx = counters(14, 1_134);
        }
        if let CaptureValue::Captured(root_link) = &mut terminal.root_link {
            root_link.stats64.rx = counters(14, 1_134);
        }

        let correlation = correlate(&target(), Some(&baseline), &terminal, 3);
        let observations = observe_counters(&correlation, 3);

        assert_eq!(
            correlation.classification,
            EvidenceClassification::Inconclusive
        );
        assert_eq!(
            correlation.reason,
            EvidenceReason::NamespaceTxPacketMismatch
        );
        assert_eq!(
            observations.exact_namespace_masquerade,
            CounterObservationStatus::Observed
        );
        assert_eq!(
            observations.aggregate_veth_handoff,
            CounterObservationStatus::Observed
        );
    }

    #[test]
    fn error_or_drop_progress_is_inconclusive() {
        let baseline = baseline(exact_capture());
        let mut terminal = terminal_exact_capture();
        if let CaptureValue::Captured(namespace_link) = &mut terminal.namespace_link {
            namespace_link.stats64.tx.dropped = 1;
        }

        let correlation = correlate(&target(), Some(&baseline), &terminal, 3);

        assert_eq!(correlation.reason, EvidenceReason::VethErrorOrDrop);
        assert_eq!(
            correlation.classification,
            EvidenceClassification::Inconclusive
        );
    }

    #[test]
    fn identity_change_is_inconclusive() {
        let baseline = baseline(exact_capture());
        let mut terminal = terminal_exact_capture();
        if let CaptureValue::Captured(root_link) = &mut terminal.root_link {
            root_link.ifindex += 1;
        }

        let correlation = correlate(&target(), Some(&baseline), &terminal, 3);

        assert_eq!(correlation.reason, EvidenceReason::IdentityMismatch);
        assert!(correlation.deltas.is_none());
    }

    #[test]
    fn counter_reset_is_inconclusive() {
        let baseline = baseline(exact_capture());
        let mut terminal = terminal_exact_capture();
        if let CaptureValue::Captured(namespace_link) = &mut terminal.namespace_link {
            namespace_link.stats64.rx.bytes = 1_999;
        }

        let correlation = correlate(&target(), Some(&baseline), &terminal, 3);

        assert_eq!(correlation.reason, EvidenceReason::CounterReset);
        assert!(correlation.deltas.is_none());
    }

    #[test]
    fn every_packet_counter_field_rejects_reset() {
        let before = PacketCounters {
            packets: 10,
            bytes: 10,
            errors: 10,
            dropped: 10,
        };
        for after in [
            PacketCounters {
                packets: 9,
                ..before
            },
            PacketCounters { bytes: 9, ..before },
            PacketCounters {
                errors: 9,
                ..before
            },
            PacketCounters {
                dropped: 9,
                ..before
            },
        ] {
            assert!(after.checked_delta(before).is_none());
        }
    }

    #[test]
    fn unavailable_baseline_or_terminal_is_inconclusive() {
        let mut baseline_capture = exact_capture();
        baseline_capture.namespace_masquerade = unavailable();
        let unavailable_baseline = baseline(baseline_capture);
        let terminal = terminal_exact_capture();
        assert_eq!(
            correlate(&target(), Some(&unavailable_baseline), &terminal, 3).reason,
            EvidenceReason::BaselineUnavailable
        );

        let baseline = baseline(exact_capture());
        let mut terminal = terminal_exact_capture();
        terminal.root_link = unavailable();
        assert_eq!(
            correlate(&target(), Some(&baseline), &terminal, 3).reason,
            EvidenceReason::TerminalUnavailable
        );
    }

    #[test]
    fn zero_attempts_is_inconclusive() {
        let baseline = baseline(exact_capture());

        let correlation = correlate(&target(), Some(&baseline), &terminal_exact_capture(), 0);

        assert_eq!(correlation.reason, EvidenceReason::ZeroAttempts);
        assert_eq!(
            correlation.classification,
            EvidenceClassification::Inconclusive
        );
    }

    #[test]
    fn report_is_bounded_and_contains_attempt_correlation() {
        let baseline = baseline(exact_capture());
        let report = render_report(
            &target(),
            Some(&baseline),
            &terminal_exact_capture(),
            3,
            None,
        );
        let value: serde_json::Value = serde_json::from_str(&report).unwrap();

        assert!(
            report.len() < 2 * 1024,
            "counter report was {} bytes",
            report.len()
        );
        assert_eq!(value["readiness_attempts"], 3);
        assert_eq!(value["classification"], "readiness_correlated_root_veth_rx");
        assert_eq!(value["farthest_observed_boundary"], "root_veth_rx");
        assert_eq!(value["deltas"]["namespace_masquerade"]["packets"], 3);
        assert_eq!(
            value["counter_observations"]["exact_namespace_masquerade"],
            "observed"
        );
        assert_eq!(
            value["counter_observations"]["aggregate_veth_handoff"],
            "observed"
        );
    }
}
