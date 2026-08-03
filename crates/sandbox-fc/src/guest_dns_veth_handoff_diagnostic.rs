//! Failure-only exact-flow observation across a sandbox attachment's veth pair.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::command::{CommandError, exec_status_with_timeout, exec_with_timeout};
use crate::guest_dns_netfilter_trace::{
    GuestDnsNetfilterTraceAttachment, GuestDnsNetfilterTraceCaptureTarget,
    GuestDnsNetfilterTraceReport,
};
use crate::guest_dns_readiness::GUEST_DNS_READINESS_PACKET_BYTES;
use crate::network::{
    DNS_DIAGNOSTIC_SOURCE_PORT, DNS_READINESS_RESOLVER_IPV4, DnsDiagnosticProbeReport,
    probe_namespace_dns_diagnostic,
};

const PEER_DEVICE: &str = "veth0";
const DNS_PORT: u16 = 53;
const TC_COMMAND_TIMEOUT: Duration = Duration::from_millis(500);
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
const FILTER_PRIORITY_BASE: u16 = 49_152;
const FILTER_PRIORITY_SPAN: u16 = 8_192;
const FAILURE_DETAIL_LIMIT_BYTES: usize = 256;

#[derive(Clone, Copy)]
pub(crate) struct GuestDnsVethHandoffDiagnosticTarget<'a> {
    pub(crate) namespace: &'a str,
    pub(crate) host_device: &'a str,
    pub(crate) peer_ip: &'a str,
    pub(crate) dns_port: u16,
    pub(crate) root_netfilter_trace: &'a GuestDnsNetfilterTraceAttachment,
}

pub(crate) async fn capture_guest_dns_veth_handoff_diagnostic(
    target: GuestDnsVethHandoffDiagnosticTarget<'_>,
) -> String {
    let identity = FilterIdentity::new();
    let namespace_target = TcSurfaceTarget::namespace(target.namespace, PEER_DEVICE);
    let root_target = TcSurfaceTarget::root(target.host_device);
    let (mut namespace_setup, mut root_setup) = tokio::join!(
        setup_surface(
            namespace_target,
            TcDirection::Egress,
            target.peer_ip,
            identity
        ),
        setup_surface(root_target, TcDirection::Ingress, target.peer_ip, identity),
    );

    let observers = (namespace_setup.observer.take(), root_setup.observer.take());
    let (namespace_observer, root_observer) = match observers {
        (Some(namespace_observer), Some(root_observer)) => (namespace_observer, root_observer),
        (namespace_observer, root_observer) => {
            let (namespace_cleanup, root_cleanup) = tokio::join!(
                cleanup_optional_observer(namespace_observer),
                cleanup_optional_observer(root_observer),
            );
            namespace_setup.report.apply_cleanup(namespace_cleanup);
            root_setup.report.apply_cleanup(root_cleanup);
            return render_report(VethHandoffDiagnosticReport {
                outcome: VethHandoffOutcome::ProbeUnavailable,
                probe: ProbeExecution::NotRun,
                namespace_egress: namespace_setup.report,
                root_ingress: root_setup.report,
                root_netfilter_trace: None,
            });
        }
    };

    let trace_cursor = target.root_netfilter_trace.cursor();
    let probe = probe_namespace_dns_diagnostic(target.namespace.to_string(), PROBE_TIMEOUT).await;
    let (namespace_counters, root_counters, root_netfilter_trace) = tokio::join!(
        namespace_observer.capture_counters(),
        root_observer.capture_counters(),
        target.root_netfilter_trace.capture(
            trace_cursor,
            GuestDnsNetfilterTraceCaptureTarget {
                namespace: target.namespace,
                host_device: target.host_device,
                peer_ip: target.peer_ip,
                source_port: Some(DNS_DIAGNOSTIC_SOURCE_PORT),
                dns_port: target.dns_port,
                expected_packets: 1,
            },
        ),
    );

    namespace_setup.report.apply_counters(namespace_counters);
    root_setup.report.apply_counters(root_counters);
    let outcome = classify(
        &probe,
        namespace_setup.report.counters,
        root_setup.report.counters,
        root_netfilter_trace.as_ref(),
    );

    let (namespace_cleanup, root_cleanup) =
        tokio::join!(namespace_observer.cleanup(), root_observer.cleanup(),);
    namespace_setup.report.apply_cleanup(namespace_cleanup);
    root_setup.report.apply_cleanup(root_cleanup);

    render_report(VethHandoffDiagnosticReport {
        outcome,
        probe: ProbeExecution::Completed(probe),
        namespace_egress: namespace_setup.report,
        root_ingress: root_setup.report,
        root_netfilter_trace,
    })
}

fn classify(
    probe: &DnsDiagnosticProbeReport,
    namespace_egress: Option<TcCounters>,
    root_ingress: Option<TcCounters>,
    root_netfilter_trace: Option<&GuestDnsNetfilterTraceReport>,
) -> VethHandoffOutcome {
    if probe.response_validated() == Some(true) {
        return VethHandoffOutcome::NotReproduced;
    }
    if probe.response_received() == Some(true) {
        return VethHandoffOutcome::ProbeUnavailable;
    }
    if probe.sent() != Some(true) {
        return VethHandoffOutcome::ProbeUnavailable;
    }
    let (Some(namespace_egress), Some(root_ingress)) = (namespace_egress, root_ingress) else {
        return VethHandoffOutcome::ProbeUnavailable;
    };
    match (
        (namespace_egress.packets, namespace_egress.bytes),
        (root_ingress.packets, root_ingress.bytes),
    ) {
        ((0, 0), (0, 0)) => VethHandoffOutcome::NamespaceEgressNotObserved,
        ((1, GUEST_DNS_READINESS_PACKET_BYTES), (0, 0)) => {
            VethHandoffOutcome::RootIngressNotObserved
        }
        ((1, GUEST_DNS_READINESS_PACKET_BYTES), (1, GUEST_DNS_READINESS_PACKET_BYTES)) => {
            match root_netfilter_trace
                .and_then(GuestDnsNetfilterTraceReport::exact_single_packet_observed)
            {
                Some(true) => VethHandoffOutcome::RootNetfilterObserved,
                Some(false) => VethHandoffOutcome::RootNetfilterNotObserved,
                None => VethHandoffOutcome::RootIngressObserved,
            }
        }
        _ => VethHandoffOutcome::ProbeUnavailable,
    }
}

#[derive(Serialize)]
struct VethHandoffDiagnosticReport {
    outcome: VethHandoffOutcome,
    probe: ProbeExecution,
    namespace_egress: TcSurfaceReport,
    root_ingress: TcSurfaceReport,
    #[serde(skip_serializing_if = "Option::is_none")]
    root_netfilter_trace: Option<GuestDnsNetfilterTraceReport>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum VethHandoffOutcome {
    NotReproduced,
    ProbeUnavailable,
    NamespaceEgressNotObserved,
    RootIngressNotObserved,
    RootNetfilterNotObserved,
    RootNetfilterObserved,
    RootIngressObserved,
}

#[derive(Serialize)]
#[serde(tag = "status", content = "report", rename_all = "snake_case")]
enum ProbeExecution {
    NotRun,
    Completed(DnsDiagnosticProbeReport),
}

fn render_report(report: VethHandoffDiagnosticReport) -> String {
    serde_json::to_string(&report).unwrap_or_else(|error| format!("serialization_error={error}"))
}

#[derive(Clone, Copy, Debug, Serialize)]
struct FilterIdentity {
    priority: u16,
    handle: u32,
}

impl FilterIdentity {
    fn new() -> Self {
        let random = *Uuid::new_v4().as_bytes();
        let priority = FILTER_PRIORITY_BASE
            + u16::from_be_bytes([random[0], random[1]]) % FILTER_PRIORITY_SPAN;
        let handle = u32::from_be_bytes([random[2], random[3], random[4], random[5]]).max(1);
        Self { priority, handle }
    }

    fn priority_arg(self) -> String {
        self.priority.to_string()
    }

    fn handle_arg(self) -> String {
        self.handle.to_string()
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
struct TcCounters {
    packets: u64,
    bytes: u64,
}

#[derive(Serialize)]
struct TcSurfaceReport {
    setup: TcSetupStatus,
    qdisc: QdiscOwnership,
    #[serde(skip_serializing_if = "Option::is_none")]
    filter: Option<FilterIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    counters: Option<TcCounters>,
    #[serde(skip_serializing_if = "Option::is_none")]
    setup_failure: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    observation_failure: Option<String>,
    cleanup: TcCleanupReport,
}

impl TcSurfaceReport {
    fn new() -> Self {
        Self {
            setup: TcSetupStatus::Unavailable,
            qdisc: QdiscOwnership::Unknown,
            filter: None,
            counters: None,
            setup_failure: None,
            observation_failure: None,
            cleanup: TcCleanupReport::default(),
        }
    }

    fn fail_setup(&mut self, failure: impl Into<String>) {
        self.setup_failure = Some(bounded_detail(failure.into()));
    }

    fn apply_counters(&mut self, result: Result<TcCounters, String>) {
        match result {
            Ok(counters) => self.counters = Some(counters),
            Err(failure) => self.observation_failure = Some(bounded_detail(failure)),
        }
    }

    fn apply_cleanup(&mut self, cleanup: TcCleanupReport) {
        self.cleanup = cleanup;
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum TcSetupStatus {
    Installed,
    Unavailable,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum QdiscOwnership {
    Unknown,
    Preexisting,
    Created,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum CleanupStep {
    NotOwned,
    Removed,
    Preserved,
    Failed,
}

#[derive(Serialize)]
struct TcCleanupReport {
    filter: CleanupStep,
    qdisc: CleanupStep,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure: Option<String>,
}

impl Default for TcCleanupReport {
    fn default() -> Self {
        Self {
            filter: CleanupStep::NotOwned,
            qdisc: CleanupStep::NotOwned,
            failure: None,
        }
    }
}

struct SurfaceSetup {
    observer: Option<InstalledObserver>,
    report: TcSurfaceReport,
}

async fn setup_surface(
    target: TcSurfaceTarget,
    direction: TcDirection,
    peer_ip: &str,
    identity: FilterIdentity,
) -> SurfaceSetup {
    let mut report = TcSurfaceReport::new();
    let qdisc_exists = match target
        .output(qdisc_show_args(&target.device))
        .await
        .map_err(command_failure)
        .and_then(|output| parse_clsact_presence(&output))
    {
        Ok(exists) => exists,
        Err(failure) => {
            report.fail_setup(failure);
            return SurfaceSetup {
                observer: None,
                report,
            };
        }
    };
    let qdisc_created = if qdisc_exists {
        report.qdisc = QdiscOwnership::Preexisting;
        false
    } else {
        if let Err(error) = target.status(qdisc_add_args(&target.device)).await {
            report.fail_setup(command_failure(error));
            return SurfaceSetup {
                observer: None,
                report,
            };
        }
        report.qdisc = QdiscOwnership::Created;
        true
    };

    let observer = InstalledObserver {
        target,
        direction,
        identity,
        qdisc_created,
        filter_owned: false,
    };
    if let Err(error) = observer
        .target
        .status(filter_add_args(
            &observer.target.device,
            direction,
            peer_ip,
            identity,
        ))
        .await
    {
        report.fail_setup(command_failure(error));
        report.apply_cleanup(observer.cleanup().await);
        return SurfaceSetup {
            observer: None,
            report,
        };
    }

    let observer = InstalledObserver {
        filter_owned: true,
        ..observer
    };
    report.filter = Some(identity);
    match observer.capture_counters().await {
        Ok(TcCounters {
            packets: 0,
            bytes: 0,
        }) => {
            report.setup = TcSetupStatus::Installed;
            SurfaceSetup {
                observer: Some(observer),
                report,
            }
        }
        Ok(counters) => {
            report.fail_setup(format!(
                "diagnostic filter was nonzero before probe: packets={} bytes={}",
                counters.packets, counters.bytes
            ));
            report.apply_cleanup(observer.cleanup().await);
            SurfaceSetup {
                observer: None,
                report,
            }
        }
        Err(failure) => {
            report.fail_setup(failure);
            report.apply_cleanup(observer.cleanup().await);
            SurfaceSetup {
                observer: None,
                report,
            }
        }
    }
}

async fn cleanup_optional_observer(observer: Option<InstalledObserver>) -> TcCleanupReport {
    match observer {
        Some(observer) => observer.cleanup().await,
        None => TcCleanupReport::default(),
    }
}

struct InstalledObserver {
    target: TcSurfaceTarget,
    direction: TcDirection,
    identity: FilterIdentity,
    qdisc_created: bool,
    filter_owned: bool,
}

impl InstalledObserver {
    async fn capture_counters(&self) -> Result<TcCounters, String> {
        let output = self
            .target
            .output(filter_show_args(&self.target.device, self.direction))
            .await
            .map_err(command_failure)?;
        parse_owned_filter(&output, self.identity)
    }

    async fn cleanup(self) -> TcCleanupReport {
        let mut report = TcCleanupReport {
            filter: if self.filter_owned {
                CleanupStep::Preserved
            } else {
                CleanupStep::NotOwned
            },
            qdisc: if self.qdisc_created {
                CleanupStep::Preserved
            } else {
                CleanupStep::NotOwned
            },
            failure: None,
        };

        if self.filter_owned {
            match self
                .target
                .status(filter_delete_args(
                    &self.target.device,
                    self.direction,
                    self.identity,
                ))
                .await
            {
                Ok(()) => report.filter = CleanupStep::Removed,
                Err(error) => {
                    report.filter = CleanupStep::Failed;
                    report.failure = Some(bounded_detail(command_failure(error)));
                    return report;
                }
            }
        }

        if !self.qdisc_created {
            return report;
        }

        let (ingress, egress) = tokio::join!(
            self.target
                .output(filter_show_args(&self.target.device, TcDirection::Ingress)),
            self.target
                .output(filter_show_args(&self.target.device, TcDirection::Egress)),
        );
        let empty = ingress
            .map_err(command_failure)
            .and_then(|output| parse_filter_list_empty(&output))
            .and_then(|ingress_empty| {
                egress
                    .map_err(command_failure)
                    .and_then(|output| parse_filter_list_empty(&output))
                    .map(|egress_empty| ingress_empty && egress_empty)
            });
        match empty {
            Ok(true) => match self
                .target
                .status(qdisc_delete_args(&self.target.device))
                .await
            {
                Ok(()) => report.qdisc = CleanupStep::Removed,
                Err(error) => {
                    report.qdisc = CleanupStep::Failed;
                    report.failure = Some(bounded_detail(command_failure(error)));
                }
            },
            Ok(false) => {
                report.qdisc = CleanupStep::Preserved;
                report.failure = Some("qdisc gained an unowned filter".to_string());
            }
            Err(failure) => {
                report.qdisc = CleanupStep::Preserved;
                report.failure = Some(bounded_detail(failure));
            }
        }
        report
    }
}

#[derive(Clone)]
struct TcSurfaceTarget {
    scope: TcScope,
    device: String,
}

impl TcSurfaceTarget {
    fn namespace(namespace: &str, device: &str) -> Self {
        Self {
            scope: TcScope::Namespace(namespace.to_string()),
            device: device.to_string(),
        }
    }

    fn root(device: &str) -> Self {
        Self {
            scope: TcScope::Root,
            device: device.to_string(),
        }
    }

    async fn output(&self, arguments: Vec<String>) -> Result<String, CommandError> {
        let (program, arguments) = self.command(arguments);
        let arguments = arguments.iter().map(String::as_str).collect::<Vec<_>>();
        exec_with_timeout(program, &arguments, TC_COMMAND_TIMEOUT).await
    }

    async fn status(&self, arguments: Vec<String>) -> Result<(), CommandError> {
        let (program, arguments) = self.command(arguments);
        let arguments = arguments.iter().map(String::as_str).collect::<Vec<_>>();
        exec_status_with_timeout(program, &arguments, TC_COMMAND_TIMEOUT).await
    }

    fn command(&self, arguments: Vec<String>) -> (&'static str, Vec<String>) {
        match &self.scope {
            TcScope::Root => ("tc", arguments),
            TcScope::Namespace(namespace) => {
                let mut namespaced = vec![
                    "netns".to_string(),
                    "exec".to_string(),
                    namespace.clone(),
                    "tc".to_string(),
                ];
                namespaced.extend(arguments);
                ("ip", namespaced)
            }
        }
    }
}

#[derive(Clone)]
enum TcScope {
    Root,
    Namespace(String),
}

#[derive(Clone, Copy)]
enum TcDirection {
    Ingress,
    Egress,
}

impl TcDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ingress => "ingress",
            Self::Egress => "egress",
        }
    }
}

fn qdisc_show_args(device: &str) -> Vec<String> {
    vec![
        "-j".to_string(),
        "qdisc".to_string(),
        "show".to_string(),
        "dev".to_string(),
        device.to_string(),
    ]
}

fn qdisc_add_args(device: &str) -> Vec<String> {
    vec![
        "qdisc".to_string(),
        "add".to_string(),
        "dev".to_string(),
        device.to_string(),
        "clsact".to_string(),
    ]
}

fn qdisc_delete_args(device: &str) -> Vec<String> {
    vec![
        "qdisc".to_string(),
        "del".to_string(),
        "dev".to_string(),
        device.to_string(),
        "clsact".to_string(),
    ]
}

fn filter_show_args(device: &str, direction: TcDirection) -> Vec<String> {
    vec![
        "-j".to_string(),
        "-s".to_string(),
        "filter".to_string(),
        "show".to_string(),
        "dev".to_string(),
        device.to_string(),
        direction.as_str().to_string(),
    ]
}

fn filter_add_args(
    device: &str,
    direction: TcDirection,
    peer_ip: &str,
    identity: FilterIdentity,
) -> Vec<String> {
    vec![
        "filter".to_string(),
        "add".to_string(),
        "dev".to_string(),
        device.to_string(),
        direction.as_str().to_string(),
        "protocol".to_string(),
        "ip".to_string(),
        "pref".to_string(),
        identity.priority_arg(),
        "handle".to_string(),
        identity.handle_arg(),
        "flower".to_string(),
        "src_ip".to_string(),
        format!("{peer_ip}/32"),
        "dst_ip".to_string(),
        format!("{DNS_READINESS_RESOLVER_IPV4}/32"),
        "ip_proto".to_string(),
        "udp".to_string(),
        "src_port".to_string(),
        DNS_DIAGNOSTIC_SOURCE_PORT.to_string(),
        "dst_port".to_string(),
        DNS_PORT.to_string(),
        "action".to_string(),
        "gact".to_string(),
        "continue".to_string(),
    ]
}

fn filter_delete_args(
    device: &str,
    direction: TcDirection,
    identity: FilterIdentity,
) -> Vec<String> {
    vec![
        "filter".to_string(),
        "del".to_string(),
        "dev".to_string(),
        device.to_string(),
        direction.as_str().to_string(),
        "protocol".to_string(),
        "ip".to_string(),
        "pref".to_string(),
        identity.priority_arg(),
        "handle".to_string(),
        identity.handle_arg(),
        "flower".to_string(),
    ]
}

#[derive(Deserialize)]
struct TcQdiscEntry {
    kind: String,
}

fn parse_clsact_presence(output: &str) -> Result<bool, String> {
    let entries = serde_json::from_str::<Vec<TcQdiscEntry>>(output)
        .map_err(|error| format!("invalid qdisc JSON: {error}"))?;
    let clsact_count = entries
        .iter()
        .filter(|entry| entry.kind == "clsact")
        .count();
    match clsact_count {
        0 => Ok(false),
        1 => Ok(true),
        count => Err(format!("expected at most one clsact qdisc, found {count}")),
    }
}

#[derive(Deserialize)]
struct TcFilterPresence {
    kind: String,
}

fn parse_filter_list_empty(output: &str) -> Result<bool, String> {
    let entries = serde_json::from_str::<Vec<TcFilterPresence>>(output)
        .map_err(|error| format!("invalid filter JSON: {error}"))?;
    if entries.iter().any(|entry| entry.kind.is_empty()) {
        return Err("filter JSON contained an empty kind".to_string());
    }
    Ok(entries.is_empty())
}

#[derive(Deserialize)]
struct TcFilterEntry {
    protocol: Option<String>,
    pref: Option<u16>,
    kind: Option<String>,
    #[serde(default)]
    options: serde_json::Value,
}

#[derive(Deserialize)]
struct TcFilterOptions {
    handle: u32,
    actions: Vec<TcAction>,
}

#[derive(Deserialize)]
struct TcAction {
    kind: String,
    control_action: TcControlAction,
    stats: TcActionStats,
}

#[derive(Deserialize)]
struct TcControlAction {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
struct TcActionStats {
    bytes: u64,
    packets: u64,
}

fn parse_owned_filter(output: &str, identity: FilterIdentity) -> Result<TcCounters, String> {
    let entries = serde_json::from_str::<Vec<TcFilterEntry>>(output)
        .map_err(|error| format!("invalid filter JSON: {error}"))?;
    let mut matching = entries.into_iter().filter(|entry| {
        entry.pref == Some(identity.priority)
            && entry
                .options
                .get("handle")
                .and_then(serde_json::Value::as_u64)
                == Some(u64::from(identity.handle))
    });
    let entry = matching
        .next()
        .ok_or_else(|| "diagnostic filter was not found".to_string())?;
    if matching.next().is_some() {
        return Err("diagnostic filter identity was duplicated".to_string());
    }
    if entry.protocol.as_deref() != Some("ip") || entry.kind.as_deref() != Some("flower") {
        return Err("diagnostic filter identity changed".to_string());
    }
    let options = serde_json::from_value::<TcFilterOptions>(entry.options)
        .map_err(|error| format!("invalid diagnostic filter options: {error}"))?;
    if options.handle != identity.handle {
        return Err("diagnostic filter handle changed".to_string());
    }
    let [action] = <[TcAction; 1]>::try_from(options.actions).map_err(|actions| {
        format!(
            "expected one diagnostic filter action, found {}",
            actions.len()
        )
    })?;
    if action.kind != "gact" || action.control_action.kind != "continue" {
        return Err("diagnostic filter action changed".to_string());
    }
    Ok(TcCounters {
        packets: action.stats.packets,
        bytes: action.stats.bytes,
    })
}

fn command_failure(error: CommandError) -> String {
    bounded_detail(error.to_string())
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
