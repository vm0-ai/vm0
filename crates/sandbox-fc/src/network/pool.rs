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
//!   startup via flock-based liveness probe.

mod host;
mod naming;
mod state;
mod types;

pub use naming::{ParsedNetnsName, parse_netns_name};
pub use state::NetnsPool;
pub(crate) use state::NetnsPoolHandle;
pub use types::{NetnsInfo, NetnsLease, NetnsPoolConfig};
