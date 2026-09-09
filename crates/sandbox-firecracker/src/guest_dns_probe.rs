//! Fixed identity shared by guest DNS emission and readiness.

use std::net::Ipv4Addr;

/// Local-only hostname used to validate a namespace's DNS redirect path.
pub const DNS_READINESS_HOSTNAME: &str = "vm0-readiness.invalid";

/// TEST-NET address returned for the readiness hostname.
pub const DNS_READINESS_IPV4: Ipv4Addr = Ipv4Addr::new(192, 0, 2, 1);

/// Dummy external resolver written to guest configuration and intercepted by the DNS proxy.
pub const DNS_PROBE_RESOLVER_IPV4: Ipv4Addr = Ipv4Addr::new(8, 8, 8, 8);
pub(crate) const DNS_PROBE_DESTINATION_PORT: u16 = 53;
