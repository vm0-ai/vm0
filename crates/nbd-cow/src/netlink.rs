//! NBD device setup via generic netlink.
//!
//! This module handles creating and destroying `/dev/nbdN` devices using the
//! kernel's NBD generic netlink interface. This is the modern approach (vs ioctl)
//! and supports multi-connection.

use std::os::unix::io::{FromRawFd, OwnedFd};
use std::path::Path;

use crate::error::{NbdCowError, Result};

// NBD generic netlink command constants
const NBD_CMD_CONNECT: u8 = 0;
const NBD_CMD_DISCONNECT: u8 = 1;

// NBD generic netlink attribute types
const NBD_ATTR_INDEX: u16 = 1;
const NBD_ATTR_SIZE_BYTES: u16 = 2;
const NBD_ATTR_BLOCK_SIZE_BYTES: u16 = 3;
const NBD_ATTR_SERVER_FLAGS: u16 = 5;
const NBD_ATTR_SOCKETS: u16 = 7;
const NBD_SOCK_FD: u16 = 0;

// NBD server flags
const NBD_FLAG_HAS_FLAGS: u64 = 1 << 0;
const NBD_FLAG_CAN_MULTI_CONN: u64 = 1 << 8;

// Netlink constants
const NETLINK_GENERIC: i32 = 16;
const GENL_ID_CTRL: u16 = 0x10;
const CTRL_CMD_GETFAMILY: u8 = 3;
const CTRL_ATTR_FAMILY_NAME: u16 = 2;
const CTRL_ATTR_FAMILY_ID: u16 = 1;

const NLM_F_REQUEST: u16 = 1;
const NLM_F_ACK: u16 = 4;

const NLMSG_ERROR: u16 = 2;

/// Create a Unix socketpair for NBD communication.
pub fn create_socketpair() -> Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0i32; 2];
    let ret = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) };
    if ret < 0 {
        return Err(NbdCowError::Io(std::io::Error::last_os_error()));
    }
    let fd0 = fds
        .first()
        .copied()
        .ok_or_else(|| NbdCowError::Io(std::io::Error::other("failed to get fd[0]")))?;
    let fd1 = fds
        .get(1)
        .copied()
        .ok_or_else(|| NbdCowError::Io(std::io::Error::other("failed to get fd[1]")))?;
    Ok(unsafe { (OwnedFd::from_raw_fd(fd0), OwnedFd::from_raw_fd(fd1)) })
}

/// Find a free NBD device by scanning `/sys/block/nbdN/pid`.
///
/// A device is free if its pid file contains "0" or "-1" or does not exist.
pub fn find_free_device() -> Result<u32> {
    for i in 0..256u32 {
        let pid_path = format!("/sys/block/nbd{i}/pid");
        let path = Path::new(&pid_path);

        if !path.exists() {
            // Device exists in kernel but no pid file -> free
            // But first check if the device node exists
            let dev_path = format!("/dev/nbd{i}");
            if Path::new(&dev_path).exists() {
                return Ok(i);
            }
            continue;
        }

        match std::fs::read_to_string(path) {
            Ok(contents) => {
                let pid = contents.trim();
                if pid == "-1" || pid == "0" || pid.is_empty() {
                    return Ok(i);
                }
            }
            Err(_) => {
                // Can't read pid file -> assume free
                return Ok(i);
            }
        }
    }

    Err(NbdCowError::NoFreeDevice)
}

/// Connect an NBD device via generic netlink.
///
/// This passes the client-side socket fds to the kernel, which takes ownership
/// of them for the NBD device's I/O.
pub fn connect(
    device_index: u32,
    client_fds: &[OwnedFd],
    size: u64,
    block_size: u32,
) -> Result<()> {
    let sock = open_genl_socket()?;
    let family_id = resolve_nbd_family(&sock)?;
    let flags = NBD_FLAG_HAS_FLAGS | NBD_FLAG_CAN_MULTI_CONN;

    // Build nested SOCKETS attribute
    let mut sockets_payload = Vec::new();
    for (i, fd) in client_fds.iter().enumerate() {
        let raw_fd = std::os::unix::io::AsRawFd::as_raw_fd(fd) as u32;
        // Each socket is a nested attribute containing NBD_SOCK_FD
        let fd_nla = build_nla(NBD_SOCK_FD, &raw_fd.to_ne_bytes());
        let sock_nla = build_nested_nla((i as u16) + 1, &fd_nla);
        sockets_payload.extend_from_slice(&sock_nla);
    }

    // Build the full message
    let mut attrs = Vec::new();
    attrs.extend_from_slice(&build_nla(NBD_ATTR_INDEX, &device_index.to_ne_bytes()));
    attrs.extend_from_slice(&build_nla(NBD_ATTR_SIZE_BYTES, &size.to_ne_bytes()));
    attrs.extend_from_slice(&build_nla(
        NBD_ATTR_BLOCK_SIZE_BYTES,
        &block_size.to_ne_bytes(),
    ));
    attrs.extend_from_slice(&build_nla(NBD_ATTR_SERVER_FLAGS, &flags.to_ne_bytes()));
    attrs.extend_from_slice(&build_nested_nla(NBD_ATTR_SOCKETS, &sockets_payload));

    send_genl_msg(&sock, family_id, NBD_CMD_CONNECT, &attrs)?;
    recv_genl_ack(&sock)?;

    Ok(())
}

/// Disconnect an NBD device via generic netlink.
pub fn disconnect(device_index: u32) -> Result<()> {
    let sock = open_genl_socket()?;
    let family_id = resolve_nbd_family(&sock)?;

    let attrs = build_nla(NBD_ATTR_INDEX, &device_index.to_ne_bytes());
    send_genl_msg(&sock, family_id, NBD_CMD_DISCONNECT, &attrs)?;
    recv_genl_ack(&sock)?;

    Ok(())
}

// --- Internal netlink helpers ---

struct GenlSocket {
    fd: OwnedFd,
}

fn open_genl_socket() -> Result<GenlSocket> {
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
            std::os::unix::io::AsRawFd::as_raw_fd(&fd),
            std::ptr::from_ref(&addr).cast(),
            std::mem::size_of::<libc::sockaddr_nl>() as u32,
        )
    };
    if ret < 0 {
        return Err(NbdCowError::Io(std::io::Error::last_os_error()));
    }

    Ok(GenlSocket { fd })
}

fn resolve_nbd_family(sock: &GenlSocket) -> Result<u16> {
    // Build CTRL_CMD_GETFAMILY request for "nbd"
    let name = b"nbd\0";
    let attrs = build_nla(CTRL_ATTR_FAMILY_NAME, name);
    send_genl_msg_raw(sock, GENL_ID_CTRL, CTRL_CMD_GETFAMILY, 1, &attrs)?;

    // Parse response to get family ID
    let mut buf = vec![0u8; 4096];
    let n = recv_nl(sock, &mut buf)?;
    let msg = buf
        .get(..n)
        .ok_or_else(|| NbdCowError::Netlink("recv length exceeds buffer".into()))?;

    // Skip nlmsghdr (16 bytes) + genlmsghdr (4 bytes)
    if msg.len() < 20 {
        return Err(NbdCowError::Netlink("response too short".into()));
    }

    // Parse attributes to find CTRL_ATTR_FAMILY_ID
    let mut offset = 20;
    while offset + 4 <= msg.len() {
        let nla_len = u16::from_ne_bytes([
            *msg.get(offset)
                .ok_or_else(|| NbdCowError::Netlink("truncated nla".into()))?,
            *msg.get(offset + 1)
                .ok_or_else(|| NbdCowError::Netlink("truncated nla".into()))?,
        ]) as usize;
        let nla_type = u16::from_ne_bytes([
            *msg.get(offset + 2)
                .ok_or_else(|| NbdCowError::Netlink("truncated nla".into()))?,
            *msg.get(offset + 3)
                .ok_or_else(|| NbdCowError::Netlink("truncated nla".into()))?,
        ]);

        if nla_type == CTRL_ATTR_FAMILY_ID && nla_len >= 6 {
            let id = u16::from_ne_bytes([
                *msg.get(offset + 4)
                    .ok_or_else(|| NbdCowError::Netlink("truncated id".into()))?,
                *msg.get(offset + 5)
                    .ok_or_else(|| NbdCowError::Netlink("truncated id".into()))?,
            ]);
            return Ok(id);
        }

        // Advance to next attribute (4-byte aligned)
        let aligned = (nla_len + 3) & !3;
        if aligned == 0 {
            break;
        }
        offset += aligned;
    }

    Err(NbdCowError::Netlink(
        "NBD family ID not found in response".into(),
    ))
}

fn send_genl_msg(sock: &GenlSocket, family_id: u16, cmd: u8, attrs: &[u8]) -> Result<()> {
    send_genl_msg_raw(sock, family_id, cmd, 0, attrs)
}

fn send_genl_msg_raw(
    sock: &GenlSocket,
    msg_type: u16,
    cmd: u8,
    version: u8,
    attrs: &[u8],
) -> Result<()> {
    // nlmsghdr (16) + genlmsghdr (4) + attrs
    let total_len = 16 + 4 + attrs.len();
    let mut msg = vec![0u8; total_len];

    // nlmsghdr
    let len_bytes = (total_len as u32).to_ne_bytes();
    // Safe: msg is at least 20 bytes (16 + 4)
    let header = msg
        .get_mut(..20)
        .ok_or_else(|| NbdCowError::Netlink("msg buffer too small for header".into()))?;
    header
        .get_mut(..4)
        .ok_or_else(|| NbdCowError::Netlink("msg buffer too small".into()))?
        .copy_from_slice(&len_bytes);
    header
        .get_mut(4..6)
        .ok_or_else(|| NbdCowError::Netlink("msg buffer too small".into()))?
        .copy_from_slice(&msg_type.to_ne_bytes());
    header
        .get_mut(6..8)
        .ok_or_else(|| NbdCowError::Netlink("msg buffer too small".into()))?
        .copy_from_slice(&(NLM_F_REQUEST | NLM_F_ACK).to_ne_bytes());
    // seq and pid left as 0

    // genlmsghdr
    if let Some(b) = header.get_mut(16) {
        *b = cmd;
    }
    if let Some(b) = header.get_mut(17) {
        *b = version;
    }
    // reserved (2 bytes) = 0

    // attributes
    msg.get_mut(20..)
        .ok_or_else(|| NbdCowError::Netlink("msg buffer too small for attrs".into()))?
        .copy_from_slice(attrs);

    let ret = unsafe {
        libc::send(
            std::os::unix::io::AsRawFd::as_raw_fd(&sock.fd),
            msg.as_ptr().cast(),
            msg.len(),
            0,
        )
    };
    if ret < 0 {
        return Err(NbdCowError::Io(std::io::Error::last_os_error()));
    }

    Ok(())
}

fn recv_nl(sock: &GenlSocket, buf: &mut [u8]) -> Result<usize> {
    let n = unsafe {
        libc::recv(
            std::os::unix::io::AsRawFd::as_raw_fd(&sock.fd),
            buf.as_mut_ptr().cast(),
            buf.len(),
            0,
        )
    };
    if n < 0 {
        return Err(NbdCowError::Io(std::io::Error::last_os_error()));
    }
    Ok(n as usize)
}

fn recv_genl_ack(sock: &GenlSocket) -> Result<()> {
    let mut buf = vec![0u8; 4096];
    let n = recv_nl(sock, &mut buf)?;

    if n < 16 {
        return Err(NbdCowError::Netlink("ack response too short".into()));
    }

    let msg_type = u16::from_ne_bytes([
        *buf.get(4)
            .ok_or_else(|| NbdCowError::Netlink("ack too short for msg_type".into()))?,
        *buf.get(5)
            .ok_or_else(|| NbdCowError::Netlink("ack too short for msg_type".into()))?,
    ]);
    if msg_type == NLMSG_ERROR {
        // Error message: nlmsghdr (16) + error code (4 bytes as i32)
        if n < 20 {
            return Err(NbdCowError::Netlink("error response too short".into()));
        }
        let error = i32::from_ne_bytes([
            *buf.get(16)
                .ok_or_else(|| NbdCowError::Netlink("error response truncated".into()))?,
            *buf.get(17)
                .ok_or_else(|| NbdCowError::Netlink("error response truncated".into()))?,
            *buf.get(18)
                .ok_or_else(|| NbdCowError::Netlink("error response truncated".into()))?,
            *buf.get(19)
                .ok_or_else(|| NbdCowError::Netlink("error response truncated".into()))?,
        ]);
        if error == 0 {
            return Ok(()); // ACK (error=0 means success)
        }
        return Err(NbdCowError::Netlink(format!(
            "netlink error: {}",
            std::io::Error::from_raw_os_error(-error)
        )));
    }

    Ok(())
}

/// Build a netlink attribute (NLA).
fn build_nla(nla_type: u16, payload: &[u8]) -> Vec<u8> {
    let nla_len = 4 + payload.len();
    let aligned_len = (nla_len + 3) & !3;
    let mut buf = vec![0u8; aligned_len];
    if let Some(header) = buf.get_mut(..4) {
        let len_bytes = (nla_len as u16).to_ne_bytes();
        if let Some(s) = header.get_mut(..2) {
            s.copy_from_slice(&len_bytes);
        }
        if let Some(s) = header.get_mut(2..4) {
            s.copy_from_slice(&nla_type.to_ne_bytes());
        }
    }
    if let Some(dest) = buf.get_mut(4..4 + payload.len()) {
        dest.copy_from_slice(payload);
    }
    buf
}

/// Build a nested netlink attribute.
fn build_nested_nla(nla_type: u16, payload: &[u8]) -> Vec<u8> {
    let nla_len = 4 + payload.len();
    let aligned_len = (nla_len + 3) & !3;
    let mut buf = vec![0u8; aligned_len];
    // Set NLA_F_NESTED flag (1 << 15)
    let nested_type = nla_type | (1 << 15);
    if let Some(header) = buf.get_mut(..4) {
        let len_bytes = (nla_len as u16).to_ne_bytes();
        if let Some(s) = header.get_mut(..2) {
            s.copy_from_slice(&len_bytes);
        }
        if let Some(s) = header.get_mut(2..4) {
            s.copy_from_slice(&nested_type.to_ne_bytes());
        }
    }
    if let Some(dest) = buf.get_mut(4..4 + payload.len()) {
        dest.copy_from_slice(payload);
    }
    buf
}
