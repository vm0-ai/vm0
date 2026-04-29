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
//! - [`NetnsPool::acquire`] returns a namespace from pool, or creates on-demand as fallback
//! - [`NetnsPool::release`] returns the namespace to the pool
//! - Pool index (0–63) is auto-allocated via flock on `/var/lock`
//! - Orphans from abnormally-exited prior runners (SIGKILL, panic, OOM,
//!   power loss, aborted in-flight creation tasks) are reconciled at
//!   startup via flock-based liveness probe — see
//!   [`reconcile_orphan_namespaces`]

use std::collections::VecDeque;
use std::fs::File;

use nix::fcntl::{Flock, FlockArg};
use sandbox::SandboxError;
use tracing::{error, info, trace, warn};

use crate::command::{exec, exec_ignore_errors};
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

// Compile-time check: all /30 subnets fit within `10.200.0.0/16`.
// 64 pools × 256 ns × 4 addresses per /30 = 65536 = exactly 2^16.
const _: () = assert!(MAX_POOLS * MAX_NAMESPACES * 4 <= 65536);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A pooled network namespace resource.
#[derive(Debug, Clone)]
#[must_use]
pub struct PooledNetns {
    /// Namespace name (e.g. `vm0-ns-00-00`).
    pub name: String,
    /// Host-side veth device name (e.g. `vm0-ve-00-00`).
    pub host_device: String,
    /// Veth namespace-side IP (e.g. `10.200.0.2`). This is the source IP
    /// that the proxy sees after NAT, used as the VM registry key.
    pub peer_ip: String,
}

/// Configuration for creating a [`NetnsPool`].
///
/// When `proxy_port` is set, the pool maintains **two** queues
/// (plain + proxy), each buffering `BUFFER_SIZE` namespaces.
pub struct NetnsPoolConfig {
    /// Proxy port for HTTP/HTTPS redirect (only adds redirect rules when set).
    pub proxy_port: Option<u16>,
    /// DNS proxy port for DNS query redirect (only adds redirect rules when set).
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
    exec("ip", args).await?;
    Ok(())
}

/// Shorthand: run `iptables <args>`, discard stdout.
async fn exec_iptables(args: &[&str]) -> Result<()> {
    exec("iptables", args).await?;
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
    let result = exec("ip", &["route", "get", "8.8.8.8"]).await?;
    let iface = result
        .split_whitespace()
        .skip_while(|&w| w != "dev")
        .nth(1)
        .map(String::from)
        .ok_or(NetworkError::NoDefaultInterface(result))?;
    Ok(iface)
}

/// Delete iptables rules that contain `comment` in nat and filter tables.
async fn delete_iptables_rules_by_comment(comment: &str) {
    let ((), ()) = tokio::join!(
        delete_iptables_from_table("nat", comment),
        delete_iptables_from_table("filter", comment),
    );
}

async fn delete_iptables_from_table(table: &str, comment: &str) {
    let output = match exec("iptables-save", &["-t", table]).await {
        Ok(output) => output,
        Err(e) => {
            trace!(table, error = %e, "failed to read iptables rules, skipping cleanup");
            return;
        }
    };
    // Sequential: xtables lock serializes writes to the same table anyway.
    // Note: split_whitespace + trim_matches('"') is safe because namespace
    // comment values (e.g. "vm0-ns-00-0a") never contain spaces. If they
    // did, iptables-save would quote them as `--comment "foo bar"` and the
    // split would incorrectly break the value into separate arguments.
    for line in output
        .lines()
        .filter(|line| line.starts_with("-A ") && line.contains(comment))
    {
        let rule = line.replacen("-A ", "-D ", 1);
        let mut args: Vec<&str> = vec!["-t", table];
        args.extend(rule.split_whitespace().map(|t| t.trim_matches('"')));
        exec_ignore_errors("iptables", &args).await;
    }
}

/// Delete a namespace's network resources (iptables, veth, netns).
async fn delete_namespace_resources(ns_name: &str, host_device: &str) {
    info!(name = %ns_name, "deleting namespace");
    delete_iptables_rules_by_comment(ns_name).await;
    let del_link_args = ["link", "del", host_device];
    let del_ns_args = ["netns", "del", ns_name];
    tokio::join!(
        exec_ignore_errors("ip", &del_link_args),
        exec_ignore_errors("ip", &del_ns_args),
    );
    info!(name = %ns_name, "namespace deleted");
}

/// Flush conntrack entries for a given IP address.
///
/// Namespaces are reused between VMs with the same peer IP. Without
/// flushing, stale conntrack entries from a previous VM can cause the
/// stateful iptables rule (`-m state --state RELATED,ESTABLISHED`) to
/// misroute or silently drop return packets for a new VM.
async fn flush_conntrack(peer_ip: &str) {
    let src_args = ["-D", "-s", peer_ip];
    let dst_args = ["-D", "-d", peer_ip];
    tokio::join!(
        exec_ignore_errors("conntrack", &src_args),
        exec_ignore_errors("conntrack", &dst_args),
    );
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
    plain_queue: VecDeque<PooledNetns>,
    proxy_queue: VecDeque<PooledNetns>,
    /// In-flight background namespace creation tasks (plain).
    pending_plain: tokio::task::JoinSet<Result<PooledNetns>>,
    /// In-flight background namespace creation tasks (proxy).
    pending_proxy: tokio::task::JoinSet<Result<PooledNetns>>,
    next_ns_index: u32,
    pool_index: u32,
    proxy_port: Option<u16>,
    dns_port: Option<u16>,
    default_iface: String,
    /// Held for the lifetime of the pool to reserve the pool index.
    _lock: Flock<File>,
}

impl NetnsPool {
    #[cfg(test)]
    pub(crate) fn inactive_for_test() -> Self {
        let file = tempfile::tempfile().expect("create test netns pool lock file");
        let lock = match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => lock,
            Err((_, errno)) => panic!("lock test netns pool file: {errno}"),
        };

        Self {
            active: false,
            plain_queue: VecDeque::new(),
            proxy_queue: VecDeque::new(),
            pending_plain: tokio::task::JoinSet::new(),
            pending_proxy: tokio::task::JoinSet::new(),
            next_ns_index: 0,
            pool_index: 0,
            proxy_port: None,
            dns_port: None,
            default_iface: "test0".into(),
            _lock: lock,
        }
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
        exec("sysctl", &["-w", "net.ipv4.ip_forward=1"]).await?;

        // Reconcile orphans from our own index and any idle pool index.
        // This is the correctness guarantee for kernel-side cleanup —
        // `NetnsPool::cleanup` is best-effort and cannot survive SIGKILL,
        // panic, OOM, or aborted in-flight creation tasks (issue #10625).
        reconcile_orphan_namespaces(&lock_paths, index, &lock).await;

        let default_iface = get_default_interface().await?;

        let mut pool = Self {
            active: true,
            plain_queue: VecDeque::with_capacity(BUFFER_SIZE),
            proxy_queue: VecDeque::with_capacity(if config.proxy_port.is_some() {
                BUFFER_SIZE
            } else {
                0
            }),
            pending_plain: tokio::task::JoinSet::new(),
            pending_proxy: tokio::task::JoinSet::new(),
            next_ns_index: 0,
            pool_index: index,
            proxy_port: config.proxy_port,
            dns_port: config.dns_port,
            default_iface,
            _lock: lock,
        };

        // Pre-warm the buffer. Warm-up starts at ns_index 0, so
        // `reconcile_orphan_namespaces` above MUST have finished
        // synchronously — otherwise `vm0-ns-{own}-00` may still exist from
        // a previous runner and `ip netns add` will fail with EEXIST.
        if BUFFER_SIZE > 0 {
            let mut plain_set = tokio::task::JoinSet::new();
            let mut proxy_set = tokio::task::JoinSet::new();

            // Plain namespaces (connectivity only). Only needed when proxy
            // is disabled; with proxy configured, `acquire()` always routes
            // to the proxy queue, so plain entries would be unreachable
            // until `cleanup()`.
            if pool.proxy_port.is_none() {
                for _ in 0..BUFFER_SIZE {
                    let ns_index = pool.next_ns_index;
                    pool.next_ns_index += 1;
                    let pool_index = pool.pool_index;
                    let default_iface = pool.default_iface.clone();
                    plain_set.spawn(create_single_namespace(
                        pool_index,
                        ns_index,
                        default_iface,
                        None,
                        None,
                    ));
                }
            }

            // Proxy namespaces (connectivity + REDIRECT rules).
            if let Some(proxy_port) = pool.proxy_port {
                let dns_port = pool.dns_port;
                for _ in 0..BUFFER_SIZE {
                    let ns_index = pool.next_ns_index;
                    pool.next_ns_index += 1;
                    let pool_index = pool.pool_index;
                    let default_iface = pool.default_iface.clone();
                    proxy_set.spawn(create_single_namespace(
                        pool_index,
                        ns_index,
                        default_iface,
                        Some(proxy_port),
                        dns_port,
                    ));
                }
            }

            while let Some(result) = plain_set.join_next().await {
                match result {
                    Ok(Ok(ns)) => pool.plain_queue.push_back(ns),
                    Ok(Err(e)) => error!(error = %e, "failed to create namespace"),
                    Err(e) => error!(error = %e, "namespace creation task panicked"),
                }
            }
            while let Some(result) = proxy_set.join_next().await {
                match result {
                    Ok(Ok(ns)) => pool.proxy_queue.push_back(ns),
                    Ok(Err(e)) => error!(error = %e, "failed to create proxy namespace"),
                    Err(e) => error!(error = %e, "proxy namespace creation task panicked"),
                }
            }
        }

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
    /// Uses a three-tier strategy:
    /// 1. Pop from pre-warmed queue (instant)
    /// 2. Await in-flight background creation (if any)
    /// 3. Create on-demand as fallback
    ///
    /// After acquisition, spawns a background replenishment task if the
    /// buffer is below `BUFFER_SIZE`.
    ///
    /// When `proxy_port` is configured, acquires from the proxy queue
    /// (namespaces with iptables REDIRECT rules). Otherwise acquires from
    /// the plain queue.
    pub async fn acquire(&mut self) -> Result<PooledNetns> {
        // Move completed background tasks into queues before checking.
        self.drain_completed();

        if self.proxy_port.is_some() {
            self.acquire_proxy().await
        } else {
            self.acquire_plain().await
        }
    }

    /// Acquire from the plain (non-proxy) queue.
    ///
    /// Tries three tiers: queue → pending → on-demand.
    /// Spawns a background replenishment task after success.
    async fn acquire_plain(&mut self) -> Result<PooledNetns> {
        // Tier 1: pre-warmed queue.
        if let Some(pooled) = self.plain_queue.pop_front() {
            info!(
                name = %pooled.name,
                remaining = self.plain_queue.len(),
                "acquired namespace"
            );
            self.maybe_replenish_plain();
            return Ok(pooled);
        }
        // Tier 2: await in-flight background task.
        while let Some(result) = self.pending_plain.join_next().await {
            match result {
                Ok(Ok(ns)) => {
                    info!(name = %ns.name, "acquired namespace from pending");
                    self.maybe_replenish_plain();
                    return Ok(ns);
                }
                Ok(Err(e)) => error!(error = %e, "pending namespace creation failed"),
                Err(e) => error!(error = %e, "pending namespace task panicked"),
            }
        }
        // Tier 3: on-demand.
        info!("pool exhausted, creating namespace on-demand");
        let ns = self.create_on_demand(None, None).await?;
        self.maybe_replenish_plain();
        Ok(ns)
    }

    /// Acquire from the proxy queue.
    ///
    /// Tries three tiers: queue → pending → on-demand.
    /// Spawns a background replenishment task after success.
    async fn acquire_proxy(&mut self) -> Result<PooledNetns> {
        // Tier 1: pre-warmed queue.
        if let Some(pooled) = self.proxy_queue.pop_front() {
            info!(
                name = %pooled.name,
                remaining = self.proxy_queue.len(),
                "acquired namespace (proxy)"
            );
            self.maybe_replenish_proxy();
            return Ok(pooled);
        }
        // Tier 2: await in-flight background task.
        while let Some(result) = self.pending_proxy.join_next().await {
            match result {
                Ok(Ok(ns)) => {
                    info!(name = %ns.name, "acquired namespace (proxy) from pending");
                    self.maybe_replenish_proxy();
                    return Ok(ns);
                }
                Ok(Err(e)) => error!(error = %e, "pending proxy namespace creation failed"),
                Err(e) => error!(error = %e, "pending proxy namespace task panicked"),
            }
        }
        // Tier 3: on-demand.
        info!("proxy pool exhausted, creating namespace on-demand");
        let ns = self
            .create_on_demand(self.proxy_port, self.dns_port)
            .await?;
        self.maybe_replenish_proxy();
        Ok(ns)
    }

    /// Create a new namespace on-demand, allocating the next index.
    async fn create_on_demand(
        &mut self,
        proxy_port: Option<u16>,
        dns_port: Option<u16>,
    ) -> Result<PooledNetns> {
        let ns_index = self.next_ns_index;
        if ns_index >= MAX_NAMESPACES {
            return Err(NetworkError::NamespaceLimitReached {
                max: MAX_NAMESPACES,
            });
        }
        self.next_ns_index += 1;
        create_single_namespace(
            self.pool_index,
            ns_index,
            self.default_iface.clone(),
            proxy_port,
            dns_port,
        )
        .await
    }

    /// Move completed background tasks into their respective queues.
    ///
    /// Uses `try_join_next()` to avoid blocking — only drains tasks that
    /// have already finished.
    fn drain_completed(&mut self) {
        while let Some(result) = self.pending_plain.try_join_next() {
            match result {
                Ok(Ok(ns)) => self.plain_queue.push_back(ns),
                Ok(Err(e)) => error!(error = %e, "background namespace creation failed"),
                Err(e) => error!(error = %e, "background namespace creation panicked"),
            }
        }
        while let Some(result) = self.pending_proxy.try_join_next() {
            match result {
                Ok(Ok(ns)) => self.proxy_queue.push_back(ns),
                Ok(Err(e)) => error!(error = %e, "background proxy namespace creation failed"),
                Err(e) => error!(error = %e, "background proxy namespace creation panicked"),
            }
        }
    }

    /// Spawn a background plain namespace creation task if needed.
    ///
    /// Skips if: buffer is full, a task is already in-flight, or
    /// namespace index limit reached.
    fn maybe_replenish_plain(&mut self) {
        if self.plain_queue.len() + self.pending_plain.len() >= BUFFER_SIZE
            || !self.pending_plain.is_empty()
            || self.next_ns_index >= MAX_NAMESPACES
        {
            return;
        }
        let ns_index = self.next_ns_index;
        self.next_ns_index += 1;
        let pool_index = self.pool_index;
        let default_iface = self.default_iface.clone();
        self.pending_plain.spawn(create_single_namespace(
            pool_index,
            ns_index,
            default_iface,
            None,
            None,
        ));
    }

    /// Spawn a background proxy namespace creation task if needed.
    ///
    /// Skips if: no proxy port configured, buffer is full, a task is
    /// already in-flight, or namespace index limit reached.
    fn maybe_replenish_proxy(&mut self) {
        let Some(proxy_port) = self.proxy_port else {
            return;
        };
        if self.proxy_queue.len() + self.pending_proxy.len() >= BUFFER_SIZE
            || !self.pending_proxy.is_empty()
            || self.next_ns_index >= MAX_NAMESPACES
        {
            return;
        }
        let ns_index = self.next_ns_index;
        self.next_ns_index += 1;
        let pool_index = self.pool_index;
        let default_iface = self.default_iface.clone();
        let dns_port = self.dns_port;
        self.pending_proxy.spawn(create_single_namespace(
            pool_index,
            ns_index,
            default_iface,
            Some(proxy_port),
            dns_port,
        ));
    }

    /// Return a namespace to the pool, or delete it if the pool is inactive.
    ///
    /// When `proxy_port` is configured, the namespace is returned to
    /// the proxy queue so its REDIRECT rules are reused.
    pub async fn release(&mut self, ns: PooledNetns) -> Result<()> {
        if !self.active {
            delete_namespace_resources(&ns.name, &ns.host_device).await;
            return Ok(());
        }

        let has_proxy = self.proxy_port.is_some();
        let target_queue = if has_proxy {
            &mut self.proxy_queue
        } else {
            &mut self.plain_queue
        };

        if target_queue.iter().any(|r| r.name == ns.name) {
            info!(name = %ns.name, "namespace already in pool, ignoring");
            return Ok(());
        }

        // Flush stale conntrack entries so the next VM using this namespace
        // does not inherit connection tracking state from the previous VM.
        flush_conntrack(&ns.peer_ip).await;

        info!(
            name = %ns.name,
            available = target_queue.len() + 1,
            has_proxy,
            "namespace released"
        );
        target_queue.push_back(ns);
        Ok(())
    }

    /// Delete all namespaces currently in the pool queue and cancel
    /// in-flight background creation tasks.
    ///
    /// Namespaces that have been acquired but not yet released are **not**
    /// cleaned up here — they will be caught by orphan cleanup on the next
    /// [`NetnsPool::create`] call with the same index.
    pub async fn cleanup(&mut self) -> Result<()> {
        if !self.active {
            return Ok(());
        }
        self.active = false;

        // Cancel in-flight background creation tasks.
        self.pending_plain.abort_all();
        self.pending_proxy.abort_all();

        // Drain any tasks that completed before abort into queues for cleanup.
        while let Some(result) = self.pending_plain.join_next().await {
            if let Ok(Ok(ns)) = result {
                self.plain_queue.push_back(ns);
            }
        }
        while let Some(result) = self.pending_proxy.join_next().await {
            if let Ok(Ok(ns)) = result {
                self.proxy_queue.push_back(ns);
            }
        }

        let count = self.plain_queue.len() + self.proxy_queue.len();
        info!(count, "cleaning up namespace pool");

        let to_delete: Vec<PooledNetns> = self
            .plain_queue
            .drain(..)
            .chain(self.proxy_queue.drain(..))
            .collect();

        // Delete namespaces in parallel
        let mut set = tokio::task::JoinSet::new();
        for ns in to_delete {
            set.spawn(async move {
                delete_namespace_resources(&ns.name, &ns.host_device).await;
            });
        }
        while let Some(result) = set.join_next().await {
            if let Err(e) = result {
                error!(error = %e, "namespace deletion task panicked");
            }
        }

        info!("namespace pool cleanup complete");
        Ok(())
    }
}

impl Drop for NetnsPool {
    fn drop(&mut self) {
        if self.active {
            warn!(
                queued = self.plain_queue.len() + self.proxy_queue.len(),
                pending = self.pending_plain.len() + self.pending_proxy.len(),
                "NetnsPool dropped without calling cleanup()"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Namespace creation (free functions for JoinSet compatibility)
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
) -> Result<PooledNetns> {
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
            Ok(PooledNetns {
                name: ns_name,
                host_device,
                peer_ip,
            })
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
    let Ok(output) = exec("ip", &["netns", "list"]).await else {
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
    // `exec_ignore_errors` so a per-namespace `Result` would carry no
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
