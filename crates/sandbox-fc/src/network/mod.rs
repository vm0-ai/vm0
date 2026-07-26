mod error;
mod guest;
mod pool;
mod readiness;

pub(crate) use guest::generate_boot_args;
pub(crate) use guest::{GUEST_NETWORK, GuestNetwork};
pub(crate) use pool::NetnsPoolHandle;
pub use pool::{
    NetnsInfo, NetnsLease, NetnsPool, NetnsPoolConfig, ParsedNetnsName, parse_netns_name,
};
pub(crate) use readiness::probe_namespace_dns_diagnostic;
pub use readiness::{DNS_DIAGNOSTIC_HOSTNAME, DNS_READINESS_HOSTNAME, DNS_READINESS_IPV4};
