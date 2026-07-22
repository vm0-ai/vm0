use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use nix::fcntl::{Flock, FlockArg};
use tracing::{error, info, warn};

use crate::command::{
    CommandError, IgnoredCommandOutcome, exec_ignore_errors_with_timeout, exec_status_with_timeout,
    exec_with_timeout,
};
use crate::paths::LockPaths;

use super::super::error::{NetworkError, Result};
use super::super::{GUEST_NETWORK, GuestNetwork};
use super::naming::{
    MAX_NAMESPACES, MAX_POOLS, NS_PREFIX, format_hex_index, generate_veth_ip_pair,
    make_host_device, make_host_device_iptables_pattern, make_ns_name, parse_netns_name,
};
use super::types::NetnsInfo;

const NETNS_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
static CONNTRACK_NOT_FOUND_LOGGED: AtomicBool = AtomicBool::new(false);

/// Peer-side device name inside namespaces (fixed).
const PEER_DEVICE: &str = "veth0";

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

#[derive(Clone)]
pub(super) struct NetnsLifecycleOps {
    pub(super) flush_conntrack:
        Arc<dyn Fn(String) -> BoxFuture<ConntrackFlushOutcome> + Send + Sync>,
    pub(super) delete_namespace:
        Arc<dyn Fn(NetnsInfo) -> BoxFuture<NamespaceDeleteOutcome> + Send + Sync>,
}

impl Default for NetnsLifecycleOps {
    fn default() -> Self {
        Self {
            flush_conntrack: Arc::new(|peer_ip| {
                Box::pin(async move { flush_conntrack(&peer_ip).await })
            }),
            delete_namespace: Arc::new(|ns| {
                Box::pin(async move { delete_namespace_resources(&ns.name, &ns.host_device).await })
            }),
        }
    }
}

#[cfg(test)]
impl NetnsLifecycleOps {
    pub(super) fn trusted_for_test() -> Self {
        Self {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_namespace: Arc::new(|_| Box::pin(async { NamespaceDeleteOutcome::Deleted })),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ConntrackFlushOutcome {
    Trusted,
    Untrusted,
}

impl ConntrackFlushOutcome {
    pub(super) fn is_trusted(self) -> bool {
        matches!(self, Self::Trusted)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum NamespaceDeleteOutcome {
    Deleted,
    Abandoned,
}

impl NamespaceDeleteOutcome {
    fn from_best_effort(outcomes: impl IntoIterator<Item = IgnoredCommandOutcome>) -> Self {
        if outcomes
            .into_iter()
            .all(|outcome| outcome.completed_without_timeout())
        {
            Self::Deleted
        } else {
            Self::Abandoned
        }
    }
}

/// Shorthand: run `ip <args>`, discard stdout.
async fn exec_ip(args: &[&str]) -> Result<()> {
    exec_status_with_timeout("ip", args, NETNS_COMMAND_TIMEOUT).await?;
    Ok(())
}

/// Prepend an unbounded xtables lock wait to a mutating firewall command.
///
/// The surrounding command timeout remains the sole deadline so an exhausted
/// wait is classified as a timeout instead of a completed non-zero exit.
fn xtables_args<'a>(args: &[&'a str]) -> Vec<&'a str> {
    let mut waited_args = Vec::with_capacity(args.len() + 1);
    waited_args.push("--wait");
    waited_args.extend_from_slice(args);
    waited_args
}

async fn exec_xtables_status_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> std::result::Result<(), CommandError> {
    let args = xtables_args(args);
    exec_status_with_timeout(program, &args, timeout).await
}

async fn exec_xtables_ignore_errors_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> IgnoredCommandOutcome {
    let args = xtables_args(args);
    exec_ignore_errors_with_timeout(program, &args, timeout).await
}

/// Shorthand: run a bounded mutating `iptables` command and discard stdout.
async fn exec_iptables(args: &[&str]) -> Result<()> {
    exec_xtables_status_with_timeout("iptables", args, NETNS_COMMAND_TIMEOUT).await?;
    Ok(())
}

/// Restrict the runner-managed DNS port to this pool's VM-facing veths.
///
/// dnsmasq's default socket mode avoids per-address listener churn by using
/// wildcard sockets. These INPUT rules preserve the old kernel-level listener
/// isolation: public, management, and other runners' interfaces see the port as
/// unreachable, while REDIRECT traffic arriving on this pool's veths proceeds
/// to dnsmasq. Both address families are covered because dnsmasq can create
/// IPv4 and IPv6 wildcard sockets.
pub(super) async fn setup_dns_input_filter(pool_index: u32, dns_port: u16) -> Result<String> {
    let pool_idx = format_hex_index(pool_index);
    let interface = make_host_device_iptables_pattern(&pool_idx);
    let comment = format!("{NS_PREFIX}{pool_idx}-dns");
    let port = dns_port.to_string();

    for program in ["iptables", "ip6tables"] {
        for protocol in ["udp", "tcp"] {
            let args = [
                "-I",
                "INPUT",
                "1",
                "!",
                "-i",
                &interface,
                "-p",
                protocol,
                "--dport",
                &port,
                "-m",
                "comment",
                "--comment",
                &comment,
                "-j",
                "REJECT",
            ];
            if let Err(error) =
                exec_xtables_status_with_timeout(program, &args, NETNS_COMMAND_TIMEOUT).await
            {
                if matches!(
                    delete_pool_firewall_rules_by_comment(&comment).await,
                    NamespaceDeleteOutcome::Abandoned
                ) {
                    warn!(
                        comment,
                        "failed to roll back partial DNS input filter; startup orphan reconciliation will retry"
                    );
                }
                return Err(error.into());
            }
        }
    }

    info!(dns_port, interface, comment, "DNS input filter installed");
    Ok(comment)
}

pub(super) async fn enable_host_ip_forwarding() -> Result<()> {
    exec_status_with_timeout(
        "sysctl",
        &["-w", "net.ipv4.ip_forward=1"],
        NETNS_COMMAND_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Create a network namespace with a TAP device.
async fn create_netns_with_tap(
    ns_name: &str,
    tap_name: &str,
    tap_mac: &str,
    gateway_ip_with_prefix: &str,
) -> Result<()> {
    exec_ip(&["netns", "add", ns_name]).await?;
    exec_ip(&[
        "netns", "exec", ns_name, "ip", "tuntap", "add", tap_name, "mode", "tap",
    ])
    .await?;
    // Set a fixed MAC so guest ARP cache from snapshots stays valid after restore.
    exec_ip(&[
        "netns", "exec", ns_name, "ip", "link", "set", tap_name, "address", tap_mac,
    ])
    .await?;
    exec_ip(&[
        "netns",
        "exec",
        ns_name,
        "ip",
        "addr",
        "add",
        gateway_ip_with_prefix,
        "dev",
        tap_name,
    ])
    .await?;
    exec_ip(&[
        "netns", "exec", ns_name, "ip", "link", "set", tap_name, "up",
    ])
    .await?;
    exec_ip(&["netns", "exec", ns_name, "ip", "link", "set", "lo", "up"]).await?;
    Ok(())
}

/// Add a veth pair connecting the namespace to the host.
async fn setup_veth_pair(
    name: &str,
    host_device: &str,
    host_ip: &str,
    peer_ip: &str,
) -> Result<()> {
    let peer_cidr = format!("{peer_ip}/30");
    let host_cidr = format!("{host_ip}/30");
    exec_ip(&[
        "link",
        "add",
        host_device,
        "type",
        "veth",
        "peer",
        "name",
        PEER_DEVICE,
        "netns",
        name,
    ])
    .await?;
    exec_ip(&[
        "netns",
        "exec",
        name,
        "ip",
        "addr",
        "add",
        &peer_cidr,
        "dev",
        PEER_DEVICE,
    ])
    .await?;
    exec_ip(&[
        "netns",
        "exec",
        name,
        "ip",
        "link",
        "set",
        PEER_DEVICE,
        "up",
    ])
    .await?;
    exec_ip(&["addr", "add", &host_cidr, "dev", host_device]).await?;
    exec_ip(&["link", "set", host_device, "up"]).await?;
    Ok(())
}

/// Configure routing, NAT, and IP forwarding inside the namespace.
async fn setup_namespace_routing(
    name: &str,
    host_ip: &str,
    gateway_ip: &str,
    prefix_len: u8,
) -> Result<()> {
    let src = format!("{gateway_ip}/{prefix_len}");
    exec_ip(&[
        "netns", "exec", name, "ip", "route", "add", "default", "via", host_ip,
    ])
    .await?;
    let mut iptables_command_args = vec!["netns", "exec", name, "iptables"];
    iptables_command_args.extend(xtables_args(&[
        "-t",
        "nat",
        "-A",
        "POSTROUTING",
        "-s",
        &src,
        "-o",
        PEER_DEVICE,
        "-j",
        "MASQUERADE",
    ]));
    exec_ip(&iptables_command_args).await?;
    exec_ip(&[
        "netns",
        "exec",
        name,
        "sysctl",
        "-w",
        "net.ipv4.ip_forward=1",
    ])
    .await?;
    Ok(())
}

/// Add host-side source validation and forwarding rules.
///
/// The raw PREROUTING guard establishes the namespace's peer IP as a trusted
/// identity before conntrack and NAT redirects can attribute the packet. This
/// must remain independent of host reverse-path-filter configuration.
async fn setup_host_iptables(
    name: &str,
    host_device: &str,
    peer_ip: &str,
    default_iface: &str,
) -> Result<()> {
    let peer = format!("{peer_ip}/32");
    exec_iptables(&[
        "-t",
        "raw",
        "-I",
        "PREROUTING",
        "1",
        "-i",
        host_device,
        "!",
        "-s",
        &peer,
        "-m",
        "comment",
        "--comment",
        name,
        "-j",
        "DROP",
    ])
    .await?;
    exec_iptables(&[
        "-t",
        "nat",
        "-A",
        "POSTROUTING",
        "-s",
        &peer,
        "-o",
        default_iface,
        "-j",
        "MASQUERADE",
        "-m",
        "comment",
        "--comment",
        name,
    ])
    .await?;
    exec_iptables(&[
        "-A",
        "FORWARD",
        "-i",
        host_device,
        "-s",
        &peer,
        "-o",
        default_iface,
        "-j",
        "ACCEPT",
        "-m",
        "comment",
        "--comment",
        name,
    ])
    .await?;
    exec_iptables(&[
        "-A",
        "FORWARD",
        "-i",
        default_iface,
        "-o",
        host_device,
        "-d",
        &peer,
        "-m",
        "state",
        "--state",
        "RELATED,ESTABLISHED",
        "-j",
        "ACCEPT",
        "-m",
        "comment",
        "--comment",
        name,
    ])
    .await?;
    Ok(())
}

/// Add a proxy REDIRECT rule for outbound TCP traffic in PREROUTING.
///
/// This rule redirects outbound TCP traffic from the namespace's veth peer IP
/// to the specified proxy port on the host. When the DNS proxy is enabled,
/// standard DNS (53) and DNS-over-TLS (853) are excluded so their dedicated
/// rules cannot be bypassed by mitmproxy's raw TCP passthrough. Without a DNS
/// proxy, all TCP traffic keeps the existing mitmproxy behavior.
async fn add_proxy_redirect_rule(
    name: &str,
    host_device: &str,
    peer_ip: &str,
    proxy_port: u16,
    dns_proxy_enabled: bool,
) -> Result<()> {
    let src = format!("{peer_ip}/32");
    let port_str = proxy_port.to_string();
    let mut args: Vec<&str> = vec![
        "-t",
        "nat",
        "-A",
        "PREROUTING",
        "-i",
        host_device,
        "-s",
        &src,
        "-p",
        "tcp",
    ];
    if dns_proxy_enabled {
        args.extend(["-m", "multiport", "!", "--dports", "53,853"]);
    }
    args.extend([
        "-j",
        "REDIRECT",
        "--to-port",
        &port_str,
        "-m",
        "comment",
        "--comment",
        name,
    ]);
    exec_iptables(&args).await?;
    Ok(())
}

/// Add LOG rule for all non-TCP outbound traffic in FORWARD chain.
///
/// Logs packet metadata (src/dst IP, port, protocol, size) to the kernel
/// log with a `VM0:<peer_ip>:` prefix so the runner can match entries to
/// VMs and write them to the per-run network JSONL file.
///
/// Uses `-I FORWARD 1` (insert at top) instead of `-A` (append) because
/// the ACCEPT rules from [`setup_host_iptables`] are already in the chain.
/// LOG is a non-terminating target (packet continues to the next rule),
/// so it must come before ACCEPT to fire.
async fn add_non_tcp_log_rule(name: &str, host_device: &str, peer_ip: &str) -> Result<()> {
    let src = format!("{peer_ip}/32");
    let prefix = format!("VM0:{peer_ip}:");
    exec_iptables(&[
        "-I",
        "FORWARD",
        "1",
        "-i",
        host_device,
        "-s",
        &src,
        "!",
        "-p",
        "tcp",
        "-m",
        "limit",
        "--limit",
        "10/sec",
        "--limit-burst",
        "50",
        "-j",
        "LOG",
        "--log-prefix",
        &prefix,
        "--log-level",
        "4",
        "-m",
        "comment",
        "--comment",
        name,
    ])
    .await?;
    Ok(())
}

/// Redirect standard outbound DNS (UDP/TCP 53) to the local dnsmasq port.
///
/// VM resolv.conf points to an external nameserver as a dummy target.
/// These PREROUTING REDIRECT rules intercept packets before FORWARD/MASQUERADE,
/// preserving the original source IP (peer veth) for per-VM log routing. TCP
/// support covers explicit DNS-over-TCP and fallback after truncated UDP
/// responses.
async fn add_dns_redirect_rules(
    name: &str,
    host_device: &str,
    peer_ip: &str,
    dns_port: u16,
) -> Result<()> {
    let src = format!("{peer_ip}/32");
    let port_str = dns_port.to_string();
    for protocol in ["udp", "tcp"] {
        exec_iptables(&[
            "-t",
            "nat",
            "-A",
            "PREROUTING",
            "-i",
            host_device,
            "-s",
            &src,
            "-p",
            protocol,
            "--dport",
            "53",
            "-j",
            "REDIRECT",
            "--to-port",
            &port_str,
            "-m",
            "comment",
            "--comment",
            name,
        ])
        .await?;
    }
    Ok(())
}

/// Drop external DNS traffic that bypasses the REDIRECT rule.
///
/// Blocks UDP/TCP 53 and TCP 853 (DNS over TLS) in FORWARD chain.
/// DNS over HTTPS (TCP 443) is handled by mitmproxy at HTTP level.
async fn add_dns_drop_rules(name: &str, host_device: &str, peer_ip: &str) -> Result<()> {
    let src = format!("{peer_ip}/32");
    for (protocol, port) in [("udp", "53"), ("tcp", "53"), ("tcp", "853")] {
        exec_iptables(&[
            "-I",
            "FORWARD",
            "1",
            "-i",
            host_device,
            "-s",
            &src,
            "-p",
            protocol,
            "--dport",
            port,
            "-j",
            "DROP",
            "-m",
            "comment",
            "--comment",
            name,
        ])
        .await?;
    }
    Ok(())
}

pub(super) async fn get_default_interface() -> Result<String> {
    let result =
        exec_with_timeout("ip", &["route", "get", "8.8.8.8"], NETNS_COMMAND_TIMEOUT).await?;
    let iface = result
        .split_whitespace()
        .skip_while(|&w| w != "dev")
        .nth(1)
        .map(String::from)
        .ok_or(NetworkError::NoDefaultInterface(result))?;
    Ok(iface)
}

/// Delete IPv4 iptables rules that contain `comment`.
async fn delete_iptables_rules_by_comment(comment: &str) -> NamespaceDeleteOutcome {
    let (raw, nat, filter) = tokio::join!(
        delete_firewall_rules_from_table("iptables", "iptables-save", "raw", comment),
        delete_firewall_rules_from_table("iptables", "iptables-save", "nat", comment),
        delete_firewall_rules_from_table("iptables", "iptables-save", "filter", comment),
    );
    if matches!(raw, NamespaceDeleteOutcome::Deleted)
        && matches!(nat, NamespaceDeleteOutcome::Deleted)
        && matches!(filter, NamespaceDeleteOutcome::Deleted)
    {
        NamespaceDeleteOutcome::Deleted
    } else {
        NamespaceDeleteOutcome::Abandoned
    }
}

/// Delete pool-scoped IPv4 and IPv6 firewall rules that contain `comment`.
pub(super) async fn delete_pool_firewall_rules_by_comment(comment: &str) -> NamespaceDeleteOutcome {
    let (ipv4, ipv6_filter) = tokio::join!(
        delete_iptables_rules_by_comment(comment),
        delete_firewall_rules_from_table("ip6tables", "ip6tables-save", "filter", comment),
    );
    if matches!(ipv4, NamespaceDeleteOutcome::Deleted)
        && matches!(ipv6_filter, NamespaceDeleteOutcome::Deleted)
    {
        NamespaceDeleteOutcome::Deleted
    } else {
        NamespaceDeleteOutcome::Abandoned
    }
}

async fn delete_firewall_rules_from_table(
    command: &str,
    save_command: &str,
    table: &str,
    comment: &str,
) -> NamespaceDeleteOutcome {
    let output = match exec_with_timeout(save_command, &["-t", table], NETNS_COMMAND_TIMEOUT).await
    {
        Ok(output) => output,
        Err(e) => {
            warn!(save_command, table, error = %e, "failed to read firewall rules, skipping cleanup");
            return NamespaceDeleteOutcome::Abandoned;
        }
    };
    delete_firewall_rule_lines(
        command,
        table,
        output
            .lines()
            .filter(|line| line.starts_with("-A ") && line.contains(comment)),
    )
    .await
}

async fn delete_firewall_rule_lines<'a>(
    command: &str,
    table: &str,
    rules: impl Iterator<Item = &'a str>,
) -> NamespaceDeleteOutcome {
    // Sequential: the legacy xtables lock serializes writes to the same table anyway.
    // Note: split_whitespace + trim_matches('"') is safe because namespace
    // comment values (e.g. "vm0-ns-00-0a") never contain spaces. If they
    // did, iptables-save would quote them as `--comment "foo bar"` and the
    // split would incorrectly break the value into separate arguments.
    let mut outcomes = Vec::new();
    for line in rules {
        let rule = line.replacen("-A ", "-D ", 1);
        let mut args: Vec<&str> = vec!["-t", table];
        args.extend(rule.split_whitespace().map(|t| t.trim_matches('"')));
        outcomes.push(
            exec_xtables_ignore_errors_with_timeout(command, &args, NETNS_COMMAND_TIMEOUT).await,
        );
    }
    NamespaceDeleteOutcome::from_best_effort(outcomes)
}

/// Delete a namespace's network resources (iptables, veth, netns).
async fn delete_namespace_resources(ns_name: &str, host_device: &str) -> NamespaceDeleteOutcome {
    info!(name = %ns_name, "deleting namespace");
    let iptables = delete_iptables_rules_by_comment(ns_name).await;
    let outcome = delete_namespace_link_and_netns(ns_name, host_device).await;
    if matches!(iptables, NamespaceDeleteOutcome::Deleted)
        && matches!(outcome, NamespaceDeleteOutcome::Deleted)
    {
        info!(name = %ns_name, "namespace deleted");
        NamespaceDeleteOutcome::Deleted
    } else {
        warn!(
            name = %ns_name,
            host_device,
            "namespace cleanup did not complete cleanly; startup orphan reconciliation will retry"
        );
        NamespaceDeleteOutcome::Abandoned
    }
}

/// Delete the host veth and netns only; callers handle host iptables separately.
async fn delete_namespace_link_and_netns(
    ns_name: &str,
    host_device: &str,
) -> NamespaceDeleteOutcome {
    let del_link_args = ["link", "del", host_device];
    let del_ns_args = ["netns", "del", ns_name];
    let (link, netns) = tokio::join!(
        exec_ignore_errors_with_timeout("ip", &del_link_args, NETNS_COMMAND_TIMEOUT),
        exec_ignore_errors_with_timeout("ip", &del_ns_args, NETNS_COMMAND_TIMEOUT),
    );
    NamespaceDeleteOutcome::from_best_effort([link, netns])
}

/// Flush conntrack entries for a given IP address.
///
/// Peer IPs are reused across VM attachments and runner lifecycles. Without
/// flushing, stale conntrack entries from a previous owner can cause the
/// stateful iptables rule (`-m state --state RELATED,ESTABLISHED`) or a NAT
/// redirect to misroute or silently drop packets for the next owner.
async fn flush_conntrack(peer_ip: &str) -> ConntrackFlushOutcome {
    let src_args = ["-D", "-s", peer_ip];
    let dst_args = ["-D", "-d", peer_ip];
    let (src, dst) = tokio::join!(
        exec_ignore_errors_with_timeout("conntrack", &src_args, NETNS_COMMAND_TIMEOUT),
        exec_ignore_errors_with_timeout("conntrack", &dst_args, NETNS_COMMAND_TIMEOUT),
    );
    if conntrack_flush_is_trusted(src, dst) {
        if conntrack_command_missing(src, dst)
            && !CONNTRACK_NOT_FOUND_LOGGED.swap(true, Ordering::Relaxed)
        {
            warn!(
                peer_ip,
                "conntrack command not found; proceeding without conntrack reset"
            );
        }
        ConntrackFlushOutcome::Trusted
    } else {
        warn!(
            peer_ip,
            src = ?src,
            dst = ?dst,
            "conntrack reset failed or timed out; peer network state is untrusted"
        );
        ConntrackFlushOutcome::Untrusted
    }
}

fn conntrack_flush_is_trusted(src: IgnoredCommandOutcome, dst: IgnoredCommandOutcome) -> bool {
    (src.completed_without_timeout() && dst.completed_without_timeout())
        || conntrack_command_missing(src, dst)
}

fn conntrack_command_missing(src: IgnoredCommandOutcome, dst: IgnoredCommandOutcome) -> bool {
    matches!(
        (src, dst),
        (
            IgnoredCommandOutcome::NotFound,
            IgnoredCommandOutcome::NotFound
        )
    )
}

// ---------------------------------------------------------------------------
// Pool index lock
// ---------------------------------------------------------------------------

/// Try to acquire an exclusive flock on a pool index file (0..MAX_POOLS).
///
/// Returns the first successfully locked `(index, Flock<File>)`. The lock is
/// held for the lifetime of the returned `Flock` — when the process exits or
/// the `Flock` is dropped, the OS releases the lock automatically.
pub(super) fn acquire_pool_lock(locks: &LockPaths) -> Result<(u32, Flock<File>)> {
    for index in 0..MAX_POOLS {
        let path = locks.netns_pool(index);
        // Open for writing without O_CREAT first, fall back to create.
        // This avoids EACCES from fs.protected_regular=2 on sticky-bit
        // directories (/var/lock) when the file is owned by another user.
        let file = match File::options().write(true).open(&path).or_else(|_| {
            File::options()
                .write(true)
                .create(true)
                .truncate(false)
                .open(&path)
        }) {
            Ok(f) => f,
            Err(e) => {
                // Skip indices whose lock file is inaccessible (e.g. owned by
                // another user under fs.protected_regular=2).
                warn!(index, %e, "cannot open pool lock, skipping index");
                continue;
            }
        };
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => {
                info!(index, "acquired pool index lock");
                return Ok((index, lock));
            }
            Err((_, errno)) => {
                if errno != nix::errno::Errno::EWOULDBLOCK {
                    warn!(index, %errno, "unexpected flock error, skipping index");
                }
                continue;
            }
        }
    }

    Err(NetworkError::NoPoolIndexAvailable)
}

// ---------------------------------------------------------------------------
// Namespace creation
// ---------------------------------------------------------------------------

/// Create a single namespace with full connectivity, optionally adding a proxy
/// REDIRECT rule for outbound TCP traffic.
///
/// When DNS proxying is enabled, the general proxy redirect excludes TCP 53
/// and 853: TCP 53 is redirected to the DNS proxy, while TCP 853 is blocked.
///
/// This is a free function (no `&self`) so it can be spawned on a `JoinSet`.
pub(super) async fn create_single_namespace(
    pool_index: u32,
    ns_index: u32,
    default_iface: String,
    proxy_port: Option<u16>,
    dns_port: Option<u16>,
) -> Result<NetnsInfo> {
    if ns_index >= MAX_NAMESPACES {
        return Err(NetworkError::NamespaceLimitReached {
            max: MAX_NAMESPACES,
        });
    }

    let pool_idx_str = format_hex_index(pool_index);
    let ns_idx_str = format_hex_index(ns_index);
    let ns_name = make_ns_name(&pool_idx_str, &ns_idx_str);
    let host_device = make_host_device(&pool_idx_str, &ns_idx_str);
    let (host_ip, peer_ip) = generate_veth_ip_pair(pool_index, ns_index);

    info!(name = %ns_name, proxy = proxy_port.is_some(), "creating namespace");

    let sn = &GUEST_NETWORK;
    let result = create_namespace_inner(
        &ns_name,
        &host_device,
        &host_ip,
        &peer_ip,
        sn,
        &default_iface,
    )
    .await;

    match result {
        Ok(()) => {
            if let Some(port) = proxy_port {
                if let Err(e) = add_proxy_redirect_rule(
                    &ns_name,
                    &host_device,
                    &peer_ip,
                    port,
                    dns_port.is_some(),
                )
                .await
                {
                    error!(name = %ns_name, error = %e, "failed to add proxy rules, cleaning up");
                    delete_namespace_resources(&ns_name, &host_device).await;
                    return Err(e);
                }
                if let Err(e) = add_non_tcp_log_rule(&ns_name, &host_device, &peer_ip).await {
                    error!(name = %ns_name, error = %e, "failed to add non-TCP log rule, cleaning up");
                    delete_namespace_resources(&ns_name, &host_device).await;
                    return Err(e);
                }
            }
            if let Some(port) = dns_port {
                if let Err(e) = add_dns_redirect_rules(&ns_name, &host_device, &peer_ip, port).await
                {
                    error!(name = %ns_name, error = %e, "failed to add DNS redirect rules, cleaning up");
                    delete_namespace_resources(&ns_name, &host_device).await;
                    return Err(e);
                }
                if let Err(e) = add_dns_drop_rules(&ns_name, &host_device, &peer_ip).await {
                    error!(name = %ns_name, error = %e, "failed to add DNS drop rules, cleaning up");
                    delete_namespace_resources(&ns_name, &host_device).await;
                    return Err(e);
                }
            }
            info!(name = %ns_name, "namespace created");
            Ok(NetnsInfo::new(ns_name, host_device, peer_ip))
        }
        Err(e) => {
            error!(name = %ns_name, error = %e, "failed to create namespace, cleaning up");
            delete_namespace_resources(&ns_name, &host_device).await;
            Err(e)
        }
    }
}

/// Inner namespace creation — orchestrates TAP, veth, routing, and iptables setup.
async fn create_namespace_inner(
    name: &str,
    host_device: &str,
    host_ip: &str,
    peer_ip: &str,
    sn: &GuestNetwork,
    default_iface: &str,
) -> Result<()> {
    let gw_with_prefix = format!("{}/{}", sn.gateway_ip, sn.prefix_len);
    create_netns_with_tap(name, sn.tap_name, sn.tap_mac, &gw_with_prefix).await?;
    setup_veth_pair(name, host_device, host_ip, peer_ip).await?;
    setup_namespace_routing(name, host_ip, sn.gateway_ip, sn.prefix_len).await?;
    setup_host_iptables(name, host_device, peer_ip, default_iface).await?;

    Ok(())
}

#[derive(Debug)]
enum SnapshotSource<T> {
    Captured(T),
    Abandoned,
}

#[derive(Debug)]
struct FirewallTableSnapshot {
    command: &'static str,
    table: &'static str,
    rules_by_pool: SnapshotSource<BTreeMap<u32, Vec<String>>>,
}

#[derive(Debug)]
struct CapturedNamespace {
    name: String,
    host_device: String,
}

#[derive(Debug)]
struct ReconciliationSnapshot {
    ipv4_raw: FirewallTableSnapshot,
    ipv4_nat: FirewallTableSnapshot,
    ipv4_filter: FirewallTableSnapshot,
    ipv6_filter: FirewallTableSnapshot,
    namespaces_by_pool: SnapshotSource<BTreeMap<u32, Vec<CapturedNamespace>>>,
}

impl ReconciliationSnapshot {
    async fn capture() -> Self {
        let (ipv4_raw, ipv4_nat, ipv4_filter, ipv6_filter, namespaces) = tokio::join!(
            capture_firewall_table("iptables", "iptables-save", "raw"),
            capture_firewall_table("iptables", "iptables-save", "nat"),
            capture_firewall_table("iptables", "iptables-save", "filter"),
            capture_firewall_table("ip6tables", "ip6tables-save", "filter"),
            capture_namespaces(),
        );
        Self {
            ipv4_raw,
            ipv4_nat,
            ipv4_filter,
            ipv6_filter,
            namespaces_by_pool: namespaces,
        }
    }

    fn candidate_pool_indexes(&self, own_index: u32) -> BTreeSet<u32> {
        let mut indexes = BTreeSet::from([own_index]);
        for table in [
            &self.ipv4_raw,
            &self.ipv4_nat,
            &self.ipv4_filter,
            &self.ipv6_filter,
        ] {
            if let SnapshotSource::Captured(rules_by_pool) = &table.rules_by_pool {
                indexes.extend(rules_by_pool.keys().copied());
            }
        }
        if let SnapshotSource::Captured(namespaces_by_pool) = &self.namespaces_by_pool {
            indexes.extend(namespaces_by_pool.keys().copied());
        }
        indexes
    }
}

async fn capture_firewall_table(
    command: &'static str,
    save_command: &'static str,
    table: &'static str,
) -> FirewallTableSnapshot {
    let rules_by_pool = match exec_with_timeout(save_command, &["-t", table], NETNS_COMMAND_TIMEOUT)
        .await
    {
        Ok(output) => {
            let mut rules_by_pool: BTreeMap<u32, Vec<String>> = BTreeMap::new();
            for line in output.lines() {
                if let Some(pool_index) = firewall_rule_pool_index(line) {
                    rules_by_pool
                        .entry(pool_index)
                        .or_default()
                        .push(line.to_string());
                }
            }
            SnapshotSource::Captured(rules_by_pool)
        }
        Err(error) => {
            warn!(save_command, table, %error, "failed to capture firewall rules for startup reconciliation");
            SnapshotSource::Abandoned
        }
    };
    FirewallTableSnapshot {
        command,
        table,
        rules_by_pool,
    }
}

fn firewall_rule_pool_index(line: &str) -> Option<u32> {
    if !line.starts_with("-A ") {
        return None;
    }

    let mut tokens = line.split_whitespace();
    while let Some(token) = tokens.next() {
        if token == "--comment" {
            return tokens
                .next()
                .map(|comment| comment.trim_matches('"'))
                .and_then(pool_index_from_comment);
        }
    }
    None
}

fn pool_index_from_comment(comment: &str) -> Option<u32> {
    if let Some(parsed) = parse_netns_name(comment) {
        return Some(parsed.pool_index);
    }

    let suffix = comment.strip_prefix(NS_PREFIX)?;
    let pool_hex = suffix.strip_suffix("-dns")?;
    let pool_index = u32::from_str_radix(pool_hex, 16).ok()?;
    (pool_index < MAX_POOLS && format_hex_index(pool_index) == pool_hex).then_some(pool_index)
}

async fn capture_namespaces() -> SnapshotSource<BTreeMap<u32, Vec<CapturedNamespace>>> {
    let output = match exec_with_timeout("ip", &["netns", "list"], NETNS_COMMAND_TIMEOUT).await {
        Ok(output) => output,
        Err(error) => {
            error!(%error, "failed to capture namespaces for startup reconciliation");
            return SnapshotSource::Abandoned;
        }
    };

    let mut namespaces_by_pool: BTreeMap<u32, Vec<CapturedNamespace>> = BTreeMap::new();
    for name in output
        .lines()
        .filter_map(|line| line.split_whitespace().next())
    {
        let Some(parsed) = parse_netns_name(name) else {
            continue;
        };
        let pool_idx = format_hex_index(parsed.pool_index);
        let ns_idx = format_hex_index(parsed.namespace_index);
        namespaces_by_pool
            .entry(parsed.pool_index)
            .or_default()
            .push(CapturedNamespace {
                name: name.to_string(),
                host_device: make_host_device(&pool_idx, &ns_idx),
            });
    }
    SnapshotSource::Captured(namespaces_by_pool)
}

async fn delete_firewall_rules_from_snapshot(
    snapshot: &FirewallTableSnapshot,
    pool_index: u32,
) -> NamespaceDeleteOutcome {
    let SnapshotSource::Captured(rules_by_pool) = &snapshot.rules_by_pool else {
        return NamespaceDeleteOutcome::Abandoned;
    };
    let Some(rules) = rules_by_pool.get(&pool_index) else {
        return NamespaceDeleteOutcome::Deleted;
    };

    delete_firewall_rule_lines(
        snapshot.command,
        snapshot.table,
        rules.iter().map(String::as_str),
    )
    .await
}

async fn delete_pool_firewall_rules_from_snapshot(
    snapshot: &ReconciliationSnapshot,
    pool_index: u32,
) -> NamespaceDeleteOutcome {
    let (raw, nat, filter, ipv6_filter) = tokio::join!(
        delete_firewall_rules_from_snapshot(&snapshot.ipv4_raw, pool_index),
        delete_firewall_rules_from_snapshot(&snapshot.ipv4_nat, pool_index),
        delete_firewall_rules_from_snapshot(&snapshot.ipv4_filter, pool_index),
        delete_firewall_rules_from_snapshot(&snapshot.ipv6_filter, pool_index),
    );
    if [raw, nat, filter, ipv6_filter]
        .into_iter()
        .all(|outcome| matches!(outcome, NamespaceDeleteOutcome::Deleted))
    {
        NamespaceDeleteOutcome::Deleted
    } else {
        NamespaceDeleteOutcome::Abandoned
    }
}

/// Clean up all captured resources matching a given pool index.
///
/// Deletes orphaned host firewall rules first, then deletes captured
/// namespaces and their veth devices. If snapshot-backed firewall cleanup is
/// abandoned, each namespace retains the existing fresh-discovery fallback.
async fn cleanup_namespaces_from_snapshot(
    snapshot: &ReconciliationSnapshot,
    index: u32,
) -> NamespaceDeleteOutcome {
    let firewall = delete_pool_firewall_rules_from_snapshot(snapshot, index).await;
    let SnapshotSource::Captured(namespaces_by_pool) = &snapshot.namespaces_by_pool else {
        return NamespaceDeleteOutcome::Abandoned;
    };
    let Some(namespaces) = namespaces_by_pool.get(&index) else {
        return firewall;
    };

    let idx_str = format_hex_index(index);
    info!(count = namespaces.len(), index = %idx_str, "cleaning up orphaned namespaces");
    let mut set = tokio::task::JoinSet::new();
    for namespace in namespaces {
        let ns_name = namespace.name.clone();
        let host_device = namespace.host_device.clone();
        set.spawn(async move {
            match firewall {
                NamespaceDeleteOutcome::Deleted => {
                    info!(name = %ns_name, "deleting namespace");
                    let outcome = delete_namespace_link_and_netns(&ns_name, &host_device).await;
                    if matches!(outcome, NamespaceDeleteOutcome::Deleted) {
                        info!(name = %ns_name, "namespace deleted");
                    } else {
                        warn!(
                            name = %ns_name,
                            host_device,
                            "namespace cleanup did not complete cleanly; startup orphan reconciliation will retry"
                        );
                    }
                    outcome
                }
                NamespaceDeleteOutcome::Abandoned => {
                    delete_namespace_resources(&ns_name, &host_device).await
                }
            }
        });
    }

    let mut outcome = firewall;
    while let Some(result) = set.join_next().await {
        if !matches!(result, Ok(NamespaceDeleteOutcome::Deleted)) {
            outcome = NamespaceDeleteOutcome::Abandoned;
        }
    }
    outcome
}

/// Clean orphans from `own_index` and captured pool indexes with no active
/// owner.
///
/// `NetnsPool::cleanup` is best-effort — SIGKILL, panic, OOM, power loss,
/// and aborted in-flight creation tasks can all leave kernel resources
/// alive after a runner exits. This function is the correctness guarantee for
/// `own_index`: every startup captures host resources once and cleans the
/// acquired index before reuse. Captured resources under other indexes are
/// deleted only after their flock proves that they have no active owner.
///
/// `_own_lock` is a borrow witness — taking it proves the caller holds a
/// pool-index flock, which is the permission required to do kernel-side
/// cleanup on `own_index` without first re-flocking it.
pub(super) async fn reconcile_orphan_namespaces(
    locks: &LockPaths,
    own_index: u32,
    _own_lock: &Flock<File>,
) {
    let snapshot = ReconciliationSnapshot::capture().await;
    let candidate_indexes = snapshot.candidate_pool_indexes(own_index);
    let candidate_count = candidate_indexes.len();

    // Own index: critical-path cleanup. Warm-up immediately afterwards
    // starts at ns_index 0 and will collide with any surviving orphan.
    // Cleanup remains best-effort. If it is abandoned, the EEXIST that
    // warm-up's `ip netns add` produces is the diagnostic, chronologically
    // paired with the warning at the cleanup site. See #10826 for the full
    // analysis (closed as won't-fix).
    let own_outcome = cleanup_namespaces_from_snapshot(&snapshot, own_index).await;

    // Other captured indexes: advisory cleanup for arbitrary prior runners.
    // The snapshot only discovers candidates; a current flock remains the
    // authority to mutate resources for an index. A missed or failed cleanup
    // is retried when a future runner directly acquires that index.
    let mut reconciled = 1_usize;
    let mut skipped = 0_usize;
    let mut abandoned = usize::from(matches!(own_outcome, NamespaceDeleteOutcome::Abandoned));
    for index in candidate_indexes {
        if index == own_index {
            continue;
        }
        let Some(_guard) = try_claim_idle_pool_lock(locks, index) else {
            skipped += 1;
            continue;
        };
        info!(index, "reconciling orphaned namespaces from idle pool");
        let outcome = cleanup_namespaces_from_snapshot(&snapshot, index).await;
        reconciled += 1;
        abandoned += usize::from(matches!(outcome, NamespaceDeleteOutcome::Abandoned));
        // `_guard` drops here, releasing the lock before the next iteration
        // so a concurrently-starting runner can immediately claim the index.
    }
    info!(
        own_index,
        candidate_count,
        reconciled,
        skipped,
        abandoned,
        "startup namespace reconciliation complete"
    );
}

/// Try to acquire a non-blocking flock on an existing pool lock file.
///
/// Returns `None` when the file is missing (index never used, no orphans
/// possible) or when the lock is held by another runner (active owner,
/// off-limits). Returns `Some(guard)` otherwise; dropping the guard
/// releases the lock.
fn try_claim_idle_pool_lock(locks: &LockPaths, index: u32) -> Option<Flock<File>> {
    let path = locks.netns_pool(index);
    // Do NOT create the file — a missing lock file means this index was
    // never used, so there is nothing to reconcile.
    let file = File::options().write(true).open(&path).ok()?;
    Flock::lock(file, FlockArg::LockExclusiveNonblock).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn xtables_status_prepends_bare_wait() {
        exec_xtables_status_with_timeout("test", &["=", "--wait"], Duration::from_secs(1))
            .await
            .unwrap();
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn xtables_timeout_is_abandoned_by_cleanup() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let command = dir.path().join("wait-for-timeout");
        std::fs::write(
            &command,
            "#!/bin/sh\n[ \"$1\" = \"--wait\" ] || exit 2\nsleep 5\n",
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let outcome = exec_xtables_ignore_errors_with_timeout(
            command.to_str().unwrap(),
            &[],
            Duration::from_millis(50),
        )
        .await;

        assert_eq!(outcome, IgnoredCommandOutcome::Timeout);
        assert_eq!(
            NamespaceDeleteOutcome::from_best_effort([outcome]),
            NamespaceDeleteOutcome::Abandoned
        );
    }

    #[test]
    fn conntrack_flush_trusts_completed_deletes() {
        assert!(conntrack_flush_is_trusted(
            IgnoredCommandOutcome::Success,
            IgnoredCommandOutcome::NonZero
        ));
    }

    #[test]
    fn conntrack_flush_trusts_missing_optional_command() {
        assert!(conntrack_flush_is_trusted(
            IgnoredCommandOutcome::NotFound,
            IgnoredCommandOutcome::NotFound
        ));
    }

    #[test]
    fn conntrack_flush_does_not_trust_timeout_or_partial_missing_command() {
        assert!(!conntrack_flush_is_trusted(
            IgnoredCommandOutcome::Timeout,
            IgnoredCommandOutcome::Success
        ));
        assert!(!conntrack_flush_is_trusted(
            IgnoredCommandOutcome::NotFound,
            IgnoredCommandOutcome::Success
        ));
    }

    #[test]
    fn conntrack_flush_does_not_trust_uncertain_command_failures() {
        for outcome in [
            IgnoredCommandOutcome::SpawnError,
            IgnoredCommandOutcome::WaitError,
            IgnoredCommandOutcome::PipeError,
            IgnoredCommandOutcome::OutputTooLarge,
        ] {
            assert!(
                !conntrack_flush_is_trusted(outcome, IgnoredCommandOutcome::Success),
                "trusted left-side outcome: {outcome:?}"
            );
            assert!(
                !conntrack_flush_is_trusted(IgnoredCommandOutcome::Success, outcome),
                "trusted right-side outcome: {outcome:?}"
            );
        }
    }

    #[test]
    fn acquire_pool_lock_returns_first_available() {
        let dir = tempfile::tempdir().unwrap();
        let locks = LockPaths::with_dir(dir.path().to_path_buf());

        let (index, _lock) = acquire_pool_lock(&locks).unwrap();
        assert_eq!(index, 0);
    }

    #[test]
    fn acquire_pool_lock_skips_held_indices() {
        let dir = tempfile::tempdir().unwrap();
        let locks = LockPaths::with_dir(dir.path().to_path_buf());

        let (i0, _hold0) = acquire_pool_lock(&locks).unwrap();
        let (i1, _hold1) = acquire_pool_lock(&locks).unwrap();
        let (i2, _hold2) = acquire_pool_lock(&locks).unwrap();

        assert_eq!(i0, 0);
        assert_eq!(i1, 1);
        assert_eq!(i2, 2);
    }

    #[test]
    fn acquire_pool_lock_reuses_released_index() {
        let dir = tempfile::tempdir().unwrap();
        let locks = LockPaths::with_dir(dir.path().to_path_buf());

        let (i0, hold0) = acquire_pool_lock(&locks).unwrap();
        let (i1, _hold1) = acquire_pool_lock(&locks).unwrap();
        assert_eq!(i0, 0);
        assert_eq!(i1, 1);

        // Drop lock 0 → index 0 becomes available again.
        drop(hold0);

        let (reused, _hold) = acquire_pool_lock(&locks).unwrap();
        assert_eq!(reused, 0);
    }

    #[test]
    fn try_claim_idle_pool_lock_returns_none_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let locks = LockPaths::with_dir(dir.path().to_path_buf());
        // No lock file has ever been created for index 0.
        assert!(try_claim_idle_pool_lock(&locks, 0).is_none());
    }

    #[test]
    fn try_claim_idle_pool_lock_returns_none_when_held() {
        let dir = tempfile::tempdir().unwrap();
        let locks = LockPaths::with_dir(dir.path().to_path_buf());

        let (idx, _held) = acquire_pool_lock(&locks).unwrap();
        assert!(try_claim_idle_pool_lock(&locks, idx).is_none());
    }

    #[test]
    fn try_claim_idle_pool_lock_returns_some_when_idle() {
        let dir = tempfile::tempdir().unwrap();
        let locks = LockPaths::with_dir(dir.path().to_path_buf());

        // Create the lock file by acquiring then releasing — simulates a
        // prior runner that exited.
        let (idx, held) = acquire_pool_lock(&locks).unwrap();
        drop(held);

        let claimed = try_claim_idle_pool_lock(&locks, idx);
        assert!(claimed.is_some());
    }

    #[test]
    fn acquire_pool_lock_exhausted() {
        let dir = tempfile::tempdir().unwrap();
        let locks = LockPaths::with_dir(dir.path().to_path_buf());

        // Hold all 64 slots.
        let _locks: Vec<_> = (0..MAX_POOLS)
            .map(|_| acquire_pool_lock(&locks).unwrap())
            .collect();

        let err = acquire_pool_lock(&locks).unwrap_err();
        assert!(
            matches!(err, NetworkError::NoPoolIndexAvailable),
            "expected NoPoolIndexAvailable, got: {err}"
        );
    }
}
