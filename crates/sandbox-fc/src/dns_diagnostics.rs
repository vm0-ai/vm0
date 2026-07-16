//! Bounded failure snapshots for guest DNS and storage-bootstrap failures.

use std::time::Duration;

use tracing::warn;
use vsock_host::{ExecCaptureRequest, ExecOperationResult, ExecOwnedCapturedOutput, VsockHost};

use crate::command::exec_with_timeout;
use crate::guest_dns_readiness::probe_guest_dns_once;
#[cfg(test)]
use crate::network::DNS_READINESS_HOSTNAME;
use crate::network::probe_namespace_dns;

const HOST_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
const HOST_READINESS_TIMEOUT: Duration = Duration::from_secs(3);
const GUEST_PROCESS_TIMEOUT_MS: u32 = 2_000;
const GUEST_WAIT_TIMEOUT: Duration = Duration::from_secs(3);
const GUEST_READINESS_WAIT_TIMEOUT: Duration = Duration::from_millis(1_500);
const GUEST_OUTPUT_LIMIT_BYTES: u32 = 4 * 1024;
const LOG_OUTPUT_LIMIT_BYTES: usize = 4 * 1024;
const GUEST_DIAGNOSTIC_LABEL: &str = "guest-dns-diagnostics";

const GUEST_STATE_COMMAND: &str = r#"set +e
printf '%s\n' '--- eth0 link ---'
/usr/sbin/ip -details -statistics link show dev eth0 2>&1
printf '%s\n' '--- eth0 address ---'
/usr/sbin/ip -4 address show dev eth0 2>&1
printf '%s\n' '--- IPv4 routes ---'
/usr/sbin/ip -4 route show table all 2>&1
printf '%s\n' '--- eth0 neighbors ---'
/usr/sbin/ip neighbor show dev eth0 2>&1
printf '%s\n' '--- resolv.conf ---'
/usr/bin/cat /etc/resolv.conf 2>&1
"#;

#[derive(Clone, Copy)]
pub(crate) struct GuestDnsDiagnosticContext<'a> {
    pub(crate) sandbox_id: &'a str,
    pub(crate) run_id: Option<&'a str>,
    pub(crate) profile: &'a str,
    pub(crate) namespace: &'a str,
    pub(crate) host_device: &'a str,
    pub(crate) peer_ip: &'a str,
    pub(crate) attachment_generation: u64,
    pub(crate) dns_port: u16,
    pub(crate) startup_mode: &'static str,
    pub(crate) trigger: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct GuestDnsDiagnosticOutcome {
    pub(crate) guest_ready: bool,
}

#[derive(Clone, Copy)]
struct HostDnsDiagnosticContext<'a> {
    namespace: &'a str,
    host_device: &'a str,
    peer_ip: &'a str,
    dns_port: u16,
}

impl<'a> From<GuestDnsDiagnosticContext<'a>> for HostDnsDiagnosticContext<'a> {
    fn from(context: GuestDnsDiagnosticContext<'a>) -> Self {
        Self {
            namespace: context.namespace,
            host_device: context.host_device,
            peer_ip: context.peer_ip,
            dns_port: context.dns_port,
        }
    }
}

pub(crate) async fn capture_guest_dns_diagnostics(
    guest: Option<&VsockHost>,
    context: GuestDnsDiagnosticContext<'_>,
) -> GuestDnsDiagnosticOutcome {
    warn!(
        id = context.sandbox_id,
        run_id = context.run_id.unwrap_or("unavailable"),
        profile = context.profile,
        namespace = context.namespace,
        host_device = context.host_device,
        peer_ip = context.peer_ip,
        attachment_generation = context.attachment_generation,
        startup_mode = context.startup_mode,
        trigger = context.trigger,
        architecture = std::env::consts::ARCH,
        "guest DNS diagnostic snapshot started"
    );

    // Capture passive state before active probes can populate neighbors or
    // conntrack entries and obscure the failure that triggered this snapshot.
    let (guest_state, host_state) = tokio::join!(
        capture_guest_state(guest),
        capture_passive_host_state(context.into()),
    );
    log_component(context, "guest_state", guest_state);
    for (component, output) in host_state {
        log_component(context, component, output);
    }

    let (guest_readiness, host_readiness) = tokio::join!(
        capture_guest_readiness(guest),
        capture_host_readiness(context.namespace),
    );
    log_component(context, "guest_readiness", guest_readiness.output);
    log_component(context, "host_namespace_readiness", host_readiness);

    warn!(
        id = context.sandbox_id,
        run_id = context.run_id.unwrap_or("unavailable"),
        profile = context.profile,
        namespace = context.namespace,
        host_device = context.host_device,
        peer_ip = context.peer_ip,
        attachment_generation = context.attachment_generation,
        startup_mode = context.startup_mode,
        trigger = context.trigger,
        guest_ready = guest_readiness.ready,
        "guest DNS diagnostic snapshot completed"
    );

    GuestDnsDiagnosticOutcome {
        guest_ready: guest_readiness.ready,
    }
}

async fn capture_guest_state(guest: Option<&VsockHost>) -> String {
    let Some(guest) = guest else {
        return "guest_unavailable=true".to_string();
    };
    capture_guest_command(guest, GUEST_STATE_COMMAND).await
}

async fn capture_guest_command(guest: &VsockHost, command: &str) -> String {
    let request = ExecCaptureRequest {
        timeout_ms: GUEST_PROCESS_TIMEOUT_MS,
        command,
        env: &[],
        sudo: false,
        label: GUEST_DIAGNOSTIC_LABEL,
        stdout_limit_bytes: GUEST_OUTPUT_LIMIT_BYTES,
        stderr_limit_bytes: GUEST_OUTPUT_LIMIT_BYTES,
        expected_exit_codes: &[],
        stdin_bytes: None,
        wait_timeout: GUEST_WAIT_TIMEOUT,
    };
    match guest.exec_operation_capture(request).await {
        Ok(result) => format_guest_result(result),
        Err(error) => bounded_output(format!("transport_error={:?}", error.kind())),
    }
}

fn format_guest_result(result: ExecOperationResult) -> String {
    let (stdout, stdout_truncated) = captured_output(result.stdout);
    let (stderr, stderr_truncated) = captured_output(result.stderr);
    bounded_output(format!(
        "termination={:?} duration_ms={} stream_overflowed={} stdout_truncated={} stderr_truncated={}\nstdout:\n{}\nstderr:\n{}",
        result.termination,
        result.duration_ms,
        result.stream_overflowed,
        stdout_truncated,
        stderr_truncated,
        stdout,
        stderr,
    ))
}

fn captured_output(output: ExecOwnedCapturedOutput) -> (String, bool) {
    match output {
        ExecOwnedCapturedOutput::Discarded => ("[discarded]".to_string(), false),
        ExecOwnedCapturedOutput::Captured { bytes, truncated } => {
            (String::from_utf8_lossy(&bytes).into_owned(), truncated)
        }
    }
}

struct GuestReadinessSnapshot {
    ready: bool,
    output: String,
}

async fn capture_guest_readiness(guest: Option<&VsockHost>) -> GuestReadinessSnapshot {
    let Some(guest) = guest else {
        return GuestReadinessSnapshot {
            ready: false,
            output: "ready=false outcome=guest_unavailable".to_string(),
        };
    };

    match probe_guest_dns_once(guest, GUEST_READINESS_WAIT_TIMEOUT).await {
        Ok(()) => GuestReadinessSnapshot {
            ready: true,
            output: "ready=true".to_string(),
        },
        Err(error) => GuestReadinessSnapshot {
            ready: false,
            output: format!("ready=false outcome={error}"),
        },
    }
}

async fn capture_passive_host_state(
    context: HostDnsDiagnosticContext<'_>,
) -> Vec<(&'static str, String)> {
    let namespace = context.namespace;
    let host_device = context.host_device;
    let peer_ip = context.peer_ip;
    let host_link_args = [
        "-details",
        "-statistics",
        "address",
        "show",
        "dev",
        host_device,
    ];
    let namespace_links_args = [
        "netns",
        "exec",
        namespace,
        "ip",
        "-details",
        "-statistics",
        "address",
        "show",
    ];
    let namespace_routes_args = [
        "netns", "exec", namespace, "ip", "-4", "route", "show", "table", "all",
    ];
    let namespace_neighbors_args = ["netns", "exec", namespace, "ip", "neighbor", "show"];
    let namespace_nat_rules_args = [
        "netns",
        "exec",
        namespace,
        "iptables-save",
        "-c",
        "-t",
        "nat",
    ];
    let nat_rules_args = ["-c", "-t", "nat"];
    let filter_rules_args = ["-c", "-t", "filter"];
    let conntrack_source_args = ["-L", "-s", peer_ip];
    let conntrack_destination_args = ["-L", "-d", peer_ip];
    let listener_filter = dns_listener_filter(context.dns_port);
    let listeners_args = ["-H", "-luntp", listener_filter.as_str()];
    let (
        host_link,
        namespace_links,
        namespace_routes,
        namespace_neighbors,
        namespace_nat_rules,
        nat_rules,
        filter_rules,
        conntrack_source,
        conntrack_destination,
        listeners,
    ) = tokio::join!(
        exec_with_timeout("ip", &host_link_args, HOST_COMMAND_TIMEOUT),
        exec_with_timeout("ip", &namespace_links_args, HOST_COMMAND_TIMEOUT),
        exec_with_timeout("ip", &namespace_routes_args, HOST_COMMAND_TIMEOUT),
        exec_with_timeout("ip", &namespace_neighbors_args, HOST_COMMAND_TIMEOUT),
        exec_with_timeout("ip", &namespace_nat_rules_args, HOST_COMMAND_TIMEOUT),
        exec_with_timeout("iptables-save", &nat_rules_args, HOST_COMMAND_TIMEOUT),
        exec_with_timeout("iptables-save", &filter_rules_args, HOST_COMMAND_TIMEOUT),
        exec_with_timeout("conntrack", &conntrack_source_args, HOST_COMMAND_TIMEOUT),
        exec_with_timeout(
            "conntrack",
            &conntrack_destination_args,
            HOST_COMMAND_TIMEOUT,
        ),
        exec_with_timeout("ss", &listeners_args, HOST_COMMAND_TIMEOUT),
    );
    vec![
        ("host_veth", command_output(host_link)),
        ("namespace_links", command_output(namespace_links)),
        ("namespace_routes", command_output(namespace_routes)),
        ("namespace_neighbors", command_output(namespace_neighbors)),
        ("namespace_nat_rules", command_output(namespace_nat_rules)),
        (
            "host_nat_rules",
            filtered_command_output(nat_rules, namespace),
        ),
        (
            "host_filter_rules",
            filtered_command_output(filter_rules, namespace),
        ),
        ("conntrack_source", command_output(conntrack_source)),
        (
            "conntrack_destination",
            command_output(conntrack_destination),
        ),
        ("dnsmasq_listener", command_output(listeners)),
    ]
}

fn dns_listener_filter(port: u16) -> String {
    format!("sport = :{port}")
}

async fn capture_host_readiness(namespace: &str) -> String {
    match tokio::time::timeout(
        HOST_READINESS_TIMEOUT,
        probe_namespace_dns(namespace.to_string()),
    )
    .await
    {
        Ok(Ok(attempts)) => format!("ready=true attempts={attempts}"),
        Ok(Err(error)) => format!("ready=false error={error}"),
        Err(_) => format!(
            "ready=false error=diagnostic_timeout_ms={}",
            HOST_READINESS_TIMEOUT.as_millis()
        ),
    }
}

fn command_output(result: Result<String, crate::command::CommandError>) -> String {
    match result {
        Ok(output) if output.is_empty() => "[no output]".to_string(),
        Ok(output) => bounded_output(output),
        Err(error) => bounded_output(format!("command_error={error}")),
    }
}

fn filtered_command_output(
    result: Result<String, crate::command::CommandError>,
    needle: &str,
) -> String {
    match result {
        Ok(output) => {
            let filtered = output
                .lines()
                .filter(|line| line.contains(needle))
                .collect::<Vec<_>>()
                .join("\n");
            if filtered.is_empty() {
                "[no matching output]".to_string()
            } else {
                bounded_output(filtered)
            }
        }
        Err(error) => bounded_output(format!("command_error={error}")),
    }
}

fn bounded_output(output: String) -> String {
    if output.len() <= LOG_OUTPUT_LIMIT_BYTES {
        return output;
    }
    let mut end = LOG_OUTPUT_LIMIT_BYTES;
    while !output.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[output truncated]", &output[..end])
}

fn log_component(context: GuestDnsDiagnosticContext<'_>, component: &'static str, output: String) {
    warn!(
        id = context.sandbox_id,
        run_id = context.run_id.unwrap_or("unavailable"),
        profile = context.profile,
        namespace = context.namespace,
        host_device = context.host_device,
        peer_ip = context.peer_ip,
        attachment_generation = context.attachment_generation,
        startup_mode = context.startup_mode,
        trigger = context.trigger,
        component,
        output,
        "guest DNS diagnostic component"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filtered_command_output_keeps_only_correlated_lines() {
        let output = "-A PREROUTING --comment other\n-A PREROUTING --comment vm0-ns-01-02\n";

        let filtered = filtered_command_output(Ok(output.to_string()), "vm0-ns-01-02");

        assert_eq!(filtered, "-A PREROUTING --comment vm0-ns-01-02");
    }

    #[test]
    fn bounded_output_preserves_utf8_boundary() {
        let output = "界".repeat(LOG_OUTPUT_LIMIT_BYTES);

        let bounded = bounded_output(output);

        assert!(bounded.ends_with("[output truncated]"));
        assert!(bounded.is_char_boundary(bounded.len()));
    }

    #[test]
    fn guest_diagnostics_do_not_query_public_dns() {
        assert!(!GUEST_STATE_COMMAND.contains("getent"));
        assert!(!GUEST_STATE_COMMAND.contains(DNS_READINESS_HOSTNAME));
        assert!(!GUEST_STATE_COMMAND.contains("8.8.8.8"));
    }

    #[test]
    fn dns_listener_query_filters_exact_source_port_at_command_boundary() {
        assert_eq!(dns_listener_filter(5353), "sport = :5353");
    }
}
