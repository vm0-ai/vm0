use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::File;
use std::future::Future;
use std::os::fd::AsRawFd;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(test)]
use std::time::Duration;

use nix::errno::Errno;
use nix::fcntl::{Flock, FlockArg};
use tracing::{error, info, warn};

use crate::command::{
    IgnoredCommandOutcome, exec_ignore_errors_with_timeout, exec_status_with_timeout,
    exec_with_timeout,
};
use crate::guest_dns_netfilter_trace::{
    GuestDnsNetfilterTraceAttachment, GuestDnsNetfilterTraceReader,
};
use crate::paths::LockPaths;

use super::super::error::{NetworkError, Result};
use super::super::{GUEST_NETWORK, GuestNetwork};
use super::HOST_NETWORK_COMMAND_TIMEOUT;
use super::firewall::{
    FirewallSnapshot, NamespaceFirewallConfig, apply_namespace_guest_dns_trace_rules,
    apply_namespace_rules, delete_ipv4_rules_by_comment, delete_rules_with_comments,
    setup_namespace_masquerade,
};
use super::naming::{
    MAX_NAMESPACES, MAX_POOLS, format_hex_index, generate_veth_ip_pair, make_host_device,
    make_ns_name, parse_netns_name,
};
use super::types::{NamespaceDeleteOutcome, NetnsInfo};

// Each namespace starts two `ip` children concurrently. A 16-wide window caps
// that fanout at 32 processes. At the 256-namespace hard limit, sixteen
// 10-second waves leave room inside the runner's 300-second systemd stop
// budget for firewall cleanup and the other teardown phases.
const NAMESPACE_DELETE_CONCURRENCY: usize = 16;
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

fn namespace_delete_outcome_from_best_effort(
    outcomes: impl IntoIterator<Item = IgnoredCommandOutcome>,
) -> NamespaceDeleteOutcome {
    if outcomes
        .into_iter()
        .all(|outcome| outcome.completed_without_timeout())
    {
        NamespaceDeleteOutcome::Deleted
    } else {
        NamespaceDeleteOutcome::Abandoned
    }
}

/// Shorthand: run `ip <args>`, discard stdout.
async fn exec_ip(args: &[&str]) -> Result<()> {
    exec_status_with_timeout("ip", args, HOST_NETWORK_COMMAND_TIMEOUT).await?;
    Ok(())
}

pub(super) async fn enable_host_ip_forwarding() -> Result<()> {
    exec_status_with_timeout(
        "sysctl",
        &["-w", "net.ipv4.ip_forward=1"],
        HOST_NETWORK_COMMAND_TIMEOUT,
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
    setup_namespace_masquerade(name, &src, PEER_DEVICE).await?;
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

pub(super) async fn get_default_interface() -> Result<String> {
    let result = exec_with_timeout(
        "ip",
        &["route", "get", "8.8.8.8"],
        HOST_NETWORK_COMMAND_TIMEOUT,
    )
    .await?;
    let iface = result
        .split_whitespace()
        .skip_while(|&w| w != "dev")
        .nth(1)
        .map(String::from)
        .ok_or(NetworkError::NoDefaultInterface(result))?;
    Ok(iface)
}

/// Delete a namespace's network resources (iptables, veth, netns).
async fn delete_namespace_resources(ns_name: &str, host_device: &str) -> NamespaceDeleteOutcome {
    info!(name = %ns_name, "deleting namespace");
    let iptables = delete_ipv4_rules_by_comment(ns_name).await;
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

    let firewall = delete_rules_with_comments(&comments, includes_ipv6).await;

    let namespace_outcome = delete_namespace_resources_bounded(
        namespaces
            .into_iter()
            .map(NamespaceResources::from)
            .collect(),
    )
    .await;
    NamespaceDeleteOutcome::combine([firewall, namespace_outcome])
}

async fn delete_namespace_resources_bounded(
    namespaces: Vec<NamespaceResources>,
) -> NamespaceDeleteOutcome {
    delete_namespace_resources_bounded_with(namespaces, |name, host_device| async move {
        delete_namespace_link_and_netns(&name, &host_device).await
    })
    .await
}

async fn delete_namespace_resources_bounded_with<F, Fut>(
    namespaces: Vec<NamespaceResources>,
    delete: F,
) -> NamespaceDeleteOutcome
where
    F: Fn(String, String) -> Fut + Clone + Send + 'static,
    Fut: Future<Output = NamespaceDeleteOutcome> + Send + 'static,
{
    let count = namespaces.len();
    if count == 0 {
        return NamespaceDeleteOutcome::Deleted;
    }

    info!(
        count,
        concurrency = NAMESPACE_DELETE_CONCURRENCY,
        "deleting namespace resource batch"
    );
    let mut pending = namespaces.into_iter();
    let mut tasks = tokio::task::JoinSet::new();
    let mut in_flight = HashMap::new();

    while tasks.len() < NAMESPACE_DELETE_CONCURRENCY {
        let Some(namespace) = pending.next() else {
            break;
        };
        spawn_namespace_resource_delete(&mut tasks, &mut in_flight, namespace, delete.clone());
    }

    let mut outcome = NamespaceDeleteOutcome::Deleted;
    let mut failed = 0_usize;
    while let Some(result) = tasks.join_next_with_id().await {
        let task_id = match &result {
            Ok((task_id, _)) => *task_id,
            Err(error) => error.id(),
        };
        let namespace = in_flight.remove(&task_id);

        match (namespace, result) {
            (Some(_), Ok((_, NamespaceDeleteOutcome::Deleted))) => {}
            (Some(namespace), Ok((_, NamespaceDeleteOutcome::Abandoned))) => {
                warn!(
                    name = %namespace.name,
                    host_device = %namespace.host_device,
                    "namespace cleanup did not complete cleanly; startup orphan reconciliation will retry"
                );
                outcome = NamespaceDeleteOutcome::Abandoned;
                failed += 1;
            }
            (Some(namespace), Err(error)) => {
                warn!(
                    name = %namespace.name,
                    host_device = %namespace.host_device,
                    %error,
                    "namespace cleanup task did not complete cleanly; startup orphan reconciliation will retry"
                );
                outcome = NamespaceDeleteOutcome::Abandoned;
                failed += 1;
            }
            (None, result) => {
                warn!(
                    task_id = %task_id,
                    result = ?result,
                    "namespace cleanup task lost its resource metadata; startup orphan reconciliation will retry"
                );
                outcome = NamespaceDeleteOutcome::Abandoned;
                failed += 1;
            }
        }

        if let Some(namespace) = pending.next() {
            spawn_namespace_resource_delete(&mut tasks, &mut in_flight, namespace, delete.clone());
        }
    }

    for (_, namespace) in in_flight {
        warn!(
            name = %namespace.name,
            host_device = %namespace.host_device,
            "namespace cleanup task was not joined; startup orphan reconciliation will retry"
        );
        outcome = NamespaceDeleteOutcome::Abandoned;
        failed += 1;
    }

    if matches!(outcome, NamespaceDeleteOutcome::Deleted) {
        info!(count, "namespace resource batch deleted");
    } else {
        warn!(
            count,
            failed,
            "namespace resource batch cleanup was abandoned; startup orphan reconciliation will retry"
        );
    }
    outcome
}

fn spawn_namespace_resource_delete<F, Fut>(
    tasks: &mut tokio::task::JoinSet<NamespaceDeleteOutcome>,
    in_flight: &mut HashMap<tokio::task::Id, NamespaceResources>,
    namespace: NamespaceResources,
    delete: F,
) where
    F: Fn(String, String) -> Fut + Send + 'static,
    Fut: Future<Output = NamespaceDeleteOutcome> + Send + 'static,
{
    let name = namespace.name.clone();
    let host_device = namespace.host_device.clone();
    let task = tasks.spawn(async move { delete(name, host_device).await });
    let replaced = in_flight.insert(task.id(), namespace);
    debug_assert!(replaced.is_none());
}

/// Delete the host veth and netns only; callers handle host iptables separately.
async fn delete_namespace_link_and_netns(
    ns_name: &str,
    host_device: &str,
) -> NamespaceDeleteOutcome {
    let del_link_args = ["link", "del", host_device];
    let del_ns_args = ["netns", "del", ns_name];
    let (link, netns) = tokio::join!(
        exec_ignore_errors_with_timeout("ip", &del_link_args, HOST_NETWORK_COMMAND_TIMEOUT),
        exec_ignore_errors_with_timeout("ip", &del_ns_args, HOST_NETWORK_COMMAND_TIMEOUT),
    );
    namespace_delete_outcome_from_best_effort([link, netns])
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
        exec_ignore_errors_with_timeout("conntrack", &src_args, HOST_NETWORK_COMMAND_TIMEOUT),
        exec_ignore_errors_with_timeout("conntrack", &dst_args, HOST_NETWORK_COMMAND_TIMEOUT),
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

/// Exclusive pool-index flock released when the final file descriptor closes.
///
/// Unlike [`Flock`], this guard does not issue an explicit `LOCK_UN` on drop.
/// That lets a privileged integration test duplicate the open file description
/// and retain ownership while it verifies shutdown cleanup.
#[derive(Debug)]
pub(super) struct PoolIndexLock {
    _file: File,
}

impl PoolIndexLock {
    pub(super) fn try_lock(file: File) -> std::result::Result<Self, (File, Errno)> {
        // SAFETY: `file` owns a valid descriptor for the duration of the call.
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result == 0 {
            Ok(Self { _file: file })
        } else {
            Err((file, Errno::last()))
        }
    }
}

/// Try to acquire an exclusive flock on a pool index file (0..MAX_POOLS).
///
/// Returns the first successfully locked `(index, PoolIndexLock)`. The lock is
/// held until the final descriptor for its open file description closes.
pub(super) fn acquire_pool_lock(locks: &LockPaths) -> Result<(u32, PoolIndexLock)> {
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
        match PoolIndexLock::try_lock(file) {
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
    guest_dns_netfilter_trace_requested: bool,
    guest_dns_netfilter_trace_reader: Option<GuestDnsNetfilterTraceReader>,
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
            let trace = match (
                guest_dns_netfilter_trace_requested,
                guest_dns_netfilter_trace_reader,
                dns_port,
            ) {
                (false, _, _) => GuestDnsNetfilterTraceAttachment::Disabled,
                (true, None, _) => {
                    GuestDnsNetfilterTraceAttachment::unavailable("monitor_unavailable")
                }
                (true, Some(_), None) => {
                    GuestDnsNetfilterTraceAttachment::unavailable("dns_proxy_disabled")
                }
                (true, Some(reader), Some(_))
                    if apply_namespace_guest_dns_trace_rules(
                        "iptables-restore",
                        &ns_name,
                        &host_device,
                        &peer_ip,
                    )
                    .await =>
                {
                    GuestDnsNetfilterTraceAttachment::enabled(reader)
                }
                (true, Some(_), Some(_)) => {
                    GuestDnsNetfilterTraceAttachment::unavailable("rule_install_failed")
                }
            };
            info!(name = %ns_name, "namespace created");
            Ok(NetnsInfo::new(ns_name, host_device, peer_ip).with_guest_dns_netfilter_trace(trace))
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
    apply_namespace_rules(name, host_device, peer_ip, firewall_config).await?;

    Ok(())
}

#[derive(Debug)]
enum SnapshotSource<T> {
    Captured(T),
    Abandoned,
}

#[derive(Clone, Debug)]
struct NamespaceResources {
    name: String,
    host_device: String,
}

impl From<NetnsInfo> for NamespaceResources {
    fn from(namespace: NetnsInfo) -> Self {
        Self {
            name: namespace.name,
            host_device: namespace.host_device,
        }
    }
}

#[derive(Debug)]
struct ReconciliationSnapshot {
    firewall: FirewallSnapshot,
    namespaces_by_pool: SnapshotSource<BTreeMap<u32, Vec<NamespaceResources>>>,
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

async fn capture_namespaces() -> SnapshotSource<BTreeMap<u32, Vec<NamespaceResources>>> {
    let output =
        match exec_with_timeout("ip", &["netns", "list"], HOST_NETWORK_COMMAND_TIMEOUT).await {
            Ok(output) => output,
            Err(error) => {
                error!(%error, "failed to capture namespaces for startup reconciliation");
                return SnapshotSource::Abandoned;
            }
        };

    let mut namespaces_by_pool: BTreeMap<u32, Vec<NamespaceResources>> = BTreeMap::new();
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
            .push(NamespaceResources {
                name: name.to_string(),
                host_device: make_host_device(&pool_idx, &ns_idx),
            });
    }
    SnapshotSource::Captured(namespaces_by_pool)
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
    let namespace_outcome = delete_namespace_resources_bounded(namespaces.clone()).await;
    NamespaceDeleteOutcome::combine([firewall, namespace_outcome])
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
    _own_lock: &PoolIndexLock,
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
    use std::sync::atomic::AtomicUsize;

    use tokio::sync::Semaphore;

    const TEST_SYNC_TIMEOUT: Duration = Duration::from_secs(5);

    async fn wait_for_test_sync<T>(phase: &'static str, future: impl Future<Output = T>) -> T {
        match tokio::time::timeout(TEST_SYNC_TIMEOUT, future).await {
            Ok(value) => value,
            Err(_) => panic!("test synchronization timed out waiting for {phase}"),
        }
    }

    fn namespace_resources_for_test(count: usize) -> Vec<NamespaceResources> {
        (0..count)
            .map(|index| NamespaceResources {
                name: format!("vm0-ns-test-{index:02x}"),
                host_device: format!("vm0-ve-test-{index:02x}"),
            })
            .collect()
    }

    #[tokio::test]
    async fn namespace_resource_deletion_uses_fixed_concurrency_window() {
        let count = NAMESPACE_DELETE_CONCURRENCY + 2;
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let completed = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let cleanup = tokio::spawn(delete_namespace_resources_bounded_with(
            namespace_resources_for_test(count),
            {
                let active = Arc::clone(&active);
                let peak = Arc::clone(&peak);
                let completed = Arc::clone(&completed);
                let started = Arc::clone(&started);
                let release = Arc::clone(&release);
                move |_, _| {
                    let active = Arc::clone(&active);
                    let peak = Arc::clone(&peak);
                    let completed = Arc::clone(&completed);
                    let started = Arc::clone(&started);
                    let release = Arc::clone(&release);
                    async move {
                        let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(current, Ordering::SeqCst);
                        started.add_permits(1);
                        release.acquire().await.unwrap().forget();
                        active.fetch_sub(1, Ordering::SeqCst);
                        completed.fetch_add(1, Ordering::SeqCst);
                        NamespaceDeleteOutcome::Deleted
                    }
                }
            },
        ));

        for _ in 0..NAMESPACE_DELETE_CONCURRENCY {
            wait_for_test_sync(
                "namespace deletion to enter the fixed window",
                started.acquire(),
            )
            .await
            .unwrap()
            .forget();
        }
        assert_eq!(active.load(Ordering::SeqCst), NAMESPACE_DELETE_CONCURRENCY);
        assert_eq!(peak.load(Ordering::SeqCst), NAMESPACE_DELETE_CONCURRENCY);
        assert_eq!(started.available_permits(), 0);

        release.add_permits(count);
        let outcome = wait_for_test_sync("namespace deletion batch to complete", cleanup)
            .await
            .unwrap();

        assert_eq!(outcome, NamespaceDeleteOutcome::Deleted);
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert_eq!(peak.load(Ordering::SeqCst), NAMESPACE_DELETE_CONCURRENCY);
        assert_eq!(completed.load(Ordering::SeqCst), count);
    }

    #[tokio::test]
    async fn namespace_resource_deletion_aggregates_partial_failure() {
        let count = NAMESPACE_DELETE_CONCURRENCY + 2;
        let attempts = Arc::new(AtomicUsize::new(0));
        let failed_name = "vm0-ns-test-03";

        let outcome =
            delete_namespace_resources_bounded_with(namespace_resources_for_test(count), {
                let attempts = Arc::clone(&attempts);
                move |name, _| {
                    let attempts = Arc::clone(&attempts);
                    async move {
                        attempts.fetch_add(1, Ordering::SeqCst);
                        if name == failed_name {
                            NamespaceDeleteOutcome::Abandoned
                        } else {
                            NamespaceDeleteOutcome::Deleted
                        }
                    }
                }
            })
            .await;

        assert_eq!(outcome, NamespaceDeleteOutcome::Abandoned);
        assert_eq!(attempts.load(Ordering::SeqCst), count);
    }

    #[tokio::test]
    async fn namespace_resource_deletion_aggregates_task_panic() {
        let outcome = delete_namespace_resources_bounded_with(
            namespace_resources_for_test(3),
            |name, _| async move {
                assert_ne!(name, "vm0-ns-test-01", "synthetic deletion panic");
                NamespaceDeleteOutcome::Deleted
            },
        )
        .await;

        assert_eq!(outcome, NamespaceDeleteOutcome::Abandoned);
    }

    #[tokio::test]
    async fn cancelling_namespace_resource_deletion_aborts_in_flight_tasks() {
        struct NotifyOnDrop(Arc<Semaphore>);

        impl Drop for NotifyOnDrop {
            fn drop(&mut self) {
                self.0.add_permits(1);
            }
        }

        let started = Arc::new(Semaphore::new(0));
        let dropped = Arc::new(Semaphore::new(0));
        let cleanup = tokio::spawn(delete_namespace_resources_bounded_with(
            namespace_resources_for_test(NAMESPACE_DELETE_CONCURRENCY + 1),
            {
                let started = Arc::clone(&started);
                let dropped = Arc::clone(&dropped);
                move |_, _| {
                    let started = Arc::clone(&started);
                    let dropped = Arc::clone(&dropped);
                    async move {
                        let _drop = NotifyOnDrop(dropped);
                        started.add_permits(1);
                        std::future::pending::<NamespaceDeleteOutcome>().await
                    }
                }
            },
        ));

        for _ in 0..NAMESPACE_DELETE_CONCURRENCY {
            wait_for_test_sync(
                "namespace deletion to start before cancellation",
                started.acquire(),
            )
            .await
            .unwrap()
            .forget();
        }
        cleanup.abort();
        let error = wait_for_test_sync("cancelled deletion batch to stop", cleanup)
            .await
            .unwrap_err();
        assert!(error.is_cancelled());
        for _ in 0..NAMESPACE_DELETE_CONCURRENCY {
            wait_for_test_sync(
                "in-flight namespace deletion to be dropped",
                dropped.acquire(),
            )
            .await
            .unwrap()
            .forget();
        }
    }

    #[test]
    fn namespace_delete_outcome_abandons_uncertain_commands() {
        assert_eq!(
            namespace_delete_outcome_from_best_effort([
                IgnoredCommandOutcome::Success,
                IgnoredCommandOutcome::NonZero,
            ]),
            NamespaceDeleteOutcome::Deleted
        );

        for outcome in [
            IgnoredCommandOutcome::NotFound,
            IgnoredCommandOutcome::SpawnError,
            IgnoredCommandOutcome::WaitError,
            IgnoredCommandOutcome::PipeError,
            IgnoredCommandOutcome::OutputTooLarge,
            IgnoredCommandOutcome::Timeout,
        ] {
            assert_eq!(
                namespace_delete_outcome_from_best_effort([
                    IgnoredCommandOutcome::Success,
                    outcome,
                ]),
                NamespaceDeleteOutcome::Abandoned,
                "uncertain command outcome was treated as deleted: {outcome:?}"
            );
        }
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

        let held_idx = 0;
        let held = Flock::lock(
            File::create(locks.netns_pool(held_idx)).unwrap(),
            FlockArg::LockExclusiveNonblock,
        )
        .unwrap();

        let (available_idx, _available) = acquire_pool_lock(&locks).unwrap();
        assert_eq!(available_idx, 1);

        // Flock's explicit LOCK_UN makes release deterministic across forks.
        drop(held);

        let (reused_idx, _reused) = acquire_pool_lock(&locks).unwrap();
        assert_eq!(reused_idx, held_idx);
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

        let idx = 0;
        // Construct the idle state directly. A close-only PoolIndexLock can be
        // briefly retained by an unrelated concurrent fork.
        File::create(locks.netns_pool(idx)).unwrap();

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
