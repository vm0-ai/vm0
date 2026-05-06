//! Network Namespace Pool for Firecracker Snapshot VMs
//!
//! Manages pre-warmed network namespaces to reduce VM startup time.
//! Each namespace provides complete network isolation with fixed IPs,
//! enabling snapshot-based VM cloning without IP conflicts.
//!
//! ```text
//! ┌─────────────────────┐  ┌─────────────────────┐
//! │     Namespace 1     │  │     Namespace 2     │
//! │ ┌─────────────────┐ │  │ ┌─────────────────┐ │
//! │ │       VM        │ │  │ │       VM        │ │
//! │ │  192.168.241.2  │ │  │ │  192.168.241.2  │ │  ← Same fixed IP
//! │ └────────┬────────┘ │  │ └────────┬────────┘ │
//! │          │ TAP      │  │          │ TAP      │
//! │    192.168.241.1    │  │    192.168.241.1    │
//! │          │          │  │          │          │
//! │      NAT/MASQ       │  │      NAT/MASQ       │
//! │          │ veth0    │  │          │ veth0    │
//! │      10.200.0.2     │  │      10.200.0.6     │  ← Unique veth IP
//! └──────────┼──────────┘  └──────────┼──────────┘
//!            │ veth-host              │ veth-host
//!        10.200.0.1               10.200.0.5
//!            │                        │
//!            └──────────┬─────────────┘
//!                       │ NAT/MASQ
//!                       ↓
//!                 External Network
//! ```
//!
//! Design:
//! - Pool lazily pre-warms a small number of namespaces at init, then
//!   replenishes in the background on each [`NetnsPool::acquire`]
//! - [`NetnsPool::acquire`] returns a non-cloneable [`NetnsLease`] from the
//!   pool, or creates one on-demand as fallback
//! - [`NetnsPool::release`] takes `&mut Option<NetnsLease>` so cancellation
//!   before the final commit point leaves cleanup ownership with the caller
//! - Pool index (0–63) is auto-allocated via flock on `/var/lock`
//! - Orphans from abnormally-exited prior runners (SIGKILL, panic, OOM,
//!   power loss, aborted in-flight creation tasks) are reconciled at
//!   startup via flock-based liveness probe — see
//!   [`reconcile_orphan_namespaces`]

use std::collections::{HashSet, VecDeque};
use std::fs::File;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use nix::fcntl::{Flock, FlockArg};
use sandbox::SandboxError;
use tokio::sync::{mpsc, watch};
use tracing::{error, info, warn};

use crate::command::{IgnoredCommandOutcome, exec_ignore_errors_with_timeout, exec_with_timeout};
use crate::paths::LockPaths;

use super::GUEST_NETWORK;
use super::error::{NetworkError, Result};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Peer-side device name inside namespaces (fixed).
const PEER_DEVICE: &str = "veth0";
/// Namespace name prefix.
pub const NS_PREFIX: &str = "vm0-ns-";
/// Host-side device name prefix.
const HOST_PREFIX: &str = "vm0-ve-";
/// First two octets shared by all veth IP addresses.
const IP_PREFIX: &str = "10.200";

/// Maximum pool index (0x00–0x3f), ensuring IPs stay within `10.200.0.0/16`.
const MAX_POOLS: u32 = 64;
/// Maximum namespaces a single pool can own (index 0x00–0xff).
const MAX_NAMESPACES: u32 = 256;
/// Number of ready namespaces to keep in each pool queue.
/// The pool pre-warms this many at startup and replenishes to
/// maintain this level after each acquire.
const BUFFER_SIZE: usize = 4;
/// Maximum time for host commands that create, reset, or delete netns state.
const NETNS_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
static CONNTRACK_NOT_FOUND_LOGGED: AtomicBool = AtomicBool::new(false);

// Compile-time check: all /30 subnets fit within `10.200.0.0/16`.
// 64 pools × 256 ns × 4 addresses per /30 = 65536 = exactly 2^16.
const _: () = assert!(MAX_POOLS * MAX_NAMESPACES * 4 <= 65536);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Monotonic in-process identity for [`NetnsPool`] instances.
static NEXT_NETNS_POOL_INSTANCE_ID: AtomicU64 = AtomicU64::new(1);

fn next_pool_instance_id() -> u64 {
    NEXT_NETNS_POOL_INSTANCE_ID.fetch_add(1, Ordering::Relaxed)
}

/// Cloneable metadata for a network namespace.
///
/// Cloning this does not grant release authority. Checked-out ownership is held
/// by [`NetnsLease`].
#[derive(Debug, Clone)]
#[must_use]
pub struct NetnsInfo {
    /// Namespace name (e.g. `vm0-ns-00-00`).
    name: String,
    /// Host-side veth device name (e.g. `vm0-ve-00-00`).
    host_device: String,
    /// Veth namespace-side IP (e.g. `10.200.0.2`). This is the source IP
    /// that the proxy sees after NAT, used as the VM registry key.
    peer_ip: String,
}

impl NetnsInfo {
    fn new(name: String, host_device: String, peer_ip: String) -> Self {
        Self {
            name,
            host_device,
            peer_ip,
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn host_device(&self) -> &str {
        &self.host_device
    }

    pub fn peer_ip(&self) -> &str {
        &self.peer_ip
    }
}

/// Non-cloneable release authority for a checked-out namespace.
///
/// Dropping a live lease only emits a warning. Call [`NetnsPool::release`] so
/// the namespace is either recycled into the pool or deleted during shutdown.
#[derive(Debug)]
#[must_use]
pub struct NetnsLease {
    info: NetnsInfo,
    pool_instance_id: u64,
    active: bool,
}

impl NetnsLease {
    fn new(info: NetnsInfo, pool_instance_id: u64) -> Self {
        Self {
            info,
            pool_instance_id,
            active: true,
        }
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(name: &str) -> Self {
        Self::new(
            NetnsInfo::new(name.into(), "test-ve".into(), "10.200.0.2".into()),
            0,
        )
    }

    pub fn info(&self) -> &NetnsInfo {
        &self.info
    }

    pub fn name(&self) -> &str {
        self.info.name()
    }

    pub fn peer_ip(&self) -> &str {
        self.info.peer_ip()
    }

    fn pool_instance_id(&self) -> u64 {
        self.pool_instance_id
    }

    fn into_info(mut self) -> NetnsInfo {
        self.active = false;
        self.info.clone()
    }

    #[cfg(test)]
    pub(crate) fn into_info_for_test(self) -> NetnsInfo {
        self.into_info()
    }
}

impl Drop for NetnsLease {
    fn drop(&mut self) {
        if self.active {
            warn!(
                name = %self.info.name,
                pool_instance_id = self.pool_instance_id,
                "netns lease dropped without explicit release"
            );
        }
    }
}

/// Configuration for creating a [`NetnsPool`].
///
/// When `proxy_port` is set, the pool pre-warms and acquires from the proxy
/// queue only. Without `proxy_port`, it pre-warms and acquires from the plain
/// queue. This avoids keeping an unreachable plain queue alive in proxy mode.
pub struct NetnsPoolConfig {
    /// Proxy port for HTTP/HTTPS redirect (only adds redirect rules when set).
    pub proxy_port: Option<u16>,
    /// DNS proxy port for DNS query redirect. Only meaningful with `proxy_port`.
    pub dns_port: Option<u16>,
}

/// Network pool config after host network prerequisites have been validated.
pub(crate) struct CheckedNetnsPoolConfig {
    inner: NetnsPoolConfig,
}

impl NetnsPoolConfig {
    /// Validate host tools required by [`NetnsPool::create`].
    pub(crate) fn into_checked(self) -> std::result::Result<CheckedNetnsPoolConfig, SandboxError> {
        crate::prerequisites::check_network_prerequisites()?;
        Ok(CheckedNetnsPoolConfig { inner: self })
    }
}

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

#[derive(Clone)]
struct NetnsLifecycleOps {
    flush_conntrack: Arc<dyn Fn(String) -> BoxFuture<ConntrackFlushOutcome> + Send + Sync>,
    delete_namespace: Arc<dyn Fn(NetnsInfo) -> BoxFuture<NamespaceDeleteOutcome> + Send + Sync>,
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
    fn trusted_for_test() -> Self {
        Self {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_namespace: Arc::new(|_| Box::pin(async { NamespaceDeleteOutcome::Deleted })),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConntrackFlushOutcome {
    Trusted,
    Untrusted,
}

impl ConntrackFlushOutcome {
    fn is_trusted(self) -> bool {
        matches!(self, Self::Trusted)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NamespaceDeleteOutcome {
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetnsReleaseOutcome {
    Released,
    Deleted,
    Abandoned,
    InvalidLease(String),
}

impl NetnsReleaseOutcome {
    pub(crate) fn invalid_message(&self) -> Option<&str> {
        match self {
            Self::InvalidLease(message) => Some(message),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct PendingId(u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingKind {
    Plain,
    Proxy,
}

struct CreationCompletion {
    id: PendingId,
    kind: PendingKind,
    result: Result<NetnsInfo>,
}

#[derive(Clone)]
struct CreationNotifier {
    tx: mpsc::UnboundedSender<CreationCompletion>,
    generation: Arc<AtomicU64>,
    wake_tx: watch::Sender<u64>,
    ops: NetnsLifecycleOps,
}

impl CreationNotifier {
    async fn send(self, completion: CreationCompletion) {
        match self.tx.send(completion) {
            Ok(()) => self.wake(),
            Err(err) => {
                let completion = err.0;
                if let Ok(ns) = completion.result {
                    warn!(
                        name = %ns.name,
                        host_device = %ns.host_device,
                        "namespace creation completed after pool receiver dropped; deleting"
                    );
                    let outcome = (self.ops.delete_namespace)(ns.clone()).await;
                    if matches!(outcome, NamespaceDeleteOutcome::Abandoned) {
                        warn!(
                            name = %ns.name,
                            host_device = %ns.host_device,
                            "failed to delete namespace after completion delivery failed; startup orphan reconciliation will retry"
                        );
                    }
                }
                self.wake();
            }
        }
    }

    fn wake(&self) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.wake_tx.send(generation);
    }
}

#[derive(Clone)]
pub struct NetnsPoolHandle {
    inner: Arc<tokio::sync::Mutex<NetnsPool>>,
}

enum AcquirePlan {
    Ready(NetnsLease),
    Delete(Vec<NetnsInfo>, NetnsLifecycleOps),
    Wait(watch::Receiver<u64>),
}

struct ReleasePlan {
    info: NetnsInfo,
    has_proxy: bool,
    active_at_prepare: bool,
    ops: NetnsLifecycleOps,
}

struct CleanupPlan {
    namespaces: Vec<NetnsInfo>,
    ops: NetnsLifecycleOps,
    wait_for_pending: Option<watch::Receiver<u64>>,
    done: bool,
}

// ---------------------------------------------------------------------------
// Naming & IP helpers (pure functions)
// ---------------------------------------------------------------------------

fn format_hex_index(index: u32) -> String {
    format!("{index:02x}")
}

fn make_ns_name(pool_idx: &str, ns_idx: &str) -> String {
    format!("{NS_PREFIX}{pool_idx}-{ns_idx}")
}

fn make_host_device(pool_idx: &str, ns_idx: &str) -> String {
    format!("{HOST_PREFIX}{pool_idx}-{ns_idx}")
}

/// Generate a unique /30 IP pair for a veth link.
///
/// Each namespace gets a /30 subnet from the `10.200.0.0/16` range:
///
/// ```text
///   octet3     = pool_idx × 4 + ns_idx / 64
///   octet4_base = (ns_idx % 64) × 4
///   host_ip    = 10.200.{octet3}.{octet4_base + 1}
///   peer_ip    = 10.200.{octet3}.{octet4_base + 2}
/// ```
///
/// | pool | ns  | host_ip          | peer_ip          |
/// |------|-----|------------------|------------------|
/// | 0    | 0   | `10.200.0.1`     | `10.200.0.2`     |
/// | 0    | 1   | `10.200.0.5`     | `10.200.0.6`     |
/// | 0    | 64  | `10.200.1.1`     | `10.200.1.2`     |
/// | 1    | 0   | `10.200.4.1`     | `10.200.4.2`     |
/// | 63   | 255 | `10.200.255.253` | `10.200.255.254` |
///
/// Capacity: 64 pools × 256 ns × 4 addr = 65536 = `10.200.0.0/16`.
fn generate_veth_ip_pair(pool_idx: u32, ns_idx: u32) -> (String, String) {
    // 64 /30 subnets per octet3 value (64 × 4 = 256 addresses)
    let octet3 = pool_idx * 4 + ns_idx / 64;
    let octet4_base = (ns_idx % 64) * 4;
    let host_ip = format!("{IP_PREFIX}.{octet3}.{}", octet4_base + 1);
    let peer_ip = format!("{IP_PREFIX}.{octet3}.{}", octet4_base + 2);
    (host_ip, peer_ip)
}

/// Parse a namespace name into (pool_idx, ns_idx) hex strings.
///
/// Returns `None` if the name doesn't match the expected format
/// `vm0-ns-{XX}-{XX}` where each index is exactly 2 hex characters.
fn parse_ns_name(name: &str) -> Option<(&str, &str)> {
    let suffix = name.strip_prefix(NS_PREFIX)?;
    let (pool_idx, ns_idx) = suffix.split_once('-')?;
    if !is_hex2(pool_idx) || !is_hex2(ns_idx) {
        return None;
    }
    Some((pool_idx, ns_idx))
}

/// Check that a string is exactly 2 lowercase hex characters.
fn is_hex2(s: &str) -> bool {
    s.len() == 2 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

// ---------------------------------------------------------------------------
// Network operations
// ---------------------------------------------------------------------------

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

async fn get_default_interface() -> Result<String> {
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
    let del_link_args = ["link", "del", host_device];
    let del_ns_args = ["netns", "del", ns_name];
    let (link, netns) = tokio::join!(
        exec_ignore_errors_with_timeout("ip", &del_link_args, NETNS_COMMAND_TIMEOUT),
        exec_ignore_errors_with_timeout("ip", &del_ns_args, NETNS_COMMAND_TIMEOUT),
    );
    let outcome = NamespaceDeleteOutcome::from_best_effort([link, netns]);
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
fn acquire_pool_lock(locks: &LockPaths) -> Result<(u32, Flock<File>)> {
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
// NetnsPool
// ---------------------------------------------------------------------------

/// Pre-warmed pool of network namespaces for Firecracker VMs.
///
/// Maintains a buffer of `BUFFER_SIZE` ready namespaces per queue.
/// After each [`acquire`](Self::acquire), the pool spawns a background
/// task to replenish the buffer. Namespaces returned via
/// [`release`](Self::release) are recycled back into the queue.
pub struct NetnsPool {
    active: bool,
    plain_queue: VecDeque<NetnsInfo>,
    proxy_queue: VecDeque<NetnsInfo>,
    /// In-flight background namespace creation tasks (plain).
    pending_plain: HashSet<PendingId>,
    /// In-flight background namespace creation tasks (proxy).
    pending_proxy: HashSet<PendingId>,
    completion_tx: mpsc::UnboundedSender<CreationCompletion>,
    completion_rx: mpsc::UnboundedReceiver<CreationCompletion>,
    completion_generation: Arc<AtomicU64>,
    completion_wake_tx: watch::Sender<u64>,
    /// Namespaces checked out from this pool instance.
    in_flight: HashSet<String>,
    /// In-flight namespaces that must be deleted instead of reused.
    non_reusable: HashSet<String>,
    instance_id: u64,
    next_pending_id: u64,
    next_ns_index: u32,
    pool_index: u32,
    proxy_port: Option<u16>,
    dns_port: Option<u16>,
    default_iface: String,
    ops: NetnsLifecycleOps,
    #[cfg(test)]
    acquire_waiting_notify: Option<Arc<tokio::sync::Notify>>,
    /// Held for the lifetime of the pool to reserve the pool index.
    _lock: Flock<File>,
}

impl NetnsPool {
    fn completion_state() -> (
        mpsc::UnboundedSender<CreationCompletion>,
        mpsc::UnboundedReceiver<CreationCompletion>,
        Arc<AtomicU64>,
        watch::Sender<u64>,
    ) {
        let (completion_tx, completion_rx) = mpsc::unbounded_channel();
        let completion_generation = Arc::new(AtomicU64::new(0));
        let (completion_wake_tx, _) = watch::channel(0);
        (
            completion_tx,
            completion_rx,
            completion_generation,
            completion_wake_tx,
        )
    }

    #[cfg(test)]
    pub(crate) fn inactive_for_test() -> Self {
        let file = tempfile::tempfile().expect("create test netns pool lock file");
        let lock = match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => lock,
            Err((_, errno)) => panic!("lock test netns pool file: {errno}"),
        };
        let (completion_tx, completion_rx, completion_generation, completion_wake_tx) =
            Self::completion_state();

        Self {
            active: false,
            plain_queue: VecDeque::new(),
            proxy_queue: VecDeque::new(),
            pending_plain: HashSet::new(),
            pending_proxy: HashSet::new(),
            completion_tx,
            completion_rx,
            completion_generation,
            completion_wake_tx,
            in_flight: HashSet::new(),
            non_reusable: HashSet::new(),
            instance_id: next_pool_instance_id(),
            next_pending_id: 0,
            next_ns_index: 0,
            pool_index: 0,
            proxy_port: None,
            dns_port: None,
            default_iface: "test0".into(),
            ops: NetnsLifecycleOps::trusted_for_test(),
            acquire_waiting_notify: None,
            _lock: lock,
        }
    }

    #[cfg(test)]
    pub(crate) fn track_lease_for_test(&mut self, lease: &NetnsLease) {
        self.in_flight.insert(lease.name().to_string());
    }

    #[cfg(test)]
    pub(crate) fn lease_for_test(&self, name: &str) -> NetnsLease {
        NetnsLease::new(
            NetnsInfo::new(name.into(), "test-ve".into(), "10.200.0.2".into()),
            self.instance_id,
        )
    }

    /// Create a new pool with a small pre-warmed buffer.
    ///
    /// Pre-warms `BUFFER_SIZE` namespaces per queue at startup.
    /// After each [`acquire`](Self::acquire), the pool replenishes to
    /// maintain the buffer level. Namespaces returned via
    /// [`release`](Self::release) are recycled back into the queue.
    ///
    /// Automatically acquires a unique pool index (0–63) via flock. Enables
    /// host IP forwarding and reconciles orphaned resources from any idle
    /// pool index before creating new namespaces.
    pub async fn create(config: NetnsPoolConfig) -> Result<Self> {
        let config = config
            .into_checked()
            .map_err(|e| NetworkError::Prerequisite(e.to_string()))?;
        Self::create_checked(config).await
    }

    pub(crate) async fn create_checked(config: CheckedNetnsPoolConfig) -> Result<Self> {
        let config = config.inner;
        let lock_paths = LockPaths::new();
        let (index, lock) = acquire_pool_lock(&lock_paths)?;

        info!(index, buffer = BUFFER_SIZE, "initializing namespace pool");

        // Enable host-level IP forwarding (idempotent, needed once per host).
        exec_with_timeout(
            "sysctl",
            &["-w", "net.ipv4.ip_forward=1"],
            NETNS_COMMAND_TIMEOUT,
        )
        .await?;

        // Reconcile orphans from our own index and any idle pool index.
        // This is the correctness guarantee for kernel-side cleanup —
        // `NetnsPool::cleanup` is best-effort and cannot survive SIGKILL,
        // panic, OOM, or aborted in-flight creation tasks (issue #10625).
        reconcile_orphan_namespaces(&lock_paths, index, &lock).await;

        let default_iface = get_default_interface().await?;
        let (completion_tx, completion_rx, completion_generation, completion_wake_tx) =
            Self::completion_state();

        let mut pool = Self {
            active: true,
            plain_queue: VecDeque::with_capacity(BUFFER_SIZE),
            proxy_queue: VecDeque::with_capacity(if config.proxy_port.is_some() {
                BUFFER_SIZE
            } else {
                0
            }),
            pending_plain: HashSet::new(),
            pending_proxy: HashSet::new(),
            completion_tx,
            completion_rx,
            completion_generation,
            completion_wake_tx,
            in_flight: HashSet::new(),
            non_reusable: HashSet::new(),
            instance_id: next_pool_instance_id(),
            next_pending_id: 0,
            next_ns_index: 0,
            pool_index: index,
            proxy_port: config.proxy_port,
            dns_port: config.dns_port,
            default_iface,
            ops: NetnsLifecycleOps::default(),
            #[cfg(test)]
            acquire_waiting_notify: None,
            _lock: lock,
        };

        // Pre-warm the buffer. Warm-up starts at ns_index 0, so
        // `reconcile_orphan_namespaces` above MUST have finished
        // synchronously — otherwise `vm0-ns-{own}-00` may still exist from
        // a previous runner and `ip netns add` will fail with EEXIST.
        pool.spawn_initial_warmup();
        pool.drain_initial_warmup().await;

        info!(
            plain = pool.plain_queue.len(),
            proxy = pool.proxy_queue.len(),
            buffer = BUFFER_SIZE,
            "namespace pool initialized"
        );
        Ok(pool)
    }

    /// Acquire a namespace from the pool, or create one on-demand if empty.
    ///
    /// The direct API is kept for one-shot local users. Shared users should use
    /// `NetnsPoolHandle::acquire` so the mutex is not held while waiting for
    /// namespace creation.
    pub async fn acquire(&mut self) -> Result<NetnsLease> {
        loop {
            match self.prepare_acquire()? {
                AcquirePlan::Ready(lease) => return Ok(lease),
                AcquirePlan::Delete(namespaces, ops) => {
                    delete_namespaces_with_ops(ops, namespaces).await;
                }
                AcquirePlan::Wait(mut waiter) => {
                    if waiter.changed().await.is_err() {
                        return Err(NetworkError::Prerequisite(
                            "namespace creation notifier closed".into(),
                        ));
                    }
                }
            }
        }
    }

    fn reserve_ns_index(&mut self) -> Result<u32> {
        let ns_index = self.next_ns_index;
        if ns_index >= MAX_NAMESPACES {
            return Err(NetworkError::NamespaceLimitReached {
                max: MAX_NAMESPACES,
            });
        }
        self.next_ns_index += 1;
        Ok(ns_index)
    }

    fn reserve_pending_id(&mut self) -> PendingId {
        let id = PendingId(self.next_pending_id);
        self.next_pending_id += 1;
        id
    }

    fn creation_notifier(&self) -> CreationNotifier {
        CreationNotifier {
            tx: self.completion_tx.clone(),
            generation: Arc::clone(&self.completion_generation),
            wake_tx: self.completion_wake_tx.clone(),
            ops: self.ops.clone(),
        }
    }

    fn spawn_plain_creation(&mut self) -> Result<()> {
        self.spawn_creation(PendingKind::Plain)
    }

    fn spawn_proxy_creation(&mut self) -> Result<()> {
        self.spawn_creation(PendingKind::Proxy)
    }

    fn spawn_initial_warmup(&mut self) {
        if BUFFER_SIZE == 0 {
            return;
        }

        // Plain namespaces (connectivity only). Only needed when proxy
        // is disabled; with proxy configured, `acquire()` always routes
        // to the proxy queue, so plain entries would be unreachable
        // until `cleanup()`.
        if self.proxy_port.is_none() {
            for _ in 0..BUFFER_SIZE {
                if let Err(e) = self.spawn_plain_creation() {
                    warn!(error = %e, "failed to start initial namespace creation");
                    break;
                }
            }
        }

        // Proxy namespaces (connectivity + REDIRECT rules).
        if self.proxy_port.is_some() {
            for _ in 0..BUFFER_SIZE {
                if let Err(e) = self.spawn_proxy_creation() {
                    warn!(error = %e, "failed to start initial proxy namespace creation");
                    break;
                }
            }
        }
    }

    async fn drain_initial_warmup(&mut self) {
        loop {
            let mut waiter = if self.pending_plain.is_empty() && self.pending_proxy.is_empty() {
                None
            } else {
                Some(self.completion_wake_tx.subscribe())
            };

            let delete = self.drain_completed(true);
            if !delete.is_empty() {
                delete_namespaces_with_ops(self.ops.clone(), delete).await;
            }
            if self.pending_plain.is_empty() && self.pending_proxy.is_empty() {
                return;
            }

            let Some(waiter) = waiter.as_mut() else {
                continue;
            };
            if waiter.changed().await.is_err() {
                warn!("namespace creation notifier closed during initial warmup");
                return;
            }
        }
    }

    fn spawn_creation(&mut self, kind: PendingKind) -> Result<()> {
        let ns_index = self.reserve_ns_index()?;
        let pool_index = self.pool_index;
        let default_iface = self.default_iface.clone();
        let (proxy_port, dns_port) = match kind {
            PendingKind::Plain => (None, None),
            PendingKind::Proxy => {
                let Some(proxy_port) = self.proxy_port else {
                    return Err(NetworkError::Prerequisite(
                        "proxy namespace requested without proxy port".into(),
                    ));
                };
                (Some(proxy_port), self.dns_port)
            }
        };
        let id = self.reserve_pending_id();
        self.pending_set_mut(kind).insert(id);
        spawn_creation_worker(
            id,
            kind,
            self.creation_notifier(),
            create_single_namespace(pool_index, ns_index, default_iface, proxy_port, dns_port),
        );
        Ok(())
    }

    #[cfg(test)]
    fn spawn_plain_creation_for_test<F>(&mut self, future: F)
    where
        F: Future<Output = Result<NetnsInfo>> + Send + 'static,
    {
        let id = self.reserve_pending_id();
        self.pending_plain.insert(id);
        spawn_creation_worker(id, PendingKind::Plain, self.creation_notifier(), future);
    }

    fn checkout_or_requeue(&mut self, info: NetnsInfo, has_proxy: bool) -> Result<NetnsLease> {
        let name = info.name.clone();
        match self.checkout(info) {
            Ok(lease) => Ok(lease),
            Err(info) => {
                warn!(
                    name = %name,
                    has_proxy,
                    "namespace is already checked out; returning metadata to queue"
                );
                self.target_queue_mut(has_proxy).push_front(info);
                Err(NetworkError::InvalidLease(format!(
                    "namespace {name} is already checked out"
                )))
            }
        }
    }

    fn checkout(&mut self, info: NetnsInfo) -> std::result::Result<NetnsLease, NetnsInfo> {
        if !self.in_flight.insert(info.name.clone()) {
            return Err(info);
        }
        Ok(NetnsLease::new(info, self.instance_id))
    }

    fn drain_completed(&mut self, queue_when_inactive: bool) -> Vec<NetnsInfo> {
        let mut delete = Vec::new();
        while let Ok(completion) = self.completion_rx.try_recv() {
            self.apply_completion(completion, queue_when_inactive, &mut delete);
        }
        delete
    }

    fn apply_completion(
        &mut self,
        completion: CreationCompletion,
        queue_when_inactive: bool,
        delete: &mut Vec<NetnsInfo>,
    ) {
        if !self.pending_set_mut(completion.kind).remove(&completion.id) {
            warn!(
                id = completion.id.0,
                kind = ?completion.kind,
                "ignoring completion for unknown namespace creation task"
            );
            if let Ok(ns) = completion.result {
                delete.push(ns);
            }
            return;
        }

        match completion.result {
            Ok(ns) if self.active || queue_when_inactive => {
                self.target_queue_for_kind_mut(completion.kind)
                    .push_back(ns);
            }
            Ok(ns) => delete.push(ns),
            Err(e) => {
                error!(
                    id = completion.id.0,
                    kind = ?completion.kind,
                    error = %e,
                    "background namespace creation failed"
                );
            }
        }
    }

    fn prepare_acquire(&mut self) -> Result<AcquirePlan> {
        loop {
            if !self.active {
                return Err(NetworkError::PoolNotActive);
            }
            let delete = self.drain_completed(false);
            if !delete.is_empty() {
                return Ok(AcquirePlan::Delete(delete, self.ops.clone()));
            }
            if let Some(lease) = self.try_checkout_ready()? {
                return Ok(AcquirePlan::Ready(lease));
            }

            let kind = self.acquire_kind();
            if self.pending_set(kind).is_empty() {
                self.spawn_creation(kind)?;
            }

            let waiter = self.completion_wake_tx.subscribe();

            // Subscribe before the re-check to avoid missing a completion
            // between the decision to wait and dropping the outer mutex.
            let delete = self.drain_completed(false);
            if !delete.is_empty() {
                return Ok(AcquirePlan::Delete(delete, self.ops.clone()));
            }
            if !self.active {
                return Err(NetworkError::PoolNotActive);
            }
            if let Some(lease) = self.try_checkout_ready()? {
                return Ok(AcquirePlan::Ready(lease));
            }
            if self.pending_set(kind).is_empty() {
                continue;
            }

            #[cfg(test)]
            if let Some(notify) = &self.acquire_waiting_notify {
                notify.notify_one();
            }

            return Ok(AcquirePlan::Wait(waiter));
        }
    }

    fn try_checkout_ready(&mut self) -> Result<Option<NetnsLease>> {
        let has_proxy = self.proxy_port.is_some();
        let queue_len_after_pop;
        let pooled = if has_proxy {
            let pooled = self.proxy_queue.pop_front();
            queue_len_after_pop = self.proxy_queue.len();
            pooled
        } else {
            let pooled = self.plain_queue.pop_front();
            queue_len_after_pop = self.plain_queue.len();
            pooled
        };
        let Some(pooled) = pooled else {
            return Ok(None);
        };

        info!(
            name = %pooled.name,
            remaining = queue_len_after_pop,
            has_proxy,
            "acquired namespace"
        );
        let lease = self.checkout_or_requeue(pooled, has_proxy)?;
        self.maybe_replenish_kind(self.acquire_kind());
        Ok(Some(lease))
    }

    fn acquire_kind(&self) -> PendingKind {
        if self.proxy_port.is_some() {
            PendingKind::Proxy
        } else {
            PendingKind::Plain
        }
    }

    fn maybe_replenish_kind(&mut self, kind: PendingKind) {
        if matches!(kind, PendingKind::Proxy) && self.proxy_port.is_none() {
            return;
        }
        if self.target_queue_for_kind(kind).len() + self.pending_set(kind).len() >= BUFFER_SIZE
            || !self.pending_set(kind).is_empty()
            || self.next_ns_index >= MAX_NAMESPACES
        {
            return;
        }
        let result = match kind {
            PendingKind::Plain => self.spawn_plain_creation(),
            PendingKind::Proxy => self.spawn_proxy_creation(),
        };
        if let Err(e) = result {
            warn!(kind = ?kind, error = %e, "failed to replenish namespace pool");
        }
    }

    /// Return a namespace to the pool, or delete it if the pool is inactive.
    ///
    /// When `proxy_port` is configured, the namespace is returned to
    /// the proxy queue so its REDIRECT rules are reused.
    ///
    /// The caller keeps the lease in `Some` while this future awaits. Release
    /// only takes and disarms the lease at the final no-await commit point, so
    /// cancelling this future before success leaves cleanup ownership with the
    /// caller.
    pub async fn release(&mut self, lease: &mut Option<NetnsLease>) -> Result<()> {
        match self.release_outcome(lease).await {
            NetnsReleaseOutcome::Released
            | NetnsReleaseOutcome::Deleted
            | NetnsReleaseOutcome::Abandoned => Ok(()),
            NetnsReleaseOutcome::InvalidLease(message) => Err(NetworkError::InvalidLease(message)),
        }
    }

    async fn release_outcome(&mut self, lease: &mut Option<NetnsLease>) -> NetnsReleaseOutcome {
        let plan = match self.prepare_release(lease) {
            Ok(plan) => plan,
            Err(message) => return NetnsReleaseOutcome::InvalidLease(message),
        };
        if plan.active_at_prepare {
            self.mark_non_reusable(&plan);
        }

        let can_requeue = if plan.active_at_prepare {
            (plan.ops.flush_conntrack)(plan.info.peer_ip.clone())
                .await
                .is_trusted()
        } else {
            false
        };

        if can_requeue && self.active {
            return self.commit_release_requeue(lease, &plan);
        }

        let delete = (plan.ops.delete_namespace)(plan.info.clone()).await;
        self.commit_release_delete(lease, &plan, delete)
    }

    fn prepare_release(
        &self,
        lease: &Option<NetnsLease>,
    ) -> std::result::Result<ReleasePlan, String> {
        let Some(active_lease) = lease.as_ref() else {
            return Err("missing netns lease".into());
        };
        if active_lease.pool_instance_id() != self.instance_id {
            warn!(
                name = %active_lease.name(),
                lease_pool_instance_id = active_lease.pool_instance_id(),
                pool_instance_id = self.instance_id,
                "refusing to release netns lease from a different pool instance"
            );
            return Err(format!(
                "namespace {} belongs to pool instance {}, not {}",
                active_lease.name(),
                active_lease.pool_instance_id(),
                self.instance_id
            ));
        }
        if !self.in_flight.contains(active_lease.name()) {
            warn!(
                name = %active_lease.name(),
                pool_instance_id = self.instance_id,
                "refusing to release netns lease that is not in flight"
            );
            return Err(format!(
                "namespace {} is not checked out",
                active_lease.name()
            ));
        }

        let has_proxy = self.proxy_port.is_some();
        let reusable = self.active && !self.non_reusable.contains(active_lease.name());
        if reusable
            && self
                .target_queue(has_proxy)
                .iter()
                .any(|r| r.name == active_lease.name())
        {
            warn!(
                name = %active_lease.name(),
                "refusing to release netns lease already queued in pool"
            );
            return Err(format!(
                "namespace {} is already queued",
                active_lease.name()
            ));
        }

        Ok(ReleasePlan {
            info: active_lease.info().clone(),
            has_proxy,
            active_at_prepare: reusable,
            ops: self.ops.clone(),
        })
    }

    fn mark_non_reusable(&mut self, plan: &ReleasePlan) {
        if self.in_flight.contains(&plan.info.name) {
            self.non_reusable.insert(plan.info.name.clone());
        }
    }

    fn commit_release_requeue(
        &mut self,
        lease: &mut Option<NetnsLease>,
        plan: &ReleasePlan,
    ) -> NetnsReleaseOutcome {
        let Some(lease) = lease.take() else {
            return NetnsReleaseOutcome::InvalidLease("validated netns lease disappeared".into());
        };
        self.in_flight.remove(lease.name());
        self.non_reusable.remove(lease.name());
        let ns = lease.into_info();

        let target_queue = if plan.has_proxy {
            &mut self.proxy_queue
        } else {
            &mut self.plain_queue
        };

        info!(
            name = %ns.name,
            available = target_queue.len() + 1,
            has_proxy = plan.has_proxy,
            "namespace released"
        );
        target_queue.push_back(ns);
        NetnsReleaseOutcome::Released
    }

    fn commit_release_delete(
        &mut self,
        lease: &mut Option<NetnsLease>,
        _plan: &ReleasePlan,
        delete: NamespaceDeleteOutcome,
    ) -> NetnsReleaseOutcome {
        let Some(lease) = lease.take() else {
            return NetnsReleaseOutcome::InvalidLease("validated netns lease disappeared".into());
        };
        self.in_flight.remove(lease.name());
        self.non_reusable.remove(lease.name());
        let ns = lease.into_info();
        match delete {
            NamespaceDeleteOutcome::Deleted => {
                info!(name = %ns.name, "namespace lease deleted instead of requeued");
                NetnsReleaseOutcome::Deleted
            }
            NamespaceDeleteOutcome::Abandoned => {
                warn!(
                    name = %ns.name,
                    host_device = %ns.host_device,
                    "namespace release abandoned after cleanup failure; startup orphan reconciliation will retry"
                );
                NetnsReleaseOutcome::Abandoned
            }
        }
    }

    fn target_queue(&self, has_proxy: bool) -> &VecDeque<NetnsInfo> {
        if has_proxy {
            &self.proxy_queue
        } else {
            &self.plain_queue
        }
    }

    fn target_queue_mut(&mut self, has_proxy: bool) -> &mut VecDeque<NetnsInfo> {
        if has_proxy {
            &mut self.proxy_queue
        } else {
            &mut self.plain_queue
        }
    }

    fn target_queue_for_kind(&self, kind: PendingKind) -> &VecDeque<NetnsInfo> {
        match kind {
            PendingKind::Plain => &self.plain_queue,
            PendingKind::Proxy => &self.proxy_queue,
        }
    }

    fn target_queue_for_kind_mut(&mut self, kind: PendingKind) -> &mut VecDeque<NetnsInfo> {
        match kind {
            PendingKind::Plain => &mut self.plain_queue,
            PendingKind::Proxy => &mut self.proxy_queue,
        }
    }

    fn pending_set(&self, kind: PendingKind) -> &HashSet<PendingId> {
        match kind {
            PendingKind::Plain => &self.pending_plain,
            PendingKind::Proxy => &self.pending_proxy,
        }
    }

    fn pending_set_mut(&mut self, kind: PendingKind) -> &mut HashSet<PendingId> {
        match kind {
            PendingKind::Plain => &mut self.pending_plain,
            PendingKind::Proxy => &mut self.pending_proxy,
        }
    }

    /// Delete all namespaces currently in the pool queue and wait for
    /// in-flight background creation tasks so their resources can be deleted.
    ///
    /// Namespaces that have been acquired but not yet released are **not**
    /// cleaned up here — they will be caught by orphan cleanup on the next
    /// [`NetnsPool::create`] call with the same index.
    pub async fn cleanup(&mut self) -> Result<()> {
        loop {
            let plan = self.prepare_cleanup();
            if plan.done {
                info!("namespace pool cleanup complete");
                return Ok(());
            }

            let names = cleanup_namespace_names(&plan.namespaces);
            delete_namespaces_with_ops(plan.ops, plan.namespaces).await;
            self.remove_queued_namespaces(&names);

            if let Some(mut waiter) = plan.wait_for_pending
                && waiter.changed().await.is_err()
            {
                return Err(NetworkError::Prerequisite(
                    "namespace creation notifier closed".into(),
                ));
            }
        }
    }

    fn prepare_cleanup(&mut self) -> CleanupPlan {
        self.active = false;
        if !self.in_flight.is_empty() {
            warn!(
                in_flight = self.in_flight.len(),
                "namespace pool cleanup with outstanding leases"
            );
        }

        let mut namespaces = self.drain_completed(true);
        let mut wait_for_pending = if self.pending_plain.is_empty() && self.pending_proxy.is_empty()
        {
            None
        } else {
            Some(self.completion_wake_tx.subscribe())
        };
        namespaces.extend(self.drain_completed(true));
        if self.pending_plain.is_empty() && self.pending_proxy.is_empty() {
            wait_for_pending = None;
        }

        namespaces.extend(
            self.plain_queue
                .iter()
                .chain(self.proxy_queue.iter())
                .cloned(),
        );
        CleanupPlan {
            done: namespaces.is_empty() && wait_for_pending.is_none(),
            namespaces,
            ops: self.ops.clone(),
            wait_for_pending,
        }
    }

    fn remove_queued_namespaces(&mut self, names: &HashSet<String>) {
        self.plain_queue.retain(|ns| !names.contains(&ns.name));
        self.proxy_queue.retain(|ns| !names.contains(&ns.name));
    }

    #[cfg(test)]
    async fn delete_queued_namespaces_with<F, Fut>(queue: &mut VecDeque<NetnsInfo>, mut delete: F)
    where
        F: FnMut(NetnsInfo) -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        while let Some(ns) = queue.front().cloned() {
            delete(ns).await;
            queue.pop_front();
        }
    }
}

impl Drop for NetnsPool {
    fn drop(&mut self) {
        let queued = self.plain_queue.len() + self.proxy_queue.len();
        let pending = self.pending_plain.len() + self.pending_proxy.len();
        if self.active || queued != 0 || pending != 0 || !self.in_flight.is_empty() {
            warn!(
                active = self.active,
                queued,
                pending,
                in_flight = self.in_flight.len(),
                "NetnsPool dropped without calling cleanup()"
            );
        }
    }
}

impl NetnsPoolHandle {
    pub(crate) async fn create_checked(config: CheckedNetnsPoolConfig) -> Result<Self> {
        Ok(Self::new(NetnsPool::create_checked(config).await?))
    }

    pub(crate) fn new(pool: NetnsPool) -> Self {
        Self {
            inner: Arc::new(tokio::sync::Mutex::new(pool)),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(pool: NetnsPool) -> Self {
        Self::new(pool)
    }

    #[cfg(test)]
    pub(crate) fn strong_count_for_test(&self) -> usize {
        Arc::strong_count(&self.inner)
    }

    pub(crate) async fn acquire(&self) -> Result<NetnsLease> {
        loop {
            let plan = {
                let mut pool = self.inner.lock().await;
                pool.prepare_acquire()?
            };
            match plan {
                AcquirePlan::Ready(lease) => return Ok(lease),
                AcquirePlan::Delete(namespaces, ops) => {
                    delete_namespaces_with_ops(ops, namespaces).await;
                }
                AcquirePlan::Wait(mut waiter) => {
                    if waiter.changed().await.is_err() {
                        return Err(NetworkError::Prerequisite(
                            "namespace creation notifier closed".into(),
                        ));
                    }
                }
            }
        }
    }

    pub(crate) async fn release(&self, lease: &mut Option<NetnsLease>) -> NetnsReleaseOutcome {
        let plan = {
            let mut pool = self.inner.lock().await;
            let plan = match pool.prepare_release(lease) {
                Ok(plan) => plan,
                Err(message) => return NetnsReleaseOutcome::InvalidLease(message),
            };
            if plan.active_at_prepare {
                pool.mark_non_reusable(&plan);
            }
            plan
        };

        let can_requeue = if plan.active_at_prepare {
            (plan.ops.flush_conntrack)(plan.info.peer_ip.clone())
                .await
                .is_trusted()
        } else {
            false
        };

        if can_requeue {
            {
                let mut pool = self.inner.lock().await;
                if pool.active {
                    return pool.commit_release_requeue(lease, &plan);
                }
            }
        }

        let delete = (plan.ops.delete_namespace)(plan.info.clone()).await;
        let mut pool = self.inner.lock().await;
        pool.commit_release_delete(lease, &plan, delete)
    }

    pub(crate) async fn cleanup(&self) -> Result<()> {
        loop {
            let plan = {
                let mut pool = self.inner.lock().await;
                pool.prepare_cleanup()
            };
            if plan.done {
                info!("namespace pool cleanup complete");
                return Ok(());
            }

            let names = cleanup_namespace_names(&plan.namespaces);
            delete_namespaces_with_ops(plan.ops, plan.namespaces).await;
            {
                let mut pool = self.inner.lock().await;
                pool.remove_queued_namespaces(&names);
            }

            if let Some(mut waiter) = plan.wait_for_pending
                && waiter.changed().await.is_err()
            {
                return Err(NetworkError::Prerequisite(
                    "namespace creation notifier closed".into(),
                ));
            }
        }
    }
}

fn spawn_creation_worker<F>(id: PendingId, kind: PendingKind, notifier: CreationNotifier, future: F)
where
    F: Future<Output = Result<NetnsInfo>> + Send + 'static,
{
    let worker = tokio::spawn(future);
    tokio::spawn(async move {
        let result = match worker.await {
            Ok(result) => result,
            Err(e) => Err(join_error_to_creation_error(e, kind)),
        };
        notifier.send(CreationCompletion { id, kind, result }).await;
    });
}

fn join_error_to_creation_error(e: tokio::task::JoinError, kind: PendingKind) -> NetworkError {
    if e.is_panic() {
        NetworkError::Prerequisite(format!("{kind:?} namespace creation task panicked: {e}"))
    } else {
        NetworkError::Prerequisite(format!("{kind:?} namespace creation task cancelled: {e}"))
    }
}

async fn delete_namespaces_with_ops(ops: NetnsLifecycleOps, namespaces: Vec<NetnsInfo>) {
    let count = namespaces.len();
    if count > 0 {
        info!(count, "cleaning up namespace pool entries");
    }
    for ns in namespaces {
        let outcome = (ops.delete_namespace)(ns.clone()).await;
        if matches!(outcome, NamespaceDeleteOutcome::Abandoned) {
            warn!(
                name = %ns.name,
                host_device = %ns.host_device,
                "namespace cleanup was abandoned; startup orphan reconciliation will retry"
            );
        }
    }
}

fn cleanup_namespace_names(namespaces: &[NetnsInfo]) -> HashSet<String> {
    namespaces.iter().map(|ns| ns.name.clone()).collect()
}

// ---------------------------------------------------------------------------
// Namespace creation
// ---------------------------------------------------------------------------

/// Create a single namespace with full connectivity, optionally adding proxy
/// REDIRECT rules for HTTP/HTTPS traffic.
///
/// This is a free function (no `&self`) so it can be spawned on a `JoinSet`.
async fn create_single_namespace(
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
    sn: &super::GuestNetwork,
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
/// Deletes orphaned host iptables rules first (catches rules left behind even
/// if the namespace was already removed), then discovers and deletes remaining
/// namespaces and their veth devices.
pub async fn cleanup_namespaces_by_index(index: u32) {
    let idx_str = format_hex_index(index);
    let prefix = format!("{NS_PREFIX}{idx_str}-");

    // 1. Clean orphaned host iptables rules whose comment matches this pool index.
    //    The Rust-side `contains()` does substring matching, so the prefix matches
    //    all namespaces in this pool. This catches rules left behind even if the
    //    namespace itself was already deleted.
    delete_iptables_rules_by_comment(&prefix).await;

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
            if let Some((pi, ni)) = parse_ns_name(&ns_name) {
                let host_device = make_host_device(pi, ni);
                delete_namespace_resources(&ns_name, &host_device).await;
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
async fn reconcile_orphan_namespaces(locks: &LockPaths, own_index: u32, _own_lock: &Flock<File>) {
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
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    async fn blocking_plain_creation(
        name: &'static str,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    ) -> Result<NetnsInfo> {
        entered.notify_one();
        release.notified().await;
        Ok(test_info(name))
    }

    #[test]
    fn format_hex_index_zero() {
        assert_eq!(format_hex_index(0), "00");
    }

    #[test]
    fn format_hex_index_single_digit() {
        assert_eq!(format_hex_index(10), "0a");
    }

    #[test]
    fn format_hex_index_two_digits() {
        assert_eq!(format_hex_index(63), "3f");
    }

    #[test]
    fn make_ns_name_formats_correctly() {
        assert_eq!(make_ns_name("00", "0a"), "vm0-ns-00-0a");
    }

    #[test]
    fn make_host_device_formats_correctly() {
        assert_eq!(make_host_device("01", "ff"), "vm0-ve-01-ff");
    }

    #[test]
    fn generate_veth_ip_pair_first_namespace() {
        let (host, peer) = generate_veth_ip_pair(0, 0);
        assert_eq!(host, "10.200.0.1");
        assert_eq!(peer, "10.200.0.2");
    }

    #[test]
    fn generate_veth_ip_pair_second_namespace() {
        let (host, peer) = generate_veth_ip_pair(0, 1);
        assert_eq!(host, "10.200.0.5");
        assert_eq!(peer, "10.200.0.6");
    }

    #[test]
    fn generate_veth_ip_pair_crosses_octet3_boundary() {
        // ns_index=64 → octet3 bumps by 1
        let (host, peer) = generate_veth_ip_pair(0, 64);
        assert_eq!(host, "10.200.1.1");
        assert_eq!(peer, "10.200.1.2");
    }

    #[test]
    fn generate_veth_ip_pair_second_pool() {
        let (host, peer) = generate_veth_ip_pair(1, 0);
        assert_eq!(host, "10.200.4.1");
        assert_eq!(peer, "10.200.4.2");
    }

    #[test]
    fn generate_veth_ip_pair_max_values() {
        let (host, peer) = generate_veth_ip_pair(63, 255);
        assert_eq!(host, "10.200.255.253");
        assert_eq!(peer, "10.200.255.254");
    }

    #[test]
    fn generate_veth_ip_pair_no_overlap_across_pools() {
        let (host_0_last, _) = generate_veth_ip_pair(0, 255);
        let (host_1_first, _) = generate_veth_ip_pair(1, 0);
        assert_ne!(host_0_last, host_1_first);
    }

    #[test]
    fn generate_veth_ip_pair_no_overlap_within_pool() {
        let mut seen = std::collections::HashSet::new();
        for ns in 0..MAX_NAMESPACES {
            let (host, peer) = generate_veth_ip_pair(0, ns);
            assert!(seen.insert(host.clone()), "duplicate host IP: {host}");
            assert!(seen.insert(peer.clone()), "duplicate peer IP: {peer}");
        }
    }

    #[test]
    fn parse_ns_name_valid() {
        assert_eq!(parse_ns_name("vm0-ns-00-0a"), Some(("00", "0a")));
        assert_eq!(parse_ns_name("vm0-ns-3f-ff"), Some(("3f", "ff")));
    }

    #[test]
    fn parse_ns_name_wrong_prefix() {
        assert_eq!(parse_ns_name("other-00-0a"), None);
    }

    #[test]
    fn parse_ns_name_missing_separator() {
        assert_eq!(parse_ns_name("vm0-ns-000a"), None);
    }

    #[test]
    fn parse_ns_name_empty_parts() {
        assert_eq!(parse_ns_name("vm0-ns--0a"), None);
        assert_eq!(parse_ns_name("vm0-ns-00-"), None);
    }

    #[test]
    fn names_roundtrip() {
        let pool_idx = format_hex_index(5);
        let ns_idx = format_hex_index(42);
        let name = make_ns_name(&pool_idx, &ns_idx);
        let (pi, ni) = parse_ns_name(&name).expect("should parse");
        assert_eq!(pi, "05");
        assert_eq!(ni, "2a");
        assert_eq!(make_host_device(pi, ni), "vm0-ve-05-2a");
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
    fn generate_veth_ip_pair_no_overlap_all_pools() {
        let mut seen = std::collections::HashSet::new();
        for pool in 0..MAX_POOLS {
            for ns in 0..MAX_NAMESPACES {
                let (host, peer) = generate_veth_ip_pair(pool, ns);
                assert!(
                    seen.insert(host.clone()),
                    "dup host: {host} (pool={pool}, ns={ns})"
                );
                assert!(
                    seen.insert(peer.clone()),
                    "dup peer: {peer} (pool={pool}, ns={ns})"
                );
            }
        }
        // 64 pools × 256 ns × 2 addrs = 32768 unique IPs
        assert_eq!(seen.len(), 32768);
    }

    #[test]
    fn generate_veth_ip_pair_valid_slash30_alignment() {
        // In a /30 subnet: base is divisible by 4, host=base+1, peer=base+2
        for pool in [0, 1, 31, 63] {
            for ns in [0, 1, 63, 64, 127, 128, 255] {
                let (host, peer) = generate_veth_ip_pair(pool, ns);
                let host_octet4: u32 = host.rsplit('.').next().unwrap().parse().unwrap();
                let peer_octet4: u32 = peer.rsplit('.').next().unwrap().parse().unwrap();
                assert_eq!(
                    host_octet4 % 4,
                    1,
                    "host octet4 {host_octet4} not base+1 (pool={pool}, ns={ns})"
                );
                assert_eq!(
                    peer_octet4 % 4,
                    2,
                    "peer octet4 {peer_octet4} not base+2 (pool={pool}, ns={ns})"
                );
                assert_eq!(peer_octet4, host_octet4 + 1);
            }
        }
    }

    #[test]
    fn generate_veth_ip_pair_octets_in_range() {
        for pool in 0..MAX_POOLS {
            for ns in 0..MAX_NAMESPACES {
                let (host, _) = generate_veth_ip_pair(pool, ns);
                let octets: Vec<u32> = host.split('.').map(|o| o.parse().unwrap()).collect();
                assert_eq!(octets[0], 10);
                assert_eq!(octets[1], 200);
                assert!(
                    octets[2] <= 255,
                    "octet3 out of range: {} (pool={pool}, ns={ns})",
                    octets[2]
                );
                assert!(
                    octets[3] <= 255,
                    "octet4 out of range: {} (pool={pool}, ns={ns})",
                    octets[3]
                );
            }
        }
    }

    #[test]
    fn parse_ns_name_extra_hyphens_rejected() {
        // Rejects malformed names that could produce device names exceeding IFNAMSIZ
        assert_eq!(parse_ns_name("vm0-ns-00-0a-extra"), None);
    }

    #[test]
    fn parse_ns_name_bare_prefix() {
        assert_eq!(parse_ns_name("vm0-ns-"), None);
    }

    fn test_info(name: &str) -> NetnsInfo {
        NetnsInfo::new(name.into(), "test-ve".into(), "10.200.0.2".into())
    }

    #[tokio::test]
    async fn shared_acquire_does_not_hold_mutex_while_creation_is_pending() {
        let waiting = Arc::new(tokio::sync::Notify::new());
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        pool.next_ns_index = MAX_NAMESPACES;
        pool.acquire_waiting_notify = Some(Arc::clone(&waiting));
        pool.spawn_plain_creation_for_test(blocking_plain_creation(
            "test-ns",
            Arc::clone(&entered),
            Arc::clone(&release),
        ));
        let handle = NetnsPoolHandle::new_for_test(pool);

        let acquire = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        entered.notified().await;
        waiting.notified().await;

        let guard = handle
            .inner
            .try_lock()
            .expect("shared acquire must not hold netns pool mutex while waiting");
        drop(guard);

        release.notify_one();
        let mut lease = Some(acquire.await.unwrap().unwrap());
        assert_eq!(lease.as_ref().unwrap().name(), "test-ns");
        let outcome = handle.release(&mut lease).await;
        assert!(matches!(outcome, NetnsReleaseOutcome::Released));
        handle.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn shared_acquire_cancellation_preserves_completed_creation() {
        let waiting = Arc::new(tokio::sync::Notify::new());
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        pool.next_ns_index = MAX_NAMESPACES;
        pool.acquire_waiting_notify = Some(Arc::clone(&waiting));
        pool.spawn_plain_creation_for_test(blocking_plain_creation(
            "test-ns",
            Arc::clone(&entered),
            Arc::clone(&release),
        ));
        let handle = NetnsPoolHandle::new_for_test(pool);

        let acquire = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        entered.notified().await;
        waiting.notified().await;
        acquire.abort();
        let _ = acquire.await;

        release.notify_one();
        let mut lease = Some(handle.acquire().await.unwrap());
        assert_eq!(lease.as_ref().unwrap().name(), "test-ns");

        let outcome = handle.release(&mut lease).await;
        assert!(matches!(outcome, NetnsReleaseOutcome::Released));
        handle.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn creation_worker_panic_clears_pending_during_cleanup() {
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        pool.spawn_plain_creation_for_test(async {
            panic!("creation panic for test");
            #[allow(unreachable_code)]
            Ok(test_info("never"))
        });
        let handle = NetnsPoolHandle::new_for_test(pool);

        handle.cleanup().await.unwrap();

        let pool = handle.inner.lock().await;
        assert!(pool.pending_plain.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn completion_send_failure_deletes_created_namespace() {
        let deleted = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPool::inactive_for_test();
        let deleted_for_ops = Arc::clone(&deleted);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_namespace: Arc::new(move |_| {
                let deleted = Arc::clone(&deleted_for_ops);
                Box::pin(async move {
                    deleted.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let notifier = pool.creation_notifier();
        drop(pool);

        notifier
            .send(CreationCompletion {
                id: PendingId(0),
                kind: PendingKind::Plain,
                result: Ok(test_info("orphan-ns")),
            })
            .await;

        assert_eq!(deleted.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cleanup_deletes_unknown_completed_namespace() {
        let deleted = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        let deleted_for_ops = Arc::clone(&deleted);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_namespace: Arc::new(move |_| {
                let deleted = Arc::clone(&deleted_for_ops);
                Box::pin(async move {
                    deleted.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        pool.completion_tx
            .send(CreationCompletion {
                id: PendingId(999),
                kind: PendingKind::Plain,
                result: Ok(test_info("unknown-ns")),
            })
            .unwrap();

        pool.cleanup().await.unwrap();

        assert_eq!(deleted.load(Ordering::SeqCst), 1);
        assert!(pool.plain_queue.is_empty());
        assert!(pool.proxy_queue.is_empty());
    }

    #[tokio::test]
    async fn dropped_pool_deletes_late_pending_creation() {
        let release = Arc::new(tokio::sync::Notify::new());
        let deleted = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPool::inactive_for_test();
        let deleted_for_ops = Arc::clone(&deleted);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_namespace: Arc::new(move |_| {
                let deleted = Arc::clone(&deleted_for_ops);
                Box::pin(async move {
                    deleted.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        pool.spawn_plain_creation_for_test({
            let release = Arc::clone(&release);
            async move {
                release.notified().await;
                Ok(test_info("late-ns"))
            }
        });

        drop(pool);
        release.notify_one();

        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while deleted.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("late pending namespace should be deleted after pool drop");
    }

    #[tokio::test]
    async fn cleanup_rejects_acquire_and_deletes_late_completion() {
        let release = Arc::new(tokio::sync::Notify::new());
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        let delete_count_for_ops = Arc::clone(&delete_count);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                Box::pin(async move {
                    delete_count.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        pool.spawn_plain_creation_for_test({
            let release = Arc::clone(&release);
            async move {
                release.notified().await;
                Ok(test_info("late-ns"))
            }
        });
        let handle = NetnsPoolHandle::new_for_test(pool);

        let cleanup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.cleanup().await }
        });
        loop {
            if !handle.inner.lock().await.active {
                break;
            }
            tokio::task::yield_now().await;
        }

        let err = handle.acquire().await.unwrap_err();
        assert!(matches!(err, NetworkError::PoolNotActive));

        release.notify_one();
        cleanup.await.unwrap().unwrap();
        let pool = handle.inner.lock().await;
        assert!(pool.pending_plain.is_empty());
        assert!(pool.plain_queue.is_empty());
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn shared_release_does_not_hold_mutex_while_flush_blocks() {
        let flush_entered = Arc::new(tokio::sync::Notify::new());
        let flush_release = Arc::new(tokio::sync::Notify::new());
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        let flush_entered_for_ops = Arc::clone(&flush_entered);
        let flush_release_for_ops = Arc::clone(&flush_release);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |_| {
                let flush_entered = Arc::clone(&flush_entered_for_ops);
                let flush_release = Arc::clone(&flush_release_for_ops);
                Box::pin(async move {
                    flush_entered.notify_one();
                    flush_release.notified().await;
                    ConntrackFlushOutcome::Trusted
                })
            }),
            delete_namespace: Arc::new(|_| Box::pin(async { NamespaceDeleteOutcome::Deleted })),
        };
        let lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::new_for_test(pool);

        let release_task = tokio::spawn({
            let handle = handle.clone();
            async move {
                let mut lease = lease;
                let outcome = handle.release(&mut lease).await;
                (outcome, lease)
            }
        });
        flush_entered.notified().await;

        let guard = handle
            .inner
            .try_lock()
            .expect("shared release must not hold netns pool mutex while flushing conntrack");
        drop(guard);

        flush_release.notify_one();
        let (outcome, lease) = release_task.await.unwrap();
        assert!(matches!(outcome, NetnsReleaseOutcome::Released));
        assert!(lease.is_none());
        handle.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn shared_release_deletes_when_cleanup_races_after_flush_started() {
        let flush_entered = Arc::new(tokio::sync::Notify::new());
        let flush_release = Arc::new(tokio::sync::Notify::new());
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        let flush_entered_for_ops = Arc::clone(&flush_entered);
        let flush_release_for_ops = Arc::clone(&flush_release);
        let delete_count_for_ops = Arc::clone(&delete_count);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |_| {
                let flush_entered = Arc::clone(&flush_entered_for_ops);
                let flush_release = Arc::clone(&flush_release_for_ops);
                Box::pin(async move {
                    flush_entered.notify_one();
                    flush_release.notified().await;
                    ConntrackFlushOutcome::Trusted
                })
            }),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                Box::pin(async move {
                    delete_count.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::new_for_test(pool);

        let release_task = tokio::spawn({
            let handle = handle.clone();
            async move {
                let mut lease = lease;
                let outcome = handle.release(&mut lease).await;
                (outcome, lease)
            }
        });
        flush_entered.notified().await;

        handle.cleanup().await.unwrap();
        flush_release.notify_one();
        let (outcome, lease) = release_task.await.unwrap();

        assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
        assert!(lease.is_none());
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        let pool = handle.inner.lock().await;
        assert!(!pool.active);
        assert!(pool.in_flight.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn cancelled_release_during_flush_marks_namespace_non_reusable_for_retry() {
        let flush_entered = Arc::new(tokio::sync::Notify::new());
        let first_flush_release = Arc::new(tokio::sync::Notify::new());
        let flush_count = Arc::new(AtomicUsize::new(0));
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        let flush_entered_for_ops = Arc::clone(&flush_entered);
        let first_flush_release_for_ops = Arc::clone(&first_flush_release);
        let flush_count_for_ops = Arc::clone(&flush_count);
        let delete_count_for_ops = Arc::clone(&delete_count);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |_| {
                let flush_entered = Arc::clone(&flush_entered_for_ops);
                let first_flush_release = Arc::clone(&first_flush_release_for_ops);
                let flush_count = Arc::clone(&flush_count_for_ops);
                Box::pin(async move {
                    let attempt = flush_count.fetch_add(1, Ordering::SeqCst);
                    if attempt == 0 {
                        flush_entered.notify_one();
                        first_flush_release.notified().await;
                    }
                    ConntrackFlushOutcome::Trusted
                })
            }),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                Box::pin(async move {
                    delete_count.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::new_for_test(pool);

        {
            let release = handle.release(&mut lease);
            tokio::pin!(release);
            tokio::select! {
                outcome = &mut release => panic!("release completed before flush was cancelled: {outcome:?}"),
                _ = flush_entered.notified() => {}
            }
        }

        assert!(lease.is_some());
        assert_eq!(flush_count.load(Ordering::SeqCst), 1);
        {
            let pool = handle.inner.lock().await;
            assert!(pool.non_reusable.contains("test-ns"));
        }

        first_flush_release.notify_one();
        let outcome = handle.release(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
        assert!(lease.is_none());
        assert_eq!(
            flush_count.load(Ordering::SeqCst),
            1,
            "cancelled flush must taint the namespace before retry"
        );
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        let pool = handle.inner.lock().await;
        assert!(pool.non_reusable.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn release_cancelled_after_trusted_flush_before_commit_deletes_on_retry() {
        let flush_entered = Arc::new(tokio::sync::Notify::new());
        let first_flush_release = Arc::new(tokio::sync::Notify::new());
        let flush_count = Arc::new(AtomicUsize::new(0));
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        let flush_entered_for_ops = Arc::clone(&flush_entered);
        let first_flush_release_for_ops = Arc::clone(&first_flush_release);
        let flush_count_for_ops = Arc::clone(&flush_count);
        let delete_count_for_ops = Arc::clone(&delete_count);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |_| {
                let flush_entered = Arc::clone(&flush_entered_for_ops);
                let first_flush_release = Arc::clone(&first_flush_release_for_ops);
                let flush_count = Arc::clone(&flush_count_for_ops);
                Box::pin(async move {
                    let attempt = flush_count.fetch_add(1, Ordering::SeqCst);
                    if attempt == 0 {
                        flush_entered.notify_one();
                        first_flush_release.notified().await;
                    }
                    ConntrackFlushOutcome::Trusted
                })
            }),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                Box::pin(async move {
                    delete_count.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::new_for_test(pool);

        let mut release = Box::pin(handle.release(&mut lease));
        tokio::select! {
            outcome = &mut release => panic!("release completed before flush finished: {outcome:?}"),
            _ = flush_entered.notified() => {}
        }
        let guard = handle.inner.lock().await;
        first_flush_release.notify_one();
        tokio::select! {
            outcome = &mut release => panic!("release completed while pool lock was held: {outcome:?}"),
            _ = tokio::task::yield_now() => {}
        }
        assert!(guard.non_reusable.contains("test-ns"));
        drop(release);

        assert!(lease.is_some());
        assert_eq!(flush_count.load(Ordering::SeqCst), 1);
        drop(guard);

        let outcome = handle.release(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
        assert!(lease.is_none());
        assert_eq!(
            flush_count.load(Ordering::SeqCst),
            1,
            "cancelled post-flush commit must not flush/requeue on retry"
        );
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        let pool = handle.inner.lock().await;
        assert!(pool.non_reusable.is_empty());
        assert!(pool.in_flight.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn direct_release_cancelled_during_flush_marks_namespace_non_reusable_for_retry() {
        let flush_entered = Arc::new(tokio::sync::Notify::new());
        let first_flush_release = Arc::new(tokio::sync::Notify::new());
        let flush_count = Arc::new(AtomicUsize::new(0));
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        let flush_entered_for_ops = Arc::clone(&flush_entered);
        let first_flush_release_for_ops = Arc::clone(&first_flush_release);
        let flush_count_for_ops = Arc::clone(&flush_count);
        let delete_count_for_ops = Arc::clone(&delete_count);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |_| {
                let flush_entered = Arc::clone(&flush_entered_for_ops);
                let first_flush_release = Arc::clone(&first_flush_release_for_ops);
                let flush_count = Arc::clone(&flush_count_for_ops);
                Box::pin(async move {
                    let attempt = flush_count.fetch_add(1, Ordering::SeqCst);
                    if attempt == 0 {
                        flush_entered.notify_one();
                        first_flush_release.notified().await;
                    }
                    ConntrackFlushOutcome::Trusted
                })
            }),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                Box::pin(async move {
                    delete_count.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());

        {
            let release = pool.release(&mut lease);
            tokio::pin!(release);
            tokio::select! {
                result = &mut release => panic!("release completed before flush was cancelled: {result:?}"),
                _ = flush_entered.notified() => {}
            }
        }

        assert!(lease.is_some());
        assert_eq!(flush_count.load(Ordering::SeqCst), 1);
        assert!(pool.non_reusable.contains("test-ns"));

        first_flush_release.notify_one();
        pool.release(&mut lease).await.unwrap();

        assert!(lease.is_none());
        assert_eq!(
            flush_count.load(Ordering::SeqCst),
            1,
            "direct cancelled flush must taint the namespace before retry"
        );
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        assert!(pool.non_reusable.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn untrusted_conntrack_flush_deletes_without_requeue() {
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        let delete_count_for_ops = Arc::clone(&delete_count);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Untrusted })),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                Box::pin(async move {
                    delete_count.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::new_for_test(pool);

        let outcome = handle.release(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
        assert!(lease.is_none());
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        let pool = handle.inner.lock().await;
        assert!(pool.in_flight.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn cancelled_untrusted_release_marks_namespace_non_reusable_for_retry() {
        let delete_entered = Arc::new(tokio::sync::Notify::new());
        let first_delete_release = Arc::new(tokio::sync::Notify::new());
        let flush_count = Arc::new(AtomicUsize::new(0));
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        let flush_count_for_ops = Arc::clone(&flush_count);
        let delete_count_for_ops = Arc::clone(&delete_count);
        let delete_entered_for_ops = Arc::clone(&delete_entered);
        let first_delete_release_for_ops = Arc::clone(&first_delete_release);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |_| {
                let flush_count = Arc::clone(&flush_count_for_ops);
                Box::pin(async move {
                    flush_count.fetch_add(1, Ordering::SeqCst);
                    ConntrackFlushOutcome::Untrusted
                })
            }),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                let delete_entered = Arc::clone(&delete_entered_for_ops);
                let first_delete_release = Arc::clone(&first_delete_release_for_ops);
                Box::pin(async move {
                    let attempt = delete_count.fetch_add(1, Ordering::SeqCst);
                    delete_entered.notify_one();
                    if attempt == 0 {
                        first_delete_release.notified().await;
                    }
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::new_for_test(pool);

        {
            let release = handle.release(&mut lease);
            tokio::pin!(release);
            tokio::select! {
                outcome = &mut release => panic!("release completed before delete was cancelled: {outcome:?}"),
                _ = delete_entered.notified() => {}
            }
        }

        assert!(lease.is_some());
        assert_eq!(flush_count.load(Ordering::SeqCst), 1);
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        {
            let pool = handle.inner.lock().await;
            assert!(pool.non_reusable.contains("test-ns"));
        }

        first_delete_release.notify_one();
        let outcome = handle.release(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
        assert!(lease.is_none());
        assert_eq!(
            flush_count.load(Ordering::SeqCst),
            1,
            "tainted retry must not flush and requeue"
        );
        assert_eq!(delete_count.load(Ordering::SeqCst), 2);
        let pool = handle.inner.lock().await;
        assert!(pool.non_reusable.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn release_cancelled_after_delete_before_commit_retries_delete_without_flush() {
        let delete_entered = Arc::new(tokio::sync::Notify::new());
        let first_delete_release = Arc::new(tokio::sync::Notify::new());
        let flush_count = Arc::new(AtomicUsize::new(0));
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        let flush_count_for_ops = Arc::clone(&flush_count);
        let delete_count_for_ops = Arc::clone(&delete_count);
        let delete_entered_for_ops = Arc::clone(&delete_entered);
        let first_delete_release_for_ops = Arc::clone(&first_delete_release);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |_| {
                let flush_count = Arc::clone(&flush_count_for_ops);
                Box::pin(async move {
                    flush_count.fetch_add(1, Ordering::SeqCst);
                    ConntrackFlushOutcome::Untrusted
                })
            }),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                let delete_entered = Arc::clone(&delete_entered_for_ops);
                let first_delete_release = Arc::clone(&first_delete_release_for_ops);
                Box::pin(async move {
                    let attempt = delete_count.fetch_add(1, Ordering::SeqCst);
                    if attempt == 0 {
                        delete_entered.notify_one();
                        first_delete_release.notified().await;
                    }
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::new_for_test(pool);

        let mut release = Box::pin(handle.release(&mut lease));
        tokio::select! {
            outcome = &mut release => panic!("release completed before delete finished: {outcome:?}"),
            _ = delete_entered.notified() => {}
        }
        let guard = handle.inner.lock().await;
        first_delete_release.notify_one();
        tokio::select! {
            outcome = &mut release => panic!("release completed while pool lock was held: {outcome:?}"),
            _ = tokio::task::yield_now() => {}
        }
        assert!(guard.non_reusable.contains("test-ns"));
        drop(release);

        assert!(lease.is_some());
        assert_eq!(flush_count.load(Ordering::SeqCst), 1);
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        drop(guard);

        let outcome = handle.release(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
        assert!(lease.is_none());
        assert_eq!(
            flush_count.load(Ordering::SeqCst),
            1,
            "tainted post-delete retry must not flush/requeue"
        );
        assert_eq!(delete_count.load(Ordering::SeqCst), 2);
        let pool = handle.inner.lock().await;
        assert!(pool.non_reusable.is_empty());
        assert!(pool.in_flight.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn shared_cleanup_does_not_hold_mutex_while_delete_blocks() {
        let delete_entered = Arc::new(tokio::sync::Notify::new());
        let delete_release = Arc::new(tokio::sync::Notify::new());
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        pool.plain_queue.push_back(test_info("test-ns"));
        let delete_entered_for_ops = Arc::clone(&delete_entered);
        let delete_release_for_ops = Arc::clone(&delete_release);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_namespace: Arc::new(move |_| {
                let delete_entered = Arc::clone(&delete_entered_for_ops);
                let delete_release = Arc::clone(&delete_release_for_ops);
                Box::pin(async move {
                    delete_entered.notify_one();
                    delete_release.notified().await;
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let handle = NetnsPoolHandle::new_for_test(pool);

        let cleanup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.cleanup().await }
        });
        delete_entered.notified().await;

        let guard = handle
            .inner
            .try_lock()
            .expect("shared cleanup must not hold netns pool mutex while deleting namespace");
        drop(guard);

        delete_release.notify_one();
        cleanup.await.unwrap().unwrap();
        let pool = handle.inner.lock().await;
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn shared_cleanup_retry_keeps_queue_when_cancelled_during_delete() {
        let delete_entered = Arc::new(tokio::sync::Notify::new());
        let delete_release = Arc::new(tokio::sync::Notify::new());
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        pool.plain_queue.push_back(test_info("test-ns"));
        let delete_entered_for_ops = Arc::clone(&delete_entered);
        let delete_release_for_ops = Arc::clone(&delete_release);
        let delete_count_for_ops = Arc::clone(&delete_count);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_namespace: Arc::new(move |_| {
                let delete_entered = Arc::clone(&delete_entered_for_ops);
                let delete_release = Arc::clone(&delete_release_for_ops);
                let delete_count = Arc::clone(&delete_count_for_ops);
                Box::pin(async move {
                    let attempt = delete_count.fetch_add(1, Ordering::SeqCst);
                    delete_entered.notify_one();
                    if attempt == 0 {
                        delete_release.notified().await;
                    }
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let handle = NetnsPoolHandle::new_for_test(pool);

        let cleanup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.cleanup().await }
        });
        delete_entered.notified().await;
        cleanup.abort();
        let _ = cleanup.await;

        {
            let pool = handle.inner.lock().await;
            assert!(!pool.active);
            assert_eq!(pool.plain_queue.len(), 1);
            assert_eq!(pool.plain_queue.front().unwrap().name(), "test-ns");
        }

        delete_release.notify_one();
        handle.cleanup().await.unwrap();
        let pool = handle.inner.lock().await;
        assert!(pool.plain_queue.is_empty());
        assert_eq!(delete_count.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn release_disarms_lease_and_returns_info_to_queue() {
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        let info = test_info("test-ns");
        let mut lease = Some(pool.checkout(info).unwrap());

        pool.release(&mut lease).await.unwrap();

        assert!(lease.is_none());
        assert!(pool.in_flight.is_empty());
        assert_eq!(pool.plain_queue.len(), 1);
        assert_eq!(pool.plain_queue.front().unwrap().name(), "test-ns");

        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn release_after_cleanup_deletes_outstanding_lease_without_requeueing() {
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        let info = test_info("test-ns");
        let mut lease = Some(pool.checkout(info).unwrap());

        pool.cleanup().await.unwrap();

        assert!(!pool.active);
        assert!(lease.is_some());
        assert!(pool.in_flight.contains("test-ns"));

        pool.release(&mut lease).await.unwrap();

        assert!(lease.is_none());
        assert!(pool.in_flight.is_empty());
        assert!(pool.plain_queue.is_empty());
        assert!(pool.proxy_queue.is_empty());
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn release_abandoned_delete_consumes_lease_and_clears_tracking() {
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        let delete_count_for_ops = Arc::clone(&delete_count);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Untrusted })),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                Box::pin(async move {
                    delete_count.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Abandoned
                })
            }),
        };
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());

        let outcome = pool.release_outcome(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Abandoned));
        assert!(lease.is_none());
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        assert!(pool.in_flight.is_empty());
        assert!(pool.non_reusable.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn cleanup_retry_drains_pending_creation_after_cancel() {
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        let entered = std::sync::Arc::new(tokio::sync::Notify::new());
        let release = std::sync::Arc::new(tokio::sync::Notify::new());
        let entered_task = std::sync::Arc::clone(&entered);
        let release_task = std::sync::Arc::clone(&release);
        pool.spawn_plain_creation_for_test(async move {
            entered_task.notify_one();
            release_task.notified().await;
            Ok(test_info("test-ns"))
        });

        {
            let cleanup = pool.cleanup();
            tokio::pin!(cleanup);
            tokio::select! {
                result = &mut cleanup => panic!("cleanup completed before pending task was released: {result:?}"),
                _ = entered.notified() => {}
            }
        }

        assert!(!pool.active);
        assert_eq!(pool.pending_plain.len(), 1);

        release.notify_one();
        pool.cleanup().await.unwrap();

        assert!(!pool.active);
        assert!(pool.pending_plain.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn acquire_cancellation_keeps_pending_creation_for_cleanup() {
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        let entered = std::sync::Arc::new(tokio::sync::Notify::new());
        let release = std::sync::Arc::new(tokio::sync::Notify::new());
        let entered_task = std::sync::Arc::clone(&entered);
        let release_task = std::sync::Arc::clone(&release);
        pool.spawn_plain_creation_for_test(async move {
            entered_task.notify_one();
            release_task.notified().await;
            Ok(test_info("test-ns"))
        });

        {
            let acquire = pool.acquire();
            tokio::pin!(acquire);
            tokio::select! {
                result = &mut acquire => panic!("acquire completed before pending task was released: {result:?}"),
                _ = entered.notified() => {}
            }
        }

        assert!(pool.in_flight.is_empty());
        assert_eq!(pool.pending_plain.len(), 1);

        release.notify_one();
        pool.cleanup().await.unwrap();

        assert!(!pool.active);
        assert!(pool.pending_plain.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn delete_queued_namespaces_keeps_front_entry_when_cancelled() {
        let mut queue = VecDeque::from([test_info("test-ns")]);
        let entered = std::sync::Arc::new(tokio::sync::Notify::new());
        let release = std::sync::Arc::new(tokio::sync::Notify::new());

        let delete = {
            let entered = std::sync::Arc::clone(&entered);
            let release = std::sync::Arc::clone(&release);
            move |ns: NetnsInfo| {
                assert_eq!(ns.name(), "test-ns");
                let entered = std::sync::Arc::clone(&entered);
                let release = std::sync::Arc::clone(&release);
                async move {
                    entered.notify_one();
                    release.notified().await;
                }
            }
        };
        {
            let deletion = NetnsPool::delete_queued_namespaces_with(&mut queue, delete);
            tokio::pin!(deletion);
            tokio::select! {
                _ = &mut deletion => panic!("delete completed before test released it"),
                _ = entered.notified() => {}
            }
        }

        assert_eq!(queue.len(), 1);
        assert_eq!(queue.front().unwrap().name(), "test-ns");

        release.notify_one();
        NetnsPool::delete_queued_namespaces_with(&mut queue, |_| async {}).await;
        assert!(queue.is_empty());
    }

    #[tokio::test]
    async fn cleanup_retries_when_pool_is_inactive_but_not_drained() {
        let mut pool = NetnsPool::inactive_for_test();
        pool.plain_queue.push_back(test_info("test-ns"));

        pool.cleanup().await.unwrap();

        assert!(!pool.active);
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn cleanup_removes_queued_namespace_after_abandoned_delete() {
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        pool.plain_queue.push_back(test_info("test-ns"));
        let delete_count_for_ops = Arc::clone(&delete_count);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                Box::pin(async move {
                    delete_count.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Abandoned
                })
            }),
        };

        pool.cleanup().await.unwrap();

        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        assert!(!pool.active);
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn acquire_rejects_inactive_pool() {
        let mut pool = NetnsPool::inactive_for_test();
        pool.plain_queue.push_back(test_info("test-ns"));

        let err = pool.acquire().await.unwrap_err();

        assert!(matches!(err, NetworkError::PoolNotActive));
        assert_eq!(pool.plain_queue.len(), 1);
        assert!(pool.in_flight.is_empty());
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn acquire_requeues_namespace_when_checkout_detects_in_flight_duplicate() {
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        pool.in_flight.insert("test-ns".into());
        pool.plain_queue.push_back(test_info("test-ns"));

        let err = pool.acquire().await.unwrap_err();

        assert!(matches!(err, NetworkError::InvalidLease(_)));
        assert_eq!(pool.plain_queue.len(), 1);
        assert_eq!(pool.plain_queue.front().unwrap().name(), "test-ns");
        assert!(pool.pending_plain.is_empty());
        assert_eq!(pool.next_ns_index, 0);

        pool.in_flight.clear();
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn proxy_acquire_requeues_namespace_when_checkout_detects_in_flight_duplicate() {
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        pool.proxy_port = Some(8080);
        pool.in_flight.insert("test-ns".into());
        pool.proxy_queue.push_back(test_info("test-ns"));

        let err = pool.acquire().await.unwrap_err();

        assert!(matches!(err, NetworkError::InvalidLease(_)));
        assert!(pool.plain_queue.is_empty());
        assert_eq!(pool.proxy_queue.len(), 1);
        assert_eq!(pool.proxy_queue.front().unwrap().name(), "test-ns");
        assert!(pool.pending_proxy.is_empty());
        assert_eq!(pool.next_ns_index, 0);

        pool.in_flight.clear();
        pool.proxy_queue.clear();
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn release_keeps_lease_when_namespace_already_queued() {
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        let info = test_info("test-ns");
        let mut lease = Some(pool.checkout(info.clone()).unwrap());
        pool.plain_queue.push_back(info);

        let err = pool.release(&mut lease).await.unwrap_err();

        assert!(matches!(err, NetworkError::InvalidLease(_)));
        assert!(lease.is_some());
        assert_eq!(pool.plain_queue.len(), 1);
        assert_eq!(pool.plain_queue.front().unwrap().name(), "test-ns");

        let _ = lease.take().unwrap().into_info_for_test();
        pool.in_flight.clear();
        pool.plain_queue.clear();
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn release_keeps_lease_on_wrong_pool_instance() {
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        let info = test_info("test-ns");
        let mut lease = Some(NetnsLease::new(info, pool.instance_id + 1));

        let err = pool.release(&mut lease).await.unwrap_err();

        assert!(matches!(err, NetworkError::InvalidLease(_)));
        assert!(lease.is_some());
        let _ = lease.take().unwrap().into_info_for_test();

        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn release_keeps_lease_when_not_in_flight() {
        let mut pool = NetnsPool::inactive_for_test();
        pool.active = true;
        let info = test_info("test-ns");
        let mut lease = Some(NetnsLease::new(info, pool.instance_id));

        let err = pool.release(&mut lease).await.unwrap_err();

        assert!(matches!(err, NetworkError::InvalidLease(_)));
        assert!(lease.is_some());
        let _ = lease.take().unwrap().into_info_for_test();

        pool.cleanup().await.unwrap();
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
