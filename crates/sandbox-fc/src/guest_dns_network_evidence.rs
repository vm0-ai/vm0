//! Attachment-local network evidence for terminal guest DNS readiness failures.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::command::{CommandError, exec_with_timeout};

const BASELINE_COMMAND_TIMEOUT: Duration = Duration::from_millis(250);
const PEER_DEVICE: &str = "veth0";
const EXPECTED_NAMESPACE_MASQUERADE_RULE: &str =
    "-A POSTROUTING -s 192.168.241.0/29 -o veth0 -j MASQUERADE";
const EXPECTED_READINESS_PACKET_BYTES: u64 = 67;
const FAILURE_DETAIL_LIMIT_BYTES: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct GuestDnsNetworkEvidenceTarget {
    namespace: String,
    host_device: String,
}

impl GuestDnsNetworkEvidenceTarget {
    pub(crate) fn new(namespace: &str, host_device: &str) -> Self {
        Self {
            namespace: namespace.to_string(),
            host_device: host_device.to_string(),
        }
    }
}

#[derive(Debug)]
pub(crate) struct GuestDnsNetworkEvidenceBaseline {
    target: GuestDnsNetworkEvidenceTarget,
    capture: NetworkCapture,
}

pub(crate) async fn capture_guest_dns_network_evidence_baseline(
    target: GuestDnsNetworkEvidenceTarget,
) -> Arc<GuestDnsNetworkEvidenceBaseline> {
    let capture = capture_network_evidence(&target, BASELINE_COMMAND_TIMEOUT).await;
    Arc::new(GuestDnsNetworkEvidenceBaseline { target, capture })
}

pub(crate) async fn capture_guest_dns_network_evidence_report(
    target: GuestDnsNetworkEvidenceTarget,
    baseline: Option<&GuestDnsNetworkEvidenceBaseline>,
    readiness_attempts: u16,
    command_timeout: Duration,
) -> String {
    let terminal = capture_network_evidence(&target, command_timeout).await;
    render_report(&target, baseline, &terminal, readiness_attempts)
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum EvidenceClassification {
    ReadinessCorrelatedRootVethRx,
    Inconclusive,
}

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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
struct EvidenceDeltas {
    namespace_link: LinkStats,
    root_link: LinkStats,
    namespace_masquerade: PacketCounters,
}

#[derive(Debug)]
struct EvidenceCorrelation {
    classification: EvidenceClassification,
    reason: EvidenceReason,
    farthest_observed_boundary: Option<EvidenceBoundary>,
    deltas: Option<EvidenceDeltas>,
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
    if deltas.namespace_masquerade.bytes != expected_packets * EXPECTED_READINESS_PACKET_BYTES {
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

fn reciprocal_identity(namespace_link: &LinkSnapshot, root_link: &LinkSnapshot) -> bool {
    namespace_link.ifindex == root_link.link_index && namespace_link.link_index == root_link.ifindex
}

fn same_identity(baseline: &LinkSnapshot, terminal: &LinkSnapshot) -> bool {
    baseline.ifname == terminal.ifname
        && baseline.ifindex == terminal.ifindex
        && baseline.link_index == terminal.link_index
}

#[derive(Serialize)]
struct EvidenceReport<'a> {
    target: &'a GuestDnsNetworkEvidenceTarget,
    readiness_attempts: u16,
    classification: EvidenceClassification,
    reason: EvidenceReason,
    farthest_observed_boundary: Option<EvidenceBoundary>,
    baseline: Option<&'a NetworkCapture>,
    terminal: &'a NetworkCapture,
    deltas: Option<&'a EvidenceDeltas>,
}

fn render_report(
    target: &GuestDnsNetworkEvidenceTarget,
    baseline: Option<&GuestDnsNetworkEvidenceBaseline>,
    terminal: &NetworkCapture,
    readiness_attempts: u16,
) -> String {
    let correlation = correlate(target, baseline, terminal, readiness_attempts);
    let report = EvidenceReport {
        target,
        readiness_attempts,
        classification: correlation.classification,
        reason: correlation.reason,
        farthest_observed_boundary: correlation.farthest_observed_boundary,
        baseline: baseline.map(|baseline| &baseline.capture),
        terminal,
        deltas: correlation.deltas.as_ref(),
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
        GuestDnsNetworkEvidenceTarget::new("vm0-ns-00-01", "vm0-ve-00-01")
    }

    fn baseline(capture: NetworkCapture) -> GuestDnsNetworkEvidenceBaseline {
        GuestDnsNetworkEvidenceBaseline {
            target: target(),
            capture,
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
        let report = render_report(&target(), Some(&baseline), &terminal_exact_capture(), 3);
        let value: serde_json::Value = serde_json::from_str(&report).unwrap();

        assert!(report.len() < 4 * 1024);
        assert_eq!(value["readiness_attempts"], 3);
        assert_eq!(value["classification"], "readiness_correlated_root_veth_rx");
        assert_eq!(value["farthest_observed_boundary"], "root_veth_rx");
        assert_eq!(value["deltas"]["namespace_masquerade"]["packets"], 3);
    }
}
