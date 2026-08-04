//! Fixed identity shared by guest DNS emission, readiness, and failure diagnostics.

use std::net::Ipv4Addr;

const DNS_HEADER_BYTES: usize = 12;
const DNS_QNAME_OVERHEAD_BYTES: usize = 2;
const DNS_QUESTION_TRAILER_BYTES: usize = 4;
const IPV4_HEADER_BYTES: usize = 20;
const UDP_HEADER_BYTES: usize = 8;

/// Local-only hostname used to validate a namespace's DNS redirect path.
pub const DNS_READINESS_HOSTNAME: &str = "vm0-readiness.invalid";

/// Local-only hostname reserved for post-failure namespace diagnostics.
pub const DNS_DIAGNOSTIC_HOSTNAME: &str = "vm0-vethprobe.invalid";

/// TEST-NET address returned for the readiness and diagnostic hostnames.
pub const DNS_READINESS_IPV4: Ipv4Addr = Ipv4Addr::new(192, 0, 2, 1);

/// Dummy external resolver written to guest configuration and intercepted by the DNS proxy.
pub const DNS_PROBE_RESOLVER_IPV4: Ipv4Addr = Ipv4Addr::new(8, 8, 8, 8);
pub(crate) const DNS_PROBE_DESTINATION_PORT: u16 = 53;
/// Fixed diagnostic port outside Linux's default ephemeral range, used to correlate one query.
pub(crate) const DNS_DIAGNOSTIC_SOURCE_PORT: u16 = 30_053;

pub(crate) const GUEST_DNS_PROBE_QUERY_BYTES: usize = dns_a_query_bytes(DNS_READINESS_HOSTNAME);
/// IPv4 packet size of either fixed UDP DNS A query.
pub(crate) const GUEST_DNS_PROBE_PACKET_BYTES: u64 =
    (IPV4_HEADER_BYTES + UDP_HEADER_BYTES + GUEST_DNS_PROBE_QUERY_BYTES) as u64;

const _: () = assert!(dns_a_query_bytes(DNS_DIAGNOSTIC_HOSTNAME) == GUEST_DNS_PROBE_QUERY_BYTES);

const fn dns_a_query_bytes(hostname: &str) -> usize {
    DNS_HEADER_BYTES + hostname.len() + DNS_QNAME_OVERHEAD_BYTES + DNS_QUESTION_TRAILER_BYTES
}
