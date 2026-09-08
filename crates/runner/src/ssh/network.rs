//! Public destination validation binds the entire DNS answer set to one socket.

use api_contracts::generated::public_destination_policy::*;
use async_trait::async_trait;
use std::{
    io,
    net::{IpAddr, SocketAddr},
    sync::Arc,
};
use tokio::net::TcpStream;

use super::FailureReason;

#[async_trait]
pub(super) trait Network: Send + Sync {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>>;
    async fn connect(&self, address: SocketAddr) -> io::Result<TcpStream>;
}

pub(super) struct PublicNetwork;

#[async_trait]
impl Network for PublicNetwork {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        Ok(tokio::net::lookup_host((host, port))
            .await?
            .take(65)
            .collect())
    }
    async fn connect(&self, address: SocketAddr) -> io::Result<TcpStream> {
        TcpStream::connect(address).await
    }
}

pub(super) async fn destination(
    network: Arc<dyn Network>,
    host: &str,
    port: u16,
) -> Result<SocketAddr, FailureReason> {
    let literal = host.parse::<IpAddr>();
    let addresses = if let Ok(ip) = literal {
        vec![SocketAddr::new(ip, port)]
    } else {
        // API supplies canonical ASCII names; never reinterpret legacy numeric,
        // scoped, URL, escaped, bracketed, or search-domain-relative input.
        if host.len() > 253
            || !host.is_ascii()
            || crate::firewall_hostname_policy::is_ipv4_literal_like(host.trim_end_matches('.'))
            || host.split('.').any(|label| {
                label.is_empty()
                    || label.len() > 63
                    || label.starts_with('-')
                    || label.ends_with('-')
                    || !label
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
        {
            return Err(FailureReason::UnsafeDestination);
        }
        network
            .resolve(&format!("{host}."), port)
            .await
            .map_err(|_| FailureReason::NetworkFailure)?
    };
    if addresses.is_empty()
        || addresses.len() > 64
        || addresses.iter().any(|address| {
            address.port() != port
                || !is_public(address.ip())
                || matches!(address, SocketAddr::V6(v6) if v6.scope_id() != 0 || v6.flowinfo() != 0)
        })
    {
        return Err(FailureReason::UnsafeDestination);
    }
    addresses
        .first()
        .copied()
        .ok_or(FailureReason::UnsafeDestination)
}

fn is_public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => !IPV4_NON_PUBLIC_RANGES
            .iter()
            .any(|&(start, end)| (start..=end).contains(&u32::from(ip))),
        IpAddr::V6(ip) => {
            let words = ip.segments();
            let first = words[0];
            let second = words[1];
            if !(IPV6_GLOBAL_UNICAST_FIRST_MIN..=IPV6_GLOBAL_UNICAST_FIRST_MAX).contains(&first) {
                return false;
            }
            if first == IPV6_IETF_PROTOCOL_ASSIGNMENTS_FIRST
                && second <= IPV6_IETF_PROTOCOL_ASSIGNMENTS_SECOND_MAX
            {
                return (second == IPV6_SPECIAL_EXACT_SECOND
                    && words[2..7].iter().all(|&word| word == 0)
                    && (IPV6_SPECIAL_EXACT_LAST_MIN..=IPV6_SPECIAL_EXACT_LAST_MAX)
                        .contains(&words[7]))
                    || second == IPV6_AMT_SECOND
                    || (second == IPV6_AS112_SECOND && words[2] == IPV6_AS112_THIRD)
                    || (IPV6_ORCHID_SECOND_MIN..=IPV6_ORCHID_SECOND_MAX).contains(&second)
                    || (IPV6_DRONE_REMOTE_ID_SECOND_MIN..=IPV6_DRONE_REMOTE_ID_SECOND_MAX)
                        .contains(&second);
            }
            !(first == IPV6_IETF_PROTOCOL_ASSIGNMENTS_FIRST && second == IPV6_DOCUMENTATION_SECOND
                || first == IPV6_EXPANDED_DOCUMENTATION_FIRST
                    && second <= IPV6_EXPANDED_DOCUMENTATION_SECOND_MAX
                || first == IPV6_SIX_TO_FOUR_FIRST)
        }
    }
}
