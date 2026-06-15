#![deny(unsafe_code)]

use std::cell::Cell;
use std::os::fd::{AsRawFd, OwnedFd};

use nix::errno::Errno;
#[cfg(test)]
use nix::sys::socket::socketpair;
use nix::sys::socket::{
    AddressFamily, MsgFlags, NetlinkAddr, SockFlag, SockProtocol, SockType, bind, recv, send,
    setsockopt, socket, sockopt,
};
use nix::sys::time::{TimeVal, TimeValLike};

use crate::error::{NbdCowError, Result};

use super::wire;

pub(super) struct GenlSocket {
    fd: OwnedFd,
    next_seq: Cell<u32>,
}

impl GenlSocket {
    fn next_seq(&self) -> u32 {
        let seq = self.next_seq.get();
        self.next_seq.set(seq.wrapping_add(1).max(1));
        seq
    }
}

fn errno_to_io(err: Errno) -> NbdCowError {
    NbdCowError::Io(err.into())
}

pub(super) fn open_genl_socket() -> Result<GenlSocket> {
    let fd = socket(
        AddressFamily::Netlink,
        SockType::Datagram,
        SockFlag::empty(),
        SockProtocol::NetlinkGeneric,
    )
    .map_err(errno_to_io)?;

    bind(fd.as_raw_fd(), &NetlinkAddr::new(0, 0)).map_err(errno_to_io)?;

    // Set a receive timeout so recv() doesn't block forever if the
    // kernel never sends a completion message (e.g., nbd module unloaded
    // mid-call).
    setsockopt(&fd, sockopt::ReceiveTimeout, &TimeVal::seconds(5)).map_err(errno_to_io)?;

    Ok(GenlSocket {
        fd,
        next_seq: Cell::new(1),
    })
}

pub(super) fn send_genl_msg(
    sock: &GenlSocket,
    msg_type: u16,
    cmd: u8,
    version: u8,
    attrs: &[u8],
    request_ack: bool,
) -> Result<u32> {
    let seq = sock.next_seq();
    let msg = wire::build_genl_msg(msg_type, cmd, version, attrs, seq, request_ack);
    send_nl(sock, &msg)?;
    Ok(seq)
}

pub(super) fn recv_for_seq(sock: &GenlSocket, buf: &mut [u8], expected_seq: u32) -> Result<usize> {
    loop {
        let n = recv_nl(sock, buf)?;
        if wire::parse_nl_header(buf, n)?.seq == expected_seq {
            return Ok(n);
        }
    }
}

fn send_nl(sock: &GenlSocket, msg: &[u8]) -> Result<()> {
    send(sock.fd.as_raw_fd(), msg, MsgFlags::empty()).map_err(errno_to_io)?;
    Ok(())
}

fn recv_nl(sock: &GenlSocket, buf: &mut [u8]) -> Result<usize> {
    loop {
        match recv(sock.fd.as_raw_fd(), buf, MsgFlags::empty()) {
            Ok(n) => return Ok(n),
            Err(Errno::EINTR) => {
                // EINTR — retry
            }
            Err(err) => return Err(errno_to_io(err)),
        }
    }
}

#[cfg(test)]
pub(super) fn test_genl_socket_pair() -> (GenlSocket, OwnedFd) {
    let (recv_fd, send_fd) = socketpair(
        AddressFamily::Unix,
        SockType::Datagram,
        None,
        SockFlag::empty(),
    )
    .unwrap();
    set_test_recv_timeout(&recv_fd);
    (
        GenlSocket {
            fd: recv_fd,
            next_seq: Cell::new(1),
        },
        send_fd,
    )
}

#[cfg(test)]
pub(super) fn send_test_nl(peer: &OwnedFd, msg: &[u8]) {
    assert_eq!(
        send(peer.as_raw_fd(), msg, MsgFlags::empty()).unwrap(),
        msg.len()
    );
}

#[cfg(test)]
fn set_test_recv_timeout(fd: &OwnedFd) {
    setsockopt(fd, sockopt::ReceiveTimeout, &TimeVal::microseconds(100_000)).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_seq_wraps_without_returning_zero() {
        let (sock, _peer) = test_genl_socket_pair();
        sock.next_seq.set(u32::MAX);

        assert_eq!(sock.next_seq(), u32::MAX);
        assert_eq!(sock.next_seq(), 1);
    }

    #[test]
    fn recv_for_seq_ignores_stale_family_reply() {
        let (sock, peer) = test_genl_socket_pair();
        let expected_seq = 42;

        let stale_attrs = wire::build_nla(1, &999u16.to_ne_bytes());
        let stale_reply = wire::build_genl_msg(0x10, 3, 1, &stale_attrs, expected_seq + 1, false);
        let matching_attrs = wire::build_nla(1, &123u16.to_ne_bytes());
        let matching_reply = wire::build_genl_msg(0x10, 3, 1, &matching_attrs, expected_seq, false);

        send_test_nl(&peer, &stale_reply);
        send_test_nl(&peer, &matching_reply);

        let mut buf = vec![0u8; 4096];
        let n = recv_for_seq(&sock, &mut buf, expected_seq).unwrap();
        assert!(matches!(
            wire::parse_genl_response(&buf, n),
            Ok(wire::GenlResponse::Reply { .. })
        ));
        assert_eq!(wire::parse_nl_header(&buf, n).unwrap().seq, expected_seq);
    }

    #[test]
    fn recv_for_seq_ignores_stale_malformed_payload_after_header_parse() {
        let (sock, peer) = test_genl_socket_pair();
        let mut stale = wire::build_nlmsg_error_for_test(1, -libc::EBUSY);
        wire::set_nlmsg_len_for_test(&mut stale, 15);
        let matching = wire::build_nlmsg_error_for_test(2, 0);

        send_test_nl(&peer, &stale);
        send_test_nl(&peer, &matching);

        let mut buf = vec![0u8; 4096];
        let n = recv_for_seq(&sock, &mut buf, 2).unwrap();
        assert_eq!(wire::parse_nl_header(&buf, n).unwrap().seq, 2);
    }
}
