use std::cell::Cell;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

use crate::error::{NbdCowError, Result};

use super::wire;

const NETLINK_GENERIC: i32 = 16;

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

pub(super) fn open_genl_socket() -> Result<GenlSocket> {
    let fd = unsafe { libc::socket(libc::AF_NETLINK, libc::SOCK_DGRAM, NETLINK_GENERIC) };
    if fd < 0 {
        return Err(NbdCowError::Io(std::io::Error::last_os_error()));
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };

    // Bind to kernel
    let mut addr: libc::sockaddr_nl = unsafe { std::mem::zeroed() };
    addr.nl_family = libc::AF_NETLINK as u16;
    let ret = unsafe {
        libc::bind(
            fd.as_raw_fd(),
            std::ptr::from_ref(&addr).cast(),
            std::mem::size_of::<libc::sockaddr_nl>() as u32,
        )
    };
    if ret < 0 {
        return Err(NbdCowError::Io(std::io::Error::last_os_error()));
    }

    // Set a receive timeout so recv() doesn't block forever if the
    // kernel never sends a completion message (e.g., nbd module unloaded
    // mid-call).
    let timeout = libc::timeval {
        tv_sec: 5,
        tv_usec: 0,
    };
    let ret = unsafe {
        libc::setsockopt(
            fd.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_RCVTIMEO,
            std::ptr::from_ref(&timeout).cast(),
            std::mem::size_of::<libc::timeval>() as u32,
        )
    };
    if ret < 0 {
        return Err(NbdCowError::Io(std::io::Error::last_os_error()));
    }

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
    let ret = unsafe { libc::send(sock.fd.as_raw_fd(), msg.as_ptr().cast(), msg.len(), 0) };
    if ret < 0 {
        return Err(NbdCowError::Io(std::io::Error::last_os_error()));
    }

    Ok(())
}

fn recv_nl(sock: &GenlSocket, buf: &mut [u8]) -> Result<usize> {
    loop {
        let n = unsafe { libc::recv(sock.fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len(), 0) };
        if n >= 0 {
            return Ok(n as usize);
        }
        let err = std::io::Error::last_os_error();
        if err.kind() != std::io::ErrorKind::Interrupted {
            return Err(NbdCowError::Io(err));
        }
        // EINTR — retry
    }
}

#[cfg(test)]
pub(super) fn test_genl_socket_pair() -> (GenlSocket, OwnedFd) {
    let mut fds = [0i32; 2];
    let ret = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_DGRAM, 0, fds.as_mut_ptr()) };
    assert_eq!(ret, 0);

    let recv_fd = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    let send_fd = unsafe { OwnedFd::from_raw_fd(fds[1]) };
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
    let ret = unsafe { libc::send(peer.as_raw_fd(), msg.as_ptr().cast(), msg.len(), 0) };
    assert_eq!(ret, msg.len() as isize);
}

#[cfg(test)]
fn set_test_recv_timeout(fd: &OwnedFd) {
    let timeout = libc::timeval {
        tv_sec: 0,
        tv_usec: 100_000,
    };
    let ret = unsafe {
        libc::setsockopt(
            fd.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_RCVTIMEO,
            std::ptr::from_ref(&timeout).cast(),
            std::mem::size_of::<libc::timeval>() as u32,
        )
    };
    assert_eq!(ret, 0);
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
            wire::parse_nl_msg(&buf, n),
            Ok(wire::NlMsg::Reply)
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
