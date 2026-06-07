use std::fs::File;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use nix::fcntl::{Flock, FlockArg};
use tracing::{error, info, warn};

use crate::command::{IgnoredCommandOutcome, exec_ignore_errors_with_timeout, exec_with_timeout};
use crate::paths::LockPaths;

use super::super::error::{NetworkError, Result};
use super::super::{GUEST_NETWORK, GuestNetwork};
use super::naming::{
    MAX_NAMESPACES, MAX_POOLS, NS_PREFIX, format_hex_index, generate_veth_ip_pair,
    make_host_device, make_ns_name, parse_netns_name,
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
    exec_with_timeout("ip", args, NETNS_COMMAND_TIMEOUT).await?;
    Ok(())
}

/// Shorthand: run `iptables <args>`, discard stdout.
async fn exec_iptables(args: &[&str]) -> Result<()> {
    exec_with_timeout("iptables", args, NETNS_COMMAND_TIMEOUT).await?;
    Ok(())
}

pub(super) async fn enable_host_ip_forwarding() -> Result<()> {
    exec_with_timeout(
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
    exec_ip(&[
        "netns",
        "exec",
        name,
        "iptables",
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
    ])
    .await?;
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

/// Add host-side iptables rules for forwarding (connectivity only, no proxy).
async fn setup_host_iptables(
    name: &str,
    host_device: &str,
    peer_ip: &str,
    default_iface: &str,
) -> Result<()> {
    let src = format!("{peer_ip}/30");
    exec_iptables(&[
        "-t",
        "nat",
        "-A",
        "POSTROUTING",
        "-s",
        &src,
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

/// Add proxy REDIRECT rule for all outbound TCP traffic in PREROUTING chain.
///
/// This rule redirects all outbound TCP traffic from the namespace's
/// veth peer IP to the specified proxy port on the host. mitmproxy in
/// transparent mode handles both HTTP/HTTPS and non-HTTP (raw TCP passthrough).
async fn add_proxy_redirect_rule(name: &str, peer_ip: &str, proxy_port: u16) -> Result<()> {
    let src = format!("{peer_ip}/30");
    let port_str = proxy_port.to_string();
    exec_iptables(&[
        "-t",
        "nat",
        "-A",
        "PREROUTING",
        "-s",
        &src,
        "-p",
        "tcp",
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
async fn add_non_tcp_log_rule(name: &str, peer_ip: &str) -> Result<()> {
    let src = format!("{peer_ip}/30");
    let prefix = format!("VM0:{peer_ip}:");
    exec_iptables(&[
        "-I",
        "FORWARD",
        "1",
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

/// Redirect all outbound DNS (UDP 53) to the local dnsmasq port.
///
/// VM resolv.conf points to an external nameserver as a dummy target.
/// This PREROUTING REDIRECT intercepts the packet before FORWARD/MASQUERADE,
/// preserving the original source IP (peer veth) for per-VM log routing.
async fn add_dns_redirect_rule(name: &str, peer_ip: &str, dns_port: u16) -> Result<()> {
    let src = format!("{peer_ip}/30");
    let port_str = dns_port.to_string();
    exec_iptables(&[
        "-t",
        "nat",
        "-A",
        "PREROUTING",
        "-s",
        &src,
        "-p",
        "udp",
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
    Ok(())
}

/// Drop external DNS traffic that bypasses the REDIRECT rule.
///
/// Blocks UDP 53 and TCP 853 (DNS over TLS) in FORWARD chain.
/// DNS over HTTPS (TCP 443) is handled by mitmproxy at HTTP level.
async fn add_dns_drop_rules(name: &str, peer_ip: &str) -> Result<()> {
    let src = format!("{peer_ip}/30");
    // Block UDP 53 in FORWARD (catches any traffic not caught by PREROUTING REDIRECT)
    exec_iptables(&[
        "-I",
        "FORWARD",
        "1",
        "-s",
        &src,
        "-p",
        "udp",
        "--dport",
        "53",
        "-j",
        "DROP",
        "-m",
        "comment",
        "--comment",
        name,
    ])
    .await?;
    // Block DNS over TLS (TCP 853)
    exec_iptables(&[
        "-I",
        "FORWARD",
        "1",
        "-s",
        &src,
        "-p",
        "tcp",
        "--dport",
        "853",
        "-j",
        "DROP",
        "-m",
        "comment",
        "--comment",
        name,
    ])
    .await?;
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

/// Delete iptables rules that contain `comment` in nat and filter tables.
async fn delete_iptables_rules_by_comment(comment: &str) -> NamespaceDeleteOutcome {
    let (nat, filter) = tokio::join!(
        delete_iptables_from_table("nat", comment),
        delete_iptables_from_table("filter", comment),
    );
    if matches!(nat, NamespaceDeleteOutcome::Deleted)
        && matches!(filter, NamespaceDeleteOutcome::Deleted)
    {
        NamespaceDeleteOutcome::Deleted
    } else {
        NamespaceDeleteOutcome::Abandoned
    }
}

async fn delete_iptables_from_table(table: &str, comment: &str) -> NamespaceDeleteOutcome {
    let output =
        match exec_with_timeout("iptables-save", &["-t", table], NETNS_COMMAND_TIMEOUT).await {
            Ok(output) => output,
            Err(e) => {
                warn!(table, error = %e, "failed to read iptables rules, skipping cleanup");
                return NamespaceDeleteOutcome::Abandoned;
            }
        };
    // Sequential: xtables lock serializes writes to the same table anyway.
    // Note: split_whitespace + trim_matches('"') is safe because namespace
    // comment values (e.g. "vm0-ns-00-0a") never contain spaces. If they
    // did, iptables-save would quote them as `--comment "foo bar"` and the
    // split would incorrectly break the value into separate arguments.
    let mut outcomes = Vec::new();
    for line in output
        .lines()
        .filter(|line| line.starts_with("-A ") && line.contains(comment))
    {
        let rule = line.replacen("-A ", "-D ", 1);
        let mut args: Vec<&str> = vec!["-t", table];
        args.extend(rule.split_whitespace().map(|t| t.trim_matches('"')));
        outcomes
            .push(exec_ignore_errors_with_timeout("iptables", &args, NETNS_COMMAND_TIMEOUT).await);
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
/// Namespaces are reused between VMs with the same peer IP. Without
/// flushing, stale conntrack entries from a previous VM can cause the
/// stateful iptables rule (`-m state --state RELATED,ESTABLISHED`) to
/// misroute or silently drop return packets for a new VM.
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
                "conntrack command not found; reusing namespace without conntrack flush"
            );
        }
        ConntrackFlushOutcome::Trusted
    } else {
        warn!(
            peer_ip,
            src = ?src,
            dst = ?dst,
            "conntrack flush failed or timed out; namespace will not be reused"
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

/// Create a single namespace with full connectivity, optionally adding proxy
/// REDIRECT rules for HTTP/HTTPS traffic.
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
                if let Err(e) = add_proxy_redirect_rule(&ns_name, &peer_ip, port).await {
                    error!(name = %ns_name, error = %e, "failed to add proxy rules, cleaning up");
                    delete_namespace_resources(&ns_name, &host_device).await;
                    return Err(e);
                }
                if let Err(e) = add_non_tcp_log_rule(&ns_name, &peer_ip).await {
                    error!(name = %ns_name, error = %e, "failed to add non-TCP log rule, cleaning up");
                    delete_namespace_resources(&ns_name, &host_device).await;
                    return Err(e);
                }
            }
            if let Some(port) = dns_port {
                if let Err(e) = add_dns_redirect_rule(&ns_name, &peer_ip, port).await {
                    error!(name = %ns_name, error = %e, "failed to add DNS redirect rule, cleaning up");
                    delete_namespace_resources(&ns_name, &host_device).await;
                    return Err(e);
                }
                if let Err(e) = add_dns_drop_rules(&ns_name, &peer_ip).await {
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

/// Clean up all resources matching a given pool index.
///
/// Deletes orphaned host iptables rules first, then discovers and deletes
/// remaining namespaces and their veth devices. If the pool-wide iptables
/// cleanup is abandoned, each namespace falls back to full cleanup.
async fn cleanup_namespaces_by_index(index: u32) {
    let idx_str = format_hex_index(index);
    let prefix = format!("{NS_PREFIX}{idx_str}-");

    // 1. Clean orphaned host iptables rules whose comment matches this pool index.
    //    The Rust-side `contains()` does substring matching, so the prefix matches
    //    all namespaces in this pool. This catches rules left behind even if the
    //    namespace itself was already deleted.
    let iptables = delete_iptables_rules_by_comment(&prefix).await;

    // 2. Discover and delete any remaining namespaces (+ their veth devices).
    let Ok(output) = exec_with_timeout("ip", &["netns", "list"], NETNS_COMMAND_TIMEOUT).await
    else {
        error!(index, "failed to list namespaces for cleanup");
        return;
    };
    let ns_names: Vec<String> = output
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .filter(|name| name.starts_with(&prefix))
        .map(String::from)
        .collect();

    if ns_names.is_empty() {
        return;
    }

    info!(count = ns_names.len(), index = %idx_str, "cleaning up orphaned namespaces");
    let mut set = tokio::task::JoinSet::new();
    for ns_name in ns_names {
        set.spawn(async move {
            if let Some(parsed) = parse_netns_name(&ns_name) {
                let pool_idx = format_hex_index(parsed.pool_index);
                let ns_idx = format_hex_index(parsed.namespace_index);
                let host_device = make_host_device(&pool_idx, &ns_idx);
                match iptables {
                    NamespaceDeleteOutcome::Deleted => {
                        info!(name = %ns_name, "deleting namespace");
                        let outcome =
                            delete_namespace_link_and_netns(&ns_name, &host_device).await;
                        if matches!(outcome, NamespaceDeleteOutcome::Deleted) {
                            info!(name = %ns_name, "namespace deleted");
                        } else {
                            warn!(
                                name = %ns_name,
                                host_device,
                                "namespace cleanup did not complete cleanly; startup orphan reconciliation will retry"
                            );
                        }
                    }
                    NamespaceDeleteOutcome::Abandoned => {
                        delete_namespace_resources(&ns_name, &host_device).await;
                    }
                }
            }
        });
    }
    while set.join_next().await.is_some() {}
}

/// Clean orphans from `own_index` and every other pool index that currently
/// has no active owner.
///
/// `NetnsPool::cleanup` is best-effort — SIGKILL, panic, OOM, power loss,
/// and aborted in-flight creation tasks can all leave kernel resources
/// alive after a runner exits. This function is the correctness guarantee:
/// on every startup, the flock is used as a liveness probe to identify
/// pool indexes with no owner, and any namespaces under those indexes are
/// treated as orphans and deleted.
///
/// `_own_lock` is a borrow witness — taking it proves the caller holds a
/// pool-index flock, which is the permission required to do kernel-side
/// cleanup on `own_index` without first re-flocking it.
pub(super) async fn reconcile_orphan_namespaces(
    locks: &LockPaths,
    own_index: u32,
    _own_lock: &Flock<File>,
) {
    // Own index: critical-path cleanup. Warm-up immediately afterwards
    // starts at ns_index 0 and will collide with any surviving orphan.
    // `cleanup_namespaces_by_index` swallows failures by design — its
    // only fallible step (`ip netns list`) is near-infallible on a
    // working runner, and the inner deletes go through
    // best-effort command helpers so a per-namespace `Result` would carry no
    // signal. If reconcile silently fails here, the EEXIST that
    // warm-up's `ip netns add` produces is the diagnostic — chronologically
    // paired with the `error!` at the cleanup site. See #10826 for the
    // full analysis (closed as won't-fix).
    cleanup_namespaces_by_index(own_index).await;

    // Other indexes: advisory cleanup for arbitrary prior runners. Failures
    // are not our problem — the next runner that claims the index will
    // retry. The `if index == own_index` check is defensive; the flock
    // would also deny us (Linux flock is per-OFD but same-process locks
    // on the same file still conflict), so dropping the check would only
    // waste two syscalls per call.
    for index in 0..MAX_POOLS {
        if index == own_index {
            continue;
        }
        let Some(_guard) = try_claim_idle_pool_lock(locks, index) else {
            continue;
        };
        info!(index, "reconciling orphaned namespaces from idle pool");
        cleanup_namespaces_by_index(index).await;
        // `_guard` drops here, releasing the lock before the next iteration
        // so a concurrently-starting runner can immediately claim the index.
    }
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
