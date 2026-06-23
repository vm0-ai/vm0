//! DNS proxy for sandbox VMs using dnsmasq.
//!
//! Spawns a dnsmasq process that serves as the DNS resolver for all VMs.
//! DNS queries are intercepted via iptables REDIRECT (PREROUTING chain)
//! and forwarded to upstream resolvers (8.8.8.8, 8.8.4.4).
//!
//! Defense-in-depth:
//! - Layer 1: iptables REDIRECT → dnsmasq port (working path, preserves source IP)
//! - Layer 2: iptables DROP external UDP 53 / TCP 853 (bypass prevention)
//! - Layer 3: dnsmasq binds to VM-facing veth interfaces instead of external
//!   host interfaces (listener restriction)
//!
//! VM resolv.conf points to an external nameserver (e.g. 8.8.8.8) as a dummy
//! target. The REDIRECT rule in PREROUTING intercepts all UDP 53 from the VM
//! subnet and redirects to dnsmasq before the packet reaches FORWARD/POSTROUTING.
//!
//! Log format: dnsmasq `--log-queries=extra` outputs to stderr, parsed by a background
//! async task that submits per-VM network JSON rows through `NetworkLogManager`.

mod log;
mod port;
mod proxy;

pub(crate) use port::reserve_port;
pub use proxy::{DnsProxy, start_on_reserved_port};
