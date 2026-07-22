use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::future::Future;
use std::io::Write;
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
    make_host_device, make_host_device_iptables_pattern, make_ns_name,
    make_pool_dns_filter_comment, parse_netns_name,
};
use super::types::NetnsInfo;

const NETNS_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
static CONNTRACK_NOT_FOUND_LOGGED: AtomicBool = AtomicBool::new(false);

/// Peer-side device name inside namespaces (fixed).
const PEER_DEVICE: &str = "veth0";

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
type DeleteNetworkResourcesFn =
    dyn Fn(Vec<NetnsInfo>, Option<String>) -> BoxFuture<NamespaceDeleteOutcome> + Send + Sync;

#[derive(Clone)]
pub(super) struct NetnsLifecycleOps {
    pub(super) flush_conntrack:
        Arc<dyn Fn(String) -> BoxFuture<ConntrackFlushOutcome> + Send + Sync>,
    pub(super) delete_network_resources: Arc<DeleteNetworkResourcesFn>,
}

impl Default for NetnsLifecycleOps {
    fn default() -> Self {
        Self {
            flush_conntrack: Arc::new(|peer_ip| {
                Box::pin(async move { flush_conntrack(&peer_ip).await })
            }),
            delete_network_resources: Arc::new(|namespaces, dns_input_filter_comment| {
                Box::pin(async move {
                    delete_network_resources(namespaces, dns_input_filter_comment).await
                })
            }),
        }
    }
}

impl NetnsLifecycleOps {
    pub(super) async fn delete_network_resources(
        &self,
        namespaces: Vec<NetnsInfo>,
        dns_input_filter_comment: Option<String>,
    ) -> NamespaceDeleteOutcome {
        (self.delete_network_resources)(namespaces, dns_input_filter_comment).await
    }
}

#[cfg(test)]
impl NetnsLifecycleOps {
    pub(super) fn trusted_for_test() -> Self {
        Self {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_network_resources: Arc::new(|_, _| {
                Box::pin(async { NamespaceDeleteOutcome::Deleted })
            }),
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

#[cfg(test)]
async fn exec_xtables_ignore_errors_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> IgnoredCommandOutcome {
    let args = xtables_args(args);
    exec_ignore_errors_with_timeout(program, &args, timeout).await
}

/// Observe and restrict the runner-managed DNS port by pool-facing interface.
///
/// dnsmasq's default socket mode avoids per-address listener churn by using
/// wildcard sockets. These INPUT rules preserve the old kernel-level listener
/// isolation: public, management, and other runners' interfaces see the port as
/// unreachable, while REDIRECT traffic arriving on this pool's veths increments
/// a counter-only rule and continues to dnsmasq under the later INPUT policy.
/// Both address families are covered because dnsmasq can create IPv4 and IPv6
/// wildcard sockets.
pub(super) async fn setup_dns_input_filter(pool_index: u32, dns_port: u16) -> Result<String> {
    let pool_idx = format_hex_index(pool_index);
    let interface = make_host_device_iptables_pattern(&pool_idx);
    let comment = make_pool_dns_filter_comment(pool_index);
    let firewall = vec![FirewallRestoreTable {
        table: "filter",
        rules: ["udp", "tcp"]
            .into_iter()
            .flat_map(|protocol| {
                [
                    format!(
                        "-I INPUT 1 -i {interface} -p {protocol} --dport {dns_port} -m comment --comment {comment}"
                    ),
                    format!(
                        "-I INPUT 1 ! -i {interface} -p {protocol} --dport {dns_port} -m comment --comment {comment} -j REJECT"
                    ),
                ]
            })
            .collect(),
    }];
    let (ipv4, ipv6) = tokio::join!(
        apply_firewall_rules_with_restore("iptables-restore", &firewall),
        apply_firewall_rules_with_restore("ip6tables-restore", &firewall),
    );
    if let Err(error) = ipv4.and(ipv6) {
        if matches!(
            delete_pool_firewall_rules_by_comment(&comment).await,
            NamespaceDeleteOutcome::Abandoned
        ) {
            warn!(
                comment,
                "failed to roll back partial DNS input filter; startup orphan reconciliation will retry"
            );
        }
        return Err(error);
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

/// Build the complete host firewall transaction for one namespace.
#[derive(Clone, Copy)]
struct NamespaceFirewallConfig<'a> {
    default_iface: &'a str,
    proxy_port: Option<u16>,
    dns_port: Option<u16>,
}

fn namespace_firewall_restore_tables(
    name: &str,
    host_device: &str,
    peer_ip: &str,
    config: NamespaceFirewallConfig<'_>,
) -> Vec<FirewallRestoreTable> {
    let NamespaceFirewallConfig {
        default_iface,
        proxy_port,
        dns_port,
    } = config;
    let peer = format!("{peer_ip}/32");

    // Reject forged source addresses before conntrack and NAT attribute them
    // to this namespace. This remains independent of host rp_filter settings.
    let raw = vec![format!(
        "-I PREROUTING 1 -i {host_device} ! -s {peer} -m comment --comment {name} -j DROP"
    )];

    // Establish the base outbound and return paths before inserting the
    // optional logging and DNS guards ahead of the terminating ACCEPT rules.
    let mut nat = vec![format!(
        "-A POSTROUTING -s {peer} -o {default_iface} -j MASQUERADE -m comment --comment {name}"
    )];
    let mut filter = vec![
        format!(
            "-A FORWARD -i {host_device} -s {peer} -o {default_iface} -j ACCEPT -m comment --comment {name}"
        ),
        format!(
            "-A FORWARD -i {default_iface} -o {host_device} -d {peer} -m state --state RELATED,ESTABLISHED -j ACCEPT -m comment --comment {name}"
        ),
    ];

    if let Some(port) = proxy_port {
        // The dedicated DNS rules own ports 53 and 853 when DNS proxying is
        // enabled; otherwise all outbound TCP keeps the proxy behavior.
        let dns_exclusions = if dns_port.is_some() {
            " -m multiport ! --dports 53,853"
        } else {
            ""
        };
        nat.push(format!(
            "-A PREROUTING -i {host_device} -s {peer} -p tcp{dns_exclusions} -j REDIRECT --to-port {port} -m comment --comment {name}"
        ));
        // LOG is non-terminating and must precede the ACCEPT rules.
        filter.push(format!(
            "-I FORWARD 1 -i {host_device} -s {peer} ! -p tcp -m limit --limit 10/sec --limit-burst 50 -j LOG --log-prefix VM0:{peer_ip}: --log-level 4 -m comment --comment {name}"
        ));
    }

    if let Some(port) = dns_port {
        // Redirect standard DNS to dnsmasq, then block attempts to bypass it
        // over external DNS and DNS-over-TLS forwarding paths.
        for protocol in ["udp", "tcp"] {
            nat.push(format!(
                "-A PREROUTING -i {host_device} -s {peer} -p {protocol} --dport 53 -j REDIRECT --to-port {port} -m comment --comment {name}"
            ));
        }
        for (protocol, port) in [("udp", "53"), ("tcp", "53"), ("tcp", "853")] {
            filter.push(format!(
                "-I FORWARD 1 -i {host_device} -s {peer} -p {protocol} --dport {port} -j DROP -m comment --comment {name}"
            ));
        }
    }

    vec![
        FirewallRestoreTable {
            table: "raw",
            rules: raw,
        },
        FirewallRestoreTable {
            table: "nat",
            rules: nat,
        },
        FirewallRestoreTable {
            table: "filter",
            rules: filter,
        },
    ]
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

/// Delete IPv4 iptables rules with the exact `comment`.
async fn delete_iptables_rules_by_comment(comment: &str) -> NamespaceDeleteOutcome {
    Ipv4FirewallSnapshot::capture()
        .await
        .delete_rules_with_comments(&BTreeSet::from([comment.to_string()]))
        .await
}

/// Delete pool-scoped IPv4 and IPv6 firewall rules with the exact `comment`.
pub(super) async fn delete_pool_firewall_rules_by_comment(comment: &str) -> NamespaceDeleteOutcome {
    FirewallSnapshot::capture()
        .await
        .delete_rules_with_comments(&BTreeSet::from([comment.to_string()]))
        .await
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

/// Delete a known batch of namespace resources from one firewall snapshot.
///
/// Pool shutdown reaches this path with every currently queued namespace, so
/// reading each complete firewall table once avoids multiplying host-wide
/// discovery by the pool size. The optional DNS comment is captured and
/// deleted in the same pass once no namespace creation remains pending.
async fn delete_network_resources(
    namespaces: Vec<NetnsInfo>,
    dns_input_filter_comment: Option<String>,
) -> NamespaceDeleteOutcome {
    if namespaces.is_empty() && dns_input_filter_comment.is_none() {
        return NamespaceDeleteOutcome::Deleted;
    }

    let mut comments: BTreeSet<String> = namespaces
        .iter()
        .map(|namespace| namespace.name.clone())
        .collect();
    let includes_ipv6 = dns_input_filter_comment.is_some();
    if let Some(comment) = dns_input_filter_comment {
        comments.insert(comment);
    }

    let firewall = if includes_ipv6 {
        FirewallSnapshot::capture()
            .await
            .delete_rules_with_comments(&comments)
            .await
    } else {
        Ipv4FirewallSnapshot::capture()
            .await
            .delete_rules_with_comments(&comments)
            .await
    };

    let mut outcome = firewall;
    for namespace in namespaces {
        info!(name = %namespace.name, "deleting namespace");
        let namespace_outcome =
            delete_namespace_link_and_netns(&namespace.name, &namespace.host_device).await;
        if matches!(namespace_outcome, NamespaceDeleteOutcome::Deleted) {
            info!(name = %namespace.name, "namespace deleted");
        } else {
            warn!(
                name = %namespace.name,
                host_device = %namespace.host_device,
                "namespace cleanup did not complete cleanly; startup orphan reconciliation will retry"
            );
            outcome = NamespaceDeleteOutcome::Abandoned;
        }
    }
    outcome
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
        NamespaceFirewallConfig {
            default_iface: &default_iface,
            proxy_port,
            dns_port,
        },
    )
    .await;

    match result {
        Ok(()) => {
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
    firewall_config: NamespaceFirewallConfig<'_>,
) -> Result<()> {
    let gw_with_prefix = format!("{}/{}", sn.gateway_ip, sn.prefix_len);
    create_netns_with_tap(name, sn.tap_name, sn.tap_mac, &gw_with_prefix).await?;
    setup_veth_pair(name, host_device, host_ip, peer_ip).await?;
    setup_namespace_routing(name, host_ip, sn.gateway_ip, sn.prefix_len).await?;
    let firewall = namespace_firewall_restore_tables(name, host_device, peer_ip, firewall_config);
    apply_firewall_rules_with_restore("iptables-restore", &firewall).await?;

    Ok(())
}

#[derive(Debug)]
enum SnapshotSource<T> {
    Captured(T),
    Abandoned,
}

#[derive(Debug)]
struct FirewallTableSnapshot {
    table: &'static str,
    rules_by_pool: SnapshotSource<BTreeMap<u32, Vec<String>>>,
}

#[derive(Clone, Debug)]
struct FirewallRestoreTable {
    table: &'static str,
    rules: Vec<String>,
}

struct FirewallRestoreSelection {
    tables: Vec<FirewallRestoreTable>,
    sources_complete: bool,
}

#[derive(Clone, Copy)]
enum FirewallRestoreMode {
    Apply,
    Delete,
}

#[derive(Debug)]
struct Ipv4FirewallSnapshot {
    raw: FirewallTableSnapshot,
    nat: FirewallTableSnapshot,
    filter: FirewallTableSnapshot,
}

impl Ipv4FirewallSnapshot {
    async fn capture() -> Self {
        let (raw, nat, filter) = tokio::join!(
            capture_firewall_table("iptables-save", "raw"),
            capture_firewall_table("iptables-save", "nat"),
            capture_firewall_table("iptables-save", "filter"),
        );
        Self { raw, nat, filter }
    }

    fn extend_candidate_pool_indexes(&self, indexes: &mut BTreeSet<u32>) {
        for table in [&self.raw, &self.nat, &self.filter] {
            extend_candidate_pool_indexes(table, indexes);
        }
    }

    async fn delete_pool_rules(&self, pool_index: u32) -> NamespaceDeleteOutcome {
        delete_firewall_restore_selection(
            "iptables-restore",
            firewall_restore_tables_for_pool([&self.raw, &self.nat, &self.filter], pool_index),
        )
        .await
    }

    async fn delete_rules_with_comments(
        &self,
        comments: &BTreeSet<String>,
    ) -> NamespaceDeleteOutcome {
        delete_firewall_restore_selection(
            "iptables-restore",
            firewall_restore_tables_with_comments([&self.raw, &self.nat, &self.filter], comments),
        )
        .await
    }
}

#[derive(Debug)]
struct FirewallSnapshot {
    ipv4: Ipv4FirewallSnapshot,
    ipv6_filter: FirewallTableSnapshot,
}

impl FirewallSnapshot {
    async fn capture() -> Self {
        let (ipv4, ipv6_filter) = tokio::join!(
            Ipv4FirewallSnapshot::capture(),
            capture_firewall_table("ip6tables-save", "filter"),
        );
        Self { ipv4, ipv6_filter }
    }

    fn extend_candidate_pool_indexes(&self, indexes: &mut BTreeSet<u32>) {
        self.ipv4.extend_candidate_pool_indexes(indexes);
        extend_candidate_pool_indexes(&self.ipv6_filter, indexes);
    }

    async fn delete_pool_rules(&self, pool_index: u32) -> NamespaceDeleteOutcome {
        let ipv6 = firewall_restore_tables_for_pool([&self.ipv6_filter], pool_index);
        let (ipv4, ipv6_filter) = tokio::join!(
            self.ipv4.delete_pool_rules(pool_index),
            delete_firewall_restore_selection("ip6tables-restore", ipv6),
        );
        combine_namespace_delete_outcomes([ipv4, ipv6_filter])
    }

    async fn delete_rules_with_comments(
        &self,
        comments: &BTreeSet<String>,
    ) -> NamespaceDeleteOutcome {
        let ipv6 = firewall_restore_tables_with_comments([&self.ipv6_filter], comments);
        let (ipv4, ipv6_filter) = tokio::join!(
            self.ipv4.delete_rules_with_comments(comments),
            delete_firewall_restore_selection("ip6tables-restore", ipv6),
        );
        combine_namespace_delete_outcomes([ipv4, ipv6_filter])
    }
}

#[derive(Debug)]
struct CapturedNamespace {
    name: String,
    host_device: String,
}

#[derive(Debug)]
struct ReconciliationSnapshot {
    firewall: FirewallSnapshot,
    namespaces_by_pool: SnapshotSource<BTreeMap<u32, Vec<CapturedNamespace>>>,
}

impl ReconciliationSnapshot {
    async fn capture() -> Self {
        let (firewall, namespaces) =
            tokio::join!(FirewallSnapshot::capture(), capture_namespaces());
        Self {
            firewall,
            namespaces_by_pool: namespaces,
        }
    }

    fn candidate_pool_indexes(&self, own_index: u32) -> BTreeSet<u32> {
        let mut indexes = BTreeSet::from([own_index]);
        self.firewall.extend_candidate_pool_indexes(&mut indexes);
        if let SnapshotSource::Captured(namespaces_by_pool) = &self.namespaces_by_pool {
            indexes.extend(namespaces_by_pool.keys().copied());
        }
        indexes
    }
}

async fn capture_firewall_table(
    save_command: &'static str,
    table: &'static str,
) -> FirewallTableSnapshot {
    let rules_by_pool =
        match exec_with_timeout(save_command, &["-t", table], NETNS_COMMAND_TIMEOUT).await {
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
                warn!(save_command, table, %error, "failed to capture firewall rules for cleanup");
                SnapshotSource::Abandoned
            }
        };
    FirewallTableSnapshot {
        table,
        rules_by_pool,
    }
}

fn firewall_rule_pool_index(line: &str) -> Option<u32> {
    firewall_rule_comment(line).and_then(pool_index_from_comment)
}

fn firewall_rule_comment(line: &str) -> Option<&str> {
    if !line.starts_with("-A ") {
        return None;
    }

    let mut tokens = line.split_whitespace();
    while let Some(token) = tokens.next() {
        if token == "--comment" {
            return tokens.next().map(|comment| comment.trim_matches('"'));
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

fn extend_candidate_pool_indexes(snapshot: &FirewallTableSnapshot, indexes: &mut BTreeSet<u32>) {
    if let SnapshotSource::Captured(rules_by_pool) = &snapshot.rules_by_pool {
        indexes.extend(rules_by_pool.keys().copied());
    }
}

fn combine_namespace_delete_outcomes(
    outcomes: impl IntoIterator<Item = NamespaceDeleteOutcome>,
) -> NamespaceDeleteOutcome {
    if outcomes
        .into_iter()
        .all(|outcome| matches!(outcome, NamespaceDeleteOutcome::Deleted))
    {
        NamespaceDeleteOutcome::Deleted
    } else {
        NamespaceDeleteOutcome::Abandoned
    }
}

fn firewall_restore_tables_for_pool<'a>(
    snapshots: impl IntoIterator<Item = &'a FirewallTableSnapshot>,
    pool_index: u32,
) -> FirewallRestoreSelection {
    select_firewall_restore_tables(snapshots, |rules_by_pool| {
        rules_by_pool
            .get(&pool_index)
            .into_iter()
            .flatten()
            .cloned()
            .collect()
    })
}

fn firewall_restore_tables_with_comments<'a>(
    snapshots: impl IntoIterator<Item = &'a FirewallTableSnapshot>,
    comments: &BTreeSet<String>,
) -> FirewallRestoreSelection {
    select_firewall_restore_tables(snapshots, |rules_by_pool| {
        rules_by_pool
            .values()
            .flatten()
            .filter(|line| {
                firewall_rule_comment(line).is_some_and(|comment| comments.contains(comment))
            })
            .cloned()
            .collect()
    })
}

fn select_firewall_restore_tables<'a>(
    snapshots: impl IntoIterator<Item = &'a FirewallTableSnapshot>,
    select_rules: impl Fn(&BTreeMap<u32, Vec<String>>) -> Vec<String>,
) -> FirewallRestoreSelection {
    let mut selection = FirewallRestoreSelection {
        tables: Vec::new(),
        sources_complete: true,
    };
    for snapshot in snapshots {
        match &snapshot.rules_by_pool {
            SnapshotSource::Captured(rules_by_pool) => {
                selection.tables.push(FirewallRestoreTable {
                    table: snapshot.table,
                    rules: select_rules(rules_by_pool),
                });
            }
            SnapshotSource::Abandoned => selection.sources_complete = false,
        }
    }
    selection
}

fn firewall_restore_payload(
    tables: &[FirewallRestoreTable],
    mode: FirewallRestoreMode,
) -> std::result::Result<String, &'static str> {
    let mut payload = String::new();
    for table in tables {
        if table.rules.is_empty() {
            continue;
        }
        payload.push('*');
        payload.push_str(table.table);
        payload.push('\n');
        for rule in &table.rules {
            match mode {
                FirewallRestoreMode::Apply => payload.push_str(rule),
                FirewallRestoreMode::Delete => {
                    payload.push_str("-D ");
                    payload.push_str(
                        rule.strip_prefix("-A ")
                            .ok_or("captured firewall rule has an invalid append form")?,
                    );
                }
            }
            payload.push('\n');
        }
        payload.push_str("COMMIT\n");
    }
    Ok(payload)
}

async fn delete_firewall_restore_selection(
    command: &str,
    selection: FirewallRestoreSelection,
) -> NamespaceDeleteOutcome {
    let outcome = delete_firewall_rules_with_restore(command, selection.tables).await;
    combine_namespace_delete_outcomes([
        outcome,
        if selection.sources_complete {
            NamespaceDeleteOutcome::Deleted
        } else {
            NamespaceDeleteOutcome::Abandoned
        },
    ])
}

async fn delete_firewall_rules_with_restore(
    command: &str,
    tables: Vec<FirewallRestoreTable>,
) -> NamespaceDeleteOutcome {
    let payload = match firewall_restore_payload(&tables, FirewallRestoreMode::Delete) {
        Ok(payload) => payload,
        Err(error) => {
            warn!(command, error, "failed to build firewall restore input");
            return NamespaceDeleteOutcome::Abandoned;
        }
    };
    if payload.is_empty() {
        return NamespaceDeleteOutcome::Deleted;
    }

    match run_firewall_restore(command, &payload).await {
        Ok(()) => NamespaceDeleteOutcome::Deleted,
        Err(error) => {
            warn!(command, %error, "firewall restore did not complete cleanly");
            NamespaceDeleteOutcome::Abandoned
        }
    }
}

async fn apply_firewall_rules_with_restore(
    command: &str,
    tables: &[FirewallRestoreTable],
) -> Result<()> {
    let payload = firewall_restore_payload(tables, FirewallRestoreMode::Apply)
        .map_err(|error| NetworkError::Prerequisite(error.into()))?;
    if payload.is_empty() {
        return Ok(());
    }
    run_firewall_restore(command, &payload).await?;
    Ok(())
}

async fn run_firewall_restore(
    command: &str,
    payload: &str,
) -> std::result::Result<(), CommandError> {
    let mut file = match tempfile::NamedTempFile::new() {
        Ok(file) => file,
        Err(error) => {
            return Err(CommandError {
                command: command.to_string(),
                detail: format!("failed to create firewall restore input: {error}"),
            });
        }
    };
    if let Err(error) = file.write_all(payload.as_bytes()) {
        return Err(CommandError {
            command: command.to_string(),
            detail: format!("failed to write firewall restore input: {error}"),
        });
    }
    let Some(path) = file.path().to_str() else {
        return Err(CommandError {
            command: command.to_string(),
            detail: format!(
                "firewall restore input path is not UTF-8: {}",
                file.path().display()
            ),
        });
    };

    exec_xtables_status_with_timeout(command, &["--noflush", path], NETNS_COMMAND_TIMEOUT).await
}

/// Clean up all captured resources matching a given pool index.
///
/// Deletes orphaned host firewall rules first, then deletes captured
/// namespaces and their veth devices. An abandoned snapshot remains abandoned;
/// cleanup never expands one failed host read into per-namespace table scans.
async fn cleanup_namespaces_from_snapshot(
    snapshot: &ReconciliationSnapshot,
    index: u32,
) -> NamespaceDeleteOutcome {
    let firewall = snapshot.firewall.delete_pool_rules(index).await;
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

    #[tokio::test]
    #[cfg(unix)]
    async fn firewall_restore_applies_insert_and_append_rules_in_one_waiting_mutation() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let command = dir.path().join("verify-restore");
        std::fs::write(
            &command,
            r#"#!/bin/sh
[ "$1" = "--wait" ] || exit 2
[ "$2" = "--noflush" ] || exit 3
EXPECTED='*raw
-I PREROUTING 1 -m comment --comment vm0-ns-00-00 -j DROP
COMMIT
*filter
-A FORWARD -m comment --comment vm0-ns-00-00 -j ACCEPT
COMMIT'
[ "$(cat "$3")" = "$EXPECTED" ] || exit 4
"#,
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        apply_firewall_rules_with_restore(
            command.to_str().unwrap(),
            &[
                FirewallRestoreTable {
                    table: "raw",
                    rules: vec!["-I PREROUTING 1 -m comment --comment vm0-ns-00-00 -j DROP".into()],
                },
                FirewallRestoreTable {
                    table: "filter",
                    rules: vec!["-A FORWARD -m comment --comment vm0-ns-00-00 -j ACCEPT".into()],
                },
            ],
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn firewall_restore_batches_tables_in_one_waiting_mutation() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let command = dir.path().join("verify-restore");
        std::fs::write(
            &command,
            r#"#!/bin/sh
[ "$1" = "--wait" ] || exit 2
[ "$2" = "--noflush" ] || exit 3
EXPECTED='*raw
-D PREROUTING -m comment --comment vm0-ns-00-00 -j DROP
COMMIT
*filter
-D FORWARD -m comment --comment vm0-ns-00-00 -j ACCEPT
COMMIT'
[ "$(cat "$3")" = "$EXPECTED" ] || exit 4
"#,
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let outcome = delete_firewall_rules_with_restore(
            command.to_str().unwrap(),
            vec![
                FirewallRestoreTable {
                    table: "raw",
                    rules: vec!["-A PREROUTING -m comment --comment vm0-ns-00-00 -j DROP".into()],
                },
                FirewallRestoreTable {
                    table: "nat",
                    rules: Vec::new(),
                },
                FirewallRestoreTable {
                    table: "filter",
                    rules: vec!["-A FORWARD -m comment --comment vm0-ns-00-00 -j ACCEPT".into()],
                },
            ],
        )
        .await;

        assert_eq!(outcome, NamespaceDeleteOutcome::Deleted);
    }

    #[tokio::test]
    async fn firewall_restore_nonzero_is_abandoned() {
        let outcome = delete_firewall_rules_with_restore(
            "false",
            vec![FirewallRestoreTable {
                table: "raw",
                rules: vec!["-A PREROUTING -j DROP".into()],
            }],
        )
        .await;

        assert_eq!(outcome, NamespaceDeleteOutcome::Abandoned);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn incomplete_snapshot_deletes_captured_rules_and_remains_abandoned() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let command = dir.path().join("verify-restore");
        let called = dir.path().join("called");
        std::fs::write(
            &command,
            format!(
                r#"#!/bin/sh
[ "$1" = "--wait" ] || exit 2
[ "$2" = "--noflush" ] || exit 3
EXPECTED='*raw
-D PREROUTING -m comment --comment vm0-ns-00-00 -j DROP
COMMIT'
[ "$(cat "$3")" = "$EXPECTED" ] || exit 4
touch "{}"
"#,
                called.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let captured = FirewallTableSnapshot {
            table: "raw",
            rules_by_pool: SnapshotSource::Captured(BTreeMap::from([(
                0,
                vec!["-A PREROUTING -m comment --comment vm0-ns-00-00 -j DROP".into()],
            )])),
        };
        let abandoned = FirewallTableSnapshot {
            table: "filter",
            rules_by_pool: SnapshotSource::Abandoned,
        };
        let selection = firewall_restore_tables_for_pool([&captured, &abandoned], 0);

        let outcome = delete_firewall_restore_selection(command.to_str().unwrap(), selection).await;

        assert!(called.exists());
        assert_eq!(outcome, NamespaceDeleteOutcome::Abandoned);
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
