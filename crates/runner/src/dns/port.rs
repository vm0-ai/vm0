/// Reserved TCP/UDP port for the runner-managed dnsmasq process.
pub(crate) struct DnsPortReservation {
    port: u16,
    _tcp: ReservedTcpPort,
    _udp: std::net::UdpSocket,
}

impl DnsPortReservation {
    /// Return the reserved port.
    pub(crate) fn port(&self) -> u16 {
        self.port
    }
}

struct ReservedTcpPort {
    port: u16,
    _socket: tokio::net::TcpSocket,
}

impl ReservedTcpPort {
    fn bind(port: u16) -> std::io::Result<Self> {
        let socket = tokio::net::TcpSocket::new_v4()?;
        socket.bind(std::net::SocketAddr::from(([0, 0, 0, 0], port)))?;
        Ok(Self {
            port: socket.local_addr()?.port(),
            _socket: socket,
        })
    }

    fn port(&self) -> u16 {
        self.port
    }
}

/// Reserve an available port by binding to port 0 without listening.
///
/// Checks both TCP and UDP because dnsmasq binds both protocols.
pub(crate) fn reserve_port() -> std::io::Result<DnsPortReservation> {
    const MAX_PORT_PROBE_ATTEMPTS: usize = 64;

    reserve_port_from((0..MAX_PORT_PROBE_ATTEMPTS).map(|_| ReservedTcpPort::bind(0)))
}

#[cfg(test)]
fn find_available_port_from<I>(tcp_candidates: I) -> std::io::Result<u16>
where
    I: IntoIterator<Item = std::io::Result<ReservedTcpPort>>,
{
    Ok(reserve_port_from(tcp_candidates)?.port())
}

fn reserve_port_from<I>(tcp_candidates: I) -> std::io::Result<DnsPortReservation>
where
    I: IntoIterator<Item = std::io::Result<ReservedTcpPort>>,
{
    let mut last_addr_in_use = None;
    for tcp in tcp_candidates {
        let tcp = tcp?;
        let port = tcp.port();
        match std::net::UdpSocket::bind(("0.0.0.0", port)) {
            Ok(udp) => {
                return Ok(DnsPortReservation {
                    port,
                    _tcp: tcp,
                    _udp: udp,
                });
            }
            Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
                last_addr_in_use = Some(err);
            }
            Err(err) => return Err(err),
        }
    }

    Err(last_addr_in_use.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AddrInUse,
            "could not find a port available for both TCP and UDP",
        )
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserve_port_returns_nonzero() {
        let reservation = reserve_port().unwrap();
        assert!(reservation.port() > 0);
    }

    fn bind_tcp_udp_pair() -> std::io::Result<(ReservedTcpPort, std::net::UdpSocket)> {
        const MAX_PORT_PROBE_ATTEMPTS: usize = 64;

        let mut last_addr_in_use = None;
        for _ in 0..MAX_PORT_PROBE_ATTEMPTS {
            let tcp = ReservedTcpPort::bind(0)?;
            let port = tcp.port();
            match std::net::UdpSocket::bind(("0.0.0.0", port)) {
                Ok(udp) => return Ok((tcp, udp)),
                Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
                    last_addr_in_use = Some(err);
                }
                Err(err) => return Err(err),
            }
        }

        Err(last_addr_in_use.unwrap_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                "could not find a port available for both TCP and UDP",
            )
        }))
    }

    #[test]
    fn find_available_port_retries_when_udp_candidate_is_in_use() {
        let (busy_tcp, _busy_udp) = bind_tcp_udp_pair().unwrap();
        let (free_tcp, free_udp_probe) = bind_tcp_udp_pair().unwrap();
        let free_port = free_tcp.port();
        drop(free_udp_probe);

        let port = find_available_port_from([Ok(busy_tcp), Ok(free_tcp)]).unwrap();

        assert_eq!(port, free_port);
    }
}
