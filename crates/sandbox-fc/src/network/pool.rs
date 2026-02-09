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
//! - Pool creates fixed number of namespaces at init (parallel)
//! - [`NetnsPool::acquire`] returns a namespace from pool, or creates on-demand as fallback
//! - [`NetnsPool::release`] returns the namespace to the pool
//! - Pool index (0–63) is auto-allocated via flock on `/var/lock`

use std::collections::VecDeque;
use std::fs::File;

use nix::fcntl::{Flock, FlockArg};
use tracing::{error, info, trace, warn};

use crate::command::{Privilege, exec, exec_ignore_errors};
use crate::paths::LOCK_DIR;

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
}

/// Configuration for creating a [`NetnsPool`].
pub struct NetnsPoolConfig {
    /// Number of namespaces to pre-create.
    pub size: usize,
    /// Proxy port for HTTP/HTTPS redirect (only adds redirect rules when set).
    pub proxy_port: Option<u16>,
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

/// Shorthand: run `sudo ip <args>`, discard stdout.
async fn sudo_ip(args: &[&str]) -> Result<()> {
    exec("ip", args, Privilege::Sudo).await?;
    Ok(())
}

/// Shorthand: run `sudo iptables <args>`, discard stdout.
async fn sudo_iptables(args: &[&str]) -> Result<()> {
    exec("iptables", args, Privilege::Sudo).await?;
    Ok(())
}

/// Create a network namespace with a TAP device.
async fn create_netns_with_tap(
    ns_name: &str,
    tap_name: &str,
    gateway_ip_with_prefix: &str,
) -> Result<()> {
    sudo_ip(&["netns", "add", ns_name]).await?;
    sudo_ip(&[
        "netns", "exec", ns_name, "ip", "tuntap", "add", tap_name, "mode", "tap",
    ])
    .await?;
    sudo_ip(&[
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
    sudo_ip(&[
        "netns", "exec", ns_name, "ip", "link", "set", tap_name, "up",
    ])
    .await?;
    sudo_ip(&["netns", "exec", ns_name, "ip", "link", "set", "lo", "up"]).await?;
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
    sudo_ip(&[
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
    sudo_ip(&[
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
    sudo_ip(&[
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
    sudo_ip(&["addr", "add", &host_cidr, "dev", host_device]).await?;
    sudo_ip(&["link", "set", host_device, "up"]).await?;
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
    sudo_ip(&[
        "netns", "exec", name, "ip", "route", "add", "default", "via", host_ip,
    ])
    .await?;
    sudo_ip(&[
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
    sudo_ip(&[
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

/// Add host-side iptables rules for forwarding and proxy redirect.
async fn setup_host_iptables(
    name: &str,
    host_device: &str,
    peer_ip: &str,
    proxy_port: Option<u16>,
    default_iface: &str,
) -> Result<()> {
    let src = format!("{peer_ip}/30");
    sudo_iptables(&[
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
    sudo_iptables(&[
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
    sudo_iptables(&[
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
    if let Some(port) = proxy_port {
        let port_str = port.to_string();
        sudo_iptables(&[
            "-t",
            "nat",
            "-A",
            "PREROUTING",
            "-s",
            &src,
            "-p",
            "tcp",
            "--dport",
            "80",
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
        sudo_iptables(&[
            "-t",
            "nat",
            "-A",
            "PREROUTING",
            "-s",
            &src,
            "-p",
            "tcp",
            "--dport",
            "443",
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

async fn get_default_interface() -> Result<String> {
    let result = exec("ip", &["route", "get", "8.8.8.8"], Privilege::User).await?;
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
    let output = match exec("iptables-save", &["-t", table], Privilege::Sudo).await {
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
        exec_ignore_errors("iptables", &args, Privilege::Sudo).await;
    }
}

/// Delete a namespace's network resources (iptables, veth, netns).
async fn delete_namespace_resources(ns_name: &str, host_device: &str) {
    info!(name = %ns_name, "deleting namespace");
    delete_iptables_rules_by_comment(ns_name).await;
    let del_link_args = ["link", "del", host_device];
    let del_ns_args = ["netns", "del", ns_name];
    tokio::join!(
        exec_ignore_errors("ip", &del_link_args, Privilege::Sudo),
        exec_ignore_errors("ip", &del_ns_args, Privilege::Sudo),
    );
    info!(name = %ns_name, "namespace deleted");
}

// ---------------------------------------------------------------------------
// Pool index lock
// ---------------------------------------------------------------------------

/// Lock file prefix inside the lock directory.
const LOCK_PREFIX: &str = "vm0-netns-pool-";

/// Try to acquire an exclusive flock on a pool index file (0..MAX_POOLS).
///
/// Returns the first successfully locked `(index, Flock<File>)`. The lock is
/// held for the lifetime of the returned `Flock` — when the process exits or
/// the `Flock` is dropped, the OS releases the lock automatically.
fn acquire_pool_lock(lock_dir: &str) -> Result<(u32, Flock<File>)> {
    for index in 0..MAX_POOLS {
        let path = format!("{lock_dir}/{LOCK_PREFIX}{index}.lock");
        let file = File::options()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|e| NetworkError::LockOpen(format!("{path}: {e}")))?;
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
pub struct NetnsPool {
    active: bool,
    queue: VecDeque<PooledNetns>,
    next_ns_index: u32,
    pool_index: u32,
    proxy_port: Option<u16>,
    default_iface: String,
    /// Held for the lifetime of the pool to reserve the pool index.
    _lock: Flock<File>,
}

impl NetnsPool {
    /// Create a new pool, pre-warming `config.size` namespaces.
    ///
    /// Automatically acquires a unique pool index (0–63) via flock. Enables
    /// host IP forwarding and cleans up orphaned resources from the acquired
    /// index before creating new namespaces.
    pub async fn create(config: NetnsPoolConfig) -> Result<Self> {
        let (index, lock) = acquire_pool_lock(LOCK_DIR)?;

        info!(index, size = config.size, "initializing namespace pool");

        // Enable host-level IP forwarding (idempotent, needed once per host).
        exec("sysctl", &["-w", "net.ipv4.ip_forward=1"], Privilege::Sudo).await?;

        // Clean up orphaned namespaces from a previous process that used the same index.
        cleanup_namespaces_by_index(index).await;

        let default_iface = get_default_interface().await?;

        let mut pool = Self {
            active: true,
            queue: VecDeque::with_capacity(config.size),
            next_ns_index: 0,
            pool_index: index,
            proxy_port: config.proxy_port,
            default_iface,
            _lock: lock,
        };

        // Create all namespaces in parallel via JoinSet
        if config.size > 0 {
            let mut join_set = tokio::task::JoinSet::new();
            for _ in 0..config.size {
                let ns_index = pool.next_ns_index;
                pool.next_ns_index += 1;
                let pool_index = pool.pool_index;
                let proxy_port = pool.proxy_port;
                let default_iface = pool.default_iface.clone();
                join_set.spawn(create_single_namespace(
                    pool_index,
                    ns_index,
                    proxy_port,
                    default_iface,
                ));
            }
            while let Some(result) = join_set.join_next().await {
                match result {
                    Ok(Ok(ns)) => pool.queue.push_back(ns),
                    Ok(Err(e)) => error!(error = %e, "failed to create namespace"),
                    Err(e) => error!(error = %e, "namespace creation task panicked"),
                }
            }
        }

        if pool.queue.len() < config.size {
            warn!(
                requested = config.size,
                created = pool.queue.len(),
                "namespace pool initialized with fewer namespaces than requested"
            );
        }

        info!(available = pool.queue.len(), "namespace pool initialized");
        Ok(pool)
    }

    /// Acquire a namespace from the pool, or create one on-demand if empty.
    pub async fn acquire(&mut self) -> Result<PooledNetns> {
        if let Some(pooled) = self.queue.pop_front() {
            info!(
                name = %pooled.name,
                remaining = self.queue.len(),
                "acquired namespace"
            );
            return Ok(pooled);
        }

        info!("pool exhausted, creating namespace on-demand");
        let ns_index = self.next_ns_index;
        if ns_index >= MAX_NAMESPACES {
            return Err(NetworkError::NamespaceLimitReached {
                max: MAX_NAMESPACES,
            });
        }
        self.next_ns_index += 1;
        let ns = create_single_namespace(
            self.pool_index,
            ns_index,
            self.proxy_port,
            self.default_iface.clone(),
        )
        .await?;
        Ok(ns)
    }

    /// Return a namespace to the pool, or delete it if the pool is inactive.
    pub async fn release(&mut self, ns: PooledNetns) -> Result<()> {
        if !self.active {
            delete_namespace_resources(&ns.name, &ns.host_device).await;
            return Ok(());
        }

        if self.queue.iter().any(|r| r.name == ns.name) {
            info!(name = %ns.name, "namespace already in pool, ignoring");
            return Ok(());
        }
        info!(
            name = %ns.name,
            available = self.queue.len() + 1,
            "namespace released"
        );
        self.queue.push_back(ns);
        Ok(())
    }

    /// Delete all namespaces currently in the pool queue.
    ///
    /// Namespaces that have been acquired but not yet released are **not**
    /// cleaned up here — they will be caught by orphan cleanup on the next
    /// [`NetnsPool::create`] call with the same index.
    pub async fn cleanup(&mut self) -> Result<()> {
        if !self.active {
            return Ok(());
        }
        self.active = false;

        let count = self.queue.len();
        info!(count, "cleaning up namespace pool");

        let to_delete: Vec<PooledNetns> = self.queue.drain(..).collect();

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
                queued = self.queue.len(),
                "NetnsPool dropped without calling cleanup()"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Namespace creation (free functions for JoinSet compatibility)
// ---------------------------------------------------------------------------

/// Create a single namespace with full connectivity.
///
/// This is a free function (no `&self`) so it can be spawned on a `JoinSet`.
async fn create_single_namespace(
    pool_index: u32,
    ns_index: u32,
    proxy_port: Option<u16>,
    default_iface: String,
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

    info!(name = %ns_name, "creating namespace");

    let sn = &GUEST_NETWORK;
    let result = create_namespace_inner(
        &ns_name,
        &host_device,
        &host_ip,
        &peer_ip,
        proxy_port,
        sn,
        &default_iface,
    )
    .await;

    match result {
        Ok(()) => {
            info!(name = %ns_name, "namespace created");
            Ok(PooledNetns {
                name: ns_name,
                host_device,
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
    proxy_port: Option<u16>,
    sn: &super::GuestNetwork,
    default_iface: &str,
) -> Result<()> {
    let gw_with_prefix = format!("{}/{}", sn.gateway_ip, sn.prefix_len);
    create_netns_with_tap(name, sn.tap_name, &gw_with_prefix).await?;
    setup_veth_pair(name, host_device, host_ip, peer_ip).await?;
    setup_namespace_routing(name, host_ip, sn.gateway_ip, sn.prefix_len).await?;
    setup_host_iptables(name, host_device, peer_ip, proxy_port, default_iface).await?;

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
    let Ok(output) = exec("ip", &["netns", "list"], Privilege::Sudo).await else {
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
        let lock_dir = dir.path().to_str().unwrap();

        let (index, _lock) = acquire_pool_lock(lock_dir).unwrap();
        assert_eq!(index, 0);
    }

    #[test]
    fn acquire_pool_lock_skips_held_indices() {
        let dir = tempfile::tempdir().unwrap();
        let lock_dir = dir.path().to_str().unwrap();

        let (i0, _hold0) = acquire_pool_lock(lock_dir).unwrap();
        let (i1, _hold1) = acquire_pool_lock(lock_dir).unwrap();
        let (i2, _hold2) = acquire_pool_lock(lock_dir).unwrap();

        assert_eq!(i0, 0);
        assert_eq!(i1, 1);
        assert_eq!(i2, 2);
    }

    #[test]
    fn acquire_pool_lock_reuses_released_index() {
        let dir = tempfile::tempdir().unwrap();
        let lock_dir = dir.path().to_str().unwrap();

        let (i0, hold0) = acquire_pool_lock(lock_dir).unwrap();
        let (i1, _hold1) = acquire_pool_lock(lock_dir).unwrap();
        assert_eq!(i0, 0);
        assert_eq!(i1, 1);

        // Drop lock 0 → index 0 becomes available again.
        drop(hold0);

        let (reused, _hold) = acquire_pool_lock(lock_dir).unwrap();
        assert_eq!(reused, 0);
    }

    #[test]
    fn acquire_pool_lock_exhausted() {
        let dir = tempfile::tempdir().unwrap();
        let lock_dir = dir.path().to_str().unwrap();

        // Hold all 64 slots.
        let _locks: Vec<_> = (0..MAX_POOLS)
            .map(|_| acquire_pool_lock(lock_dir).unwrap())
            .collect();

        let err = acquire_pool_lock(lock_dir).unwrap_err();
        assert!(
            matches!(err, NetworkError::NoPoolIndexAvailable),
            "expected NoPoolIndexAvailable, got: {err}"
        );
    }
}
