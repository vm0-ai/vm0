//! Bounded evidence and namespace control for terminal guest DNS readiness failures.

use std::time::{Duration, Instant};

use tracing::warn;
use vsock_host::{ExecCaptureRequest, ExecOperationResult, ExecOwnedCapturedOutput, VsockHost};

use crate::command::{CommandError, exec_with_timeout};
use crate::duration::duration_ms;
use crate::network::{
    make_pool_dns_filter_comment, parse_netns_name, probe_namespace_dns_diagnostic,
};

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(2);
const HOST_COMMAND_TIMEOUT: Duration = Duration::from_millis(1_500);
const GUEST_PROCESS_TIMEOUT_MS: u32 = 1_500;
const GUEST_WAIT_TIMEOUT: Duration = Duration::from_millis(1_750);
const GUEST_OUTPUT_LIMIT_BYTES: u32 = 4 * 1024;
const LOG_OUTPUT_LIMIT_BYTES: usize = 4 * 1024;
const GUEST_DIAGNOSTIC_LABEL: &str = "guest-dns-failure-diagnostics";
const CONTROL_PROBE_TIMEOUT: Duration = Duration::from_millis(500);

const GUEST_STATE_COMMAND: &str = r#"set +e
/usr/sbin/ip -details -statistics link show dev eth0 2>&1
/usr/sbin/ip -4 address show dev eth0 2>&1
/usr/sbin/ip -4 route show table all 2>&1
/usr/sbin/ip neighbor show dev eth0 2>&1
/usr/bin/cat /etc/resolv.conf 2>&1
/usr/bin/grep '^hosts:' /etc/nsswitch.conf 2>&1
true
"#;

#[derive(Clone, Copy)]
pub(crate) struct GuestDnsFailureDiagnosticContext<'a> {
    pub(crate) sandbox_id: &'a str,
    pub(crate) profile: &'a str,
    pub(crate) namespace: &'a str,
    pub(crate) host_device: &'a str,
    pub(crate) peer_ip: &'a str,
    pub(crate) dns_port: u16,
    pub(crate) attachment_generation: u64,
    pub(crate) startup_mode: &'static str,
}

pub(crate) async fn capture_guest_dns_failure_diagnostics(
    guest: &VsockHost,
    context: GuestDnsFailureDiagnosticContext<'_>,
) {
    if tokio::time::timeout(SNAPSHOT_TIMEOUT, capture_snapshot(guest, context))
        .await
        .is_err()
    {
        warn!(
            id = context.sandbox_id,
            profile = context.profile,
            namespace = context.namespace,
            host_device = context.host_device,
            peer_ip = context.peer_ip,
            dns_port = context.dns_port,
            attachment_generation = context.attachment_generation,
            startup_mode = context.startup_mode,
            timeout_ms = SNAPSHOT_TIMEOUT.as_millis() as u64,
            "guest DNS failure diagnostic snapshot timed out"
        );
    }
    run_host_namespace_control_probe(context).await;
}

async fn capture_snapshot(guest: &VsockHost, context: GuestDnsFailureDiagnosticContext<'_>) {
    let namespace = context.namespace;
    let peer_ip = context.peer_ip;
    let listener_port = format!(":{}", context.dns_port);
    let pool_filter_comment =
        parse_netns_name(namespace).map(|parsed| make_pool_dns_filter_comment(parsed.pool_index));

    let namespace_links_args = [
        "netns",
        "exec",
        namespace,
        "ip",
        "-details",
        "-statistics",
        "link",
        "show",
    ];
    let namespace_nat_args = [
        "netns",
        "exec",
        namespace,
        "iptables-save",
        "-c",
        "-t",
        "nat",
    ];
    let raw_rules_args = ["-c", "-t", "raw"];
    let nat_rules_args = ["-c", "-t", "nat"];
    let filter_rules_args = ["-c", "-t", "filter"];
    let conntrack_source_args = ["-L", "-s", peer_ip];
    let conntrack_destination_args = ["-L", "-d", peer_ip];
    let namespace_conntrack_args = [
        "netns",
        "exec",
        namespace,
        "conntrack",
        "-L",
        "-p",
        "udp",
        "--dport",
        "53",
    ];
    let listener_args = ["-H", "-luntpm", "sport", "=", listener_port.as_str()];

    let (
        guest_state,
        namespace_links,
        namespace_nat,
        host_raw_rules,
        host_nat_rules,
        host_filter_rules_ipv4,
        host_filter_rules_ipv6,
        conntrack_source,
        conntrack_destination,
        namespace_dns_conntrack,
        dnsmasq_listener,
    ) = tokio::join!(
        capture_guest_state(guest),
        exec_with_timeout("ip", &namespace_links_args, HOST_COMMAND_TIMEOUT),
        exec_with_timeout("ip", &namespace_nat_args, HOST_COMMAND_TIMEOUT),
        exec_with_timeout("iptables-save", &raw_rules_args, HOST_COMMAND_TIMEOUT),
        exec_with_timeout("iptables-save", &nat_rules_args, HOST_COMMAND_TIMEOUT),
        capture_pool_filter_rules(
            "iptables-save",
            &filter_rules_args,
            pool_filter_comment.as_deref(),
        ),
        capture_pool_filter_rules(
            "ip6tables-save",
            &filter_rules_args,
            pool_filter_comment.as_deref(),
        ),
        exec_with_timeout("conntrack", &conntrack_source_args, HOST_COMMAND_TIMEOUT),
        exec_with_timeout(
            "conntrack",
            &conntrack_destination_args,
            HOST_COMMAND_TIMEOUT,
        ),
        exec_with_timeout("ip", &namespace_conntrack_args, HOST_COMMAND_TIMEOUT),
        exec_with_timeout("ss", &listener_args, HOST_COMMAND_TIMEOUT),
    );

    log_component(context, "guest_state", guest_state);
    log_component(context, "namespace_links", command_output(namespace_links));
    log_component(context, "namespace_nat", command_output(namespace_nat));
    log_component(
        context,
        "host_raw_rules",
        filtered_command_output(host_raw_rules, namespace),
    );
    log_component(
        context,
        "host_nat_rules",
        filtered_command_output(host_nat_rules, namespace),
    );
    log_component(context, "host_filter_rules_ipv4", host_filter_rules_ipv4);
    log_component(context, "host_filter_rules_ipv6", host_filter_rules_ipv6);
    log_component(
        context,
        "conntrack_source",
        command_output(conntrack_source),
    );
    log_component(
        context,
        "conntrack_destination",
        command_output(conntrack_destination),
    );
    log_component(
        context,
        "namespace_dns_conntrack",
        command_output(namespace_dns_conntrack),
    );
    log_component(
        context,
        "dnsmasq_listener",
        command_output(dnsmasq_listener),
    );
}

async fn capture_pool_filter_rules(program: &str, args: &[&str], comment: Option<&str>) -> String {
    let Some(comment) = comment else {
        return "identity_error=invalid_namespace".to_string();
    };
    filtered_command_output(
        exec_with_timeout(program, args, HOST_COMMAND_TIMEOUT).await,
        comment,
    )
}

async fn run_host_namespace_control_probe(context: GuestDnsFailureDiagnosticContext<'_>) {
    let started = Instant::now();
    let output = match probe_namespace_dns_diagnostic(
        context.namespace.to_string(),
        CONTROL_PROBE_TIMEOUT,
    )
    .await
    {
        Ok(attempts) => format!(
            "diagnostic_traffic=true success=true attempts={attempts} elapsed_ms={}",
            duration_ms(started.elapsed()),
        ),
        Err(error) => format!(
            "diagnostic_traffic=true success=false stage={} io_kind={:?} attempts={} elapsed_ms={}",
            error.stage_label(),
            error.io_kind(),
            error.attempts(),
            duration_ms(started.elapsed()),
        ),
    };
    log_component(context, "host_namespace_readiness", output);
}

async fn capture_guest_state(guest: &VsockHost) -> String {
    let request = ExecCaptureRequest {
        timeout_ms: GUEST_PROCESS_TIMEOUT_MS,
        command: GUEST_STATE_COMMAND,
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

fn command_output(result: Result<String, CommandError>) -> String {
    match result {
        Ok(output) if output.is_empty() => "[no output]".to_string(),
        Ok(output) => bounded_output(output),
        Err(error) => bounded_output(format!("command_error={error}")),
    }
}

fn filtered_command_output(result: Result<String, CommandError>, needle: &str) -> String {
    match result {
        Ok(output) => {
            let filtered = output
                .lines()
                .filter(|line| line_has_exact_comment(line, needle))
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

fn line_has_exact_comment(line: &str, expected: &str) -> bool {
    let mut tokens = line.split_whitespace();
    while let Some(token) = tokens.next() {
        if token == "--comment" {
            return tokens
                .next()
                .is_some_and(|comment| comment.trim_matches('"') == expected);
        }
    }
    false
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

fn log_component(
    context: GuestDnsFailureDiagnosticContext<'_>,
    component: &'static str,
    output: String,
) {
    warn!(
        id = context.sandbox_id,
        profile = context.profile,
        namespace = context.namespace,
        host_device = context.host_device,
        peer_ip = context.peer_ip,
        dns_port = context.dns_port,
        attachment_generation = context.attachment_generation,
        startup_mode = context.startup_mode,
        component,
        output,
        "guest DNS failure diagnostic component"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_output_truncates_at_utf8_boundary() {
        let output = "a".repeat(LOG_OUTPUT_LIMIT_BYTES - 1) + "界";

        let bounded = bounded_output(output);

        assert!(bounded.is_char_boundary(LOG_OUTPUT_LIMIT_BYTES - 1));
        assert!(bounded.starts_with(&"a".repeat(LOG_OUTPUT_LIMIT_BYTES - 1)));
        assert!(bounded.ends_with("\n[output truncated]"));
        assert!(!bounded.contains('界'));
    }

    #[test]
    fn filtered_command_output_keeps_only_namespace_rules() {
        let namespace = "vm0-ns-0c-20";
        let output = [
            "-A PREROUTING -m comment --comment vm0-ns-0c-1f -j DROP",
            "-A PREROUTING -m comment --comment vm0-ns-0c-20 -j DROP",
            "-A PREROUTING -m comment --comment vm0-ns-0c-200 -j DROP",
            "-A PREROUTING -m comment --comment vm0-ns-0c-21 -j DROP",
        ]
        .join("\n");

        let filtered = filtered_command_output(Ok(output), namespace);

        assert_eq!(
            filtered,
            "-A PREROUTING -m comment --comment vm0-ns-0c-20 -j DROP"
        );
    }

    #[test]
    fn filtered_command_output_keeps_only_exact_pool_dns_rules() {
        let comment = "vm0-ns-0c-dns";
        let output = [
            "-A INPUT -i vm0-ve-0c-+ -p udp --dport 5353 -m comment --comment vm0-ns-0c-dns",
            "-A INPUT ! -i vm0-ve-0c-+ -p udp --dport 5353 -m comment --comment vm0-ns-0c-dns -j REJECT",
            "-A INPUT -i vm0-ve-0b-+ -p udp --dport 5353 -m comment --comment vm0-ns-0b-dns",
            "-A INPUT -i vm0-ve-0c-+ -p udp --dport 5353 -m comment --comment vm0-ns-0c-dns-old",
        ]
        .join("\n");

        let filtered = filtered_command_output(Ok(output), comment);

        assert_eq!(filtered.lines().count(), 2);
        assert!(
            filtered
                .lines()
                .all(|line| line_has_exact_comment(line, comment))
        );
        assert!(filtered.contains("-j REJECT"));
        assert!(filtered.lines().any(|line| !line.contains("-j")));
    }
}
