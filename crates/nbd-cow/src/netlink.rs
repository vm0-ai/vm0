//! NBD device setup via generic netlink.
//!
//! This module handles creating and destroying `/dev/nbdN` devices using the
//! kernel's NBD generic netlink interface. This is the modern approach (vs ioctl)
//! and supports multi-connection.
//!
//! A `NBD_ATTR_DEAD_CONN_TIMEOUT` of 30 seconds is set on every connect so
//! I/O on dead devices fails after 30s instead of hanging forever. Note: this
//! does NOT auto-disconnect the device — explicit `disconnect()` is still
//! required (handled by `Drop` normally, or by `runner gc` after SIGKILL).

use std::os::unix::io::{FromRawFd, OwnedFd};
use std::path::Path;

use crate::error::{NbdCowError, Result};

// NBD generic netlink command constants (from include/uapi/linux/nbd-netlink.h)
const NBD_CMD_CONNECT: u8 = 1;
const NBD_CMD_DISCONNECT: u8 = 2;

// NBD generic netlink attribute types
const NBD_ATTR_INDEX: u16 = 1;
const NBD_ATTR_SIZE_BYTES: u16 = 2;
const NBD_ATTR_BLOCK_SIZE_BYTES: u16 = 3;
const NBD_ATTR_SERVER_FLAGS: u16 = 5;
const NBD_ATTR_SOCKETS: u16 = 7;
const NBD_ATTR_DEAD_CONN_TIMEOUT: u16 = 8;

// NBD socket item attribute types (nested inside NBD_ATTR_SOCKETS)
const NBD_SOCK_ITEM: u16 = 1;
const NBD_SOCK_FD: u16 = 1;

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

/// Read the kernel's nbds_max parameter to know how many devices are available.
///
/// Falls back to 256 when the sysfs parameter is unreadable (module not loaded).
/// The actual limit is set by ansible (`modprobe nbd nbds_max=4096`).
fn nbds_max() -> u32 {
    std::fs::read_to_string("/sys/module/nbd/parameters/nbds_max")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(256)
}

/// Check if a device index appears free by inspecting its pid file.
fn device_appears_free(index: u32) -> bool {
    let pid_path = format!("/sys/block/nbd{index}/pid");
    let path = Path::new(&pid_path);

    if !path.exists() {
        // No pid file — free if the device node exists
        return Path::new(&format!("/dev/nbd{index}")).exists();
    }

    match std::fs::read_to_string(path) {
        Ok(contents) => {
            let pid = contents.trim();
            pid == "-1" || pid == "0" || pid.is_empty()
        }
        Err(_) => true, // Can't read pid file → assume free
    }
}

/// Atomically find a free NBD device and connect it.
///
/// Iterates candidate devices, attempts `connect` on each one that appears free.
/// If the kernel returns EBUSY (another process grabbed it first), tries the next
/// device. This eliminates the TOCTOU race between find and connect.
///
/// Returns the device index on success.
pub fn find_and_connect(client_fds: &[OwnedFd], size: u64, block_size: u64) -> Result<u32> {
    let max = nbds_max();

    let sock = open_genl_socket()?;
    let family_id = resolve_nbd_family(&sock)?;

    // Build socket attributes once (reused across attempts)
    let sockets_nla = build_sockets_nla(client_fds);
    let flags = NBD_FLAG_HAS_FLAGS | NBD_FLAG_CAN_MULTI_CONN;

    for i in 0..max {
        if !device_appears_free(i) {
            continue;
        }

        // Build per-device attributes
        let mut attrs = Vec::new();
        attrs.extend_from_slice(&build_nla(NBD_ATTR_INDEX, &i.to_ne_bytes()));
        attrs.extend_from_slice(&build_nla(NBD_ATTR_SIZE_BYTES, &size.to_ne_bytes()));
        attrs.extend_from_slice(&build_nla(
            NBD_ATTR_BLOCK_SIZE_BYTES,
            &block_size.to_ne_bytes(),
        ));
        attrs.extend_from_slice(&build_nla(NBD_ATTR_SERVER_FLAGS, &flags.to_ne_bytes()));
        // Fail I/O after 30s on dead sockets (SIGKILL where Drop can't run).
        // Does NOT auto-disconnect — `runner gc` handles orphan cleanup.
        let dead_conn_timeout: u64 = 30;
        attrs.extend_from_slice(&build_nla(
            NBD_ATTR_DEAD_CONN_TIMEOUT,
            &dead_conn_timeout.to_ne_bytes(),
        ));
        attrs.extend_from_slice(&sockets_nla);

        send_genl_msg(&sock, family_id, NBD_CMD_CONNECT, &attrs)?;
        match recv_genl_ack(&sock) {
            Ok(()) => return Ok(i),
            Err(NbdCowError::NetlinkErrno { errno, .. }) if errno == libc::EBUSY => {
                // Device was grabbed by another process — try next
                continue;
            }
            Err(e) => return Err(e),
        }
    }

    Err(NbdCowError::NoFreeDevice)
}

/// Check whether the device has the expected size via sysfs.
///
/// Returns `true` if the size matches within a brief polling window.
/// On reconnect (same index after a recent disconnect), the kernel may
/// briefly report the old (zero) capacity before the new config takes
/// effect. A few milliseconds of polling handles this.
///
/// Uses sync `std::fs::read_to_string` for sysfs reads — these are
/// kernel-memory backed and complete in microseconds, so they do not
/// meaningfully block the tokio worker thread.
pub async fn verify_device_size(device_index: u32, expected_size: u64) -> bool {
    debug_assert!(
        expected_size.is_multiple_of(512),
        "expected_size must be 512-aligned"
    );
    let expected_sectors = expected_size / 512;
    let size_path = format!("/sys/block/nbd{device_index}/size");
    for _ in 0..5 {
        if let Ok(content) = std::fs::read_to_string(&size_path) {
            let sectors: u64 = content.trim().parse().unwrap_or(0);
            if sectors == expected_sectors {
                return true;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    false
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

    // Set a receive timeout so recv() doesn't block forever if the
    // kernel never sends an ACK (e.g., nbd module unloaded mid-call).
    let timeout = libc::timeval {
        tv_sec: 5,
        tv_usec: 0,
    };
    let ret = unsafe {
        libc::setsockopt(
            std::os::unix::io::AsRawFd::as_raw_fd(&fd),
            libc::SOL_SOCKET,
            libc::SO_RCVTIMEO,
            std::ptr::from_ref(&timeout).cast(),
            std::mem::size_of::<libc::timeval>() as u32,
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
        let nla_len_bytes: [u8; 2] = msg
            .get(offset..offset + 2)
            .ok_or_else(|| NbdCowError::Netlink("truncated nla".into()))?
            .try_into()
            .map_err(|_| NbdCowError::Netlink("nla len conversion".into()))?;
        let nla_type_bytes: [u8; 2] = msg
            .get(offset + 2..offset + 4)
            .ok_or_else(|| NbdCowError::Netlink("truncated nla".into()))?
            .try_into()
            .map_err(|_| NbdCowError::Netlink("nla type conversion".into()))?;
        let nla_len = u16::from_ne_bytes(nla_len_bytes) as usize;
        let nla_type = u16::from_ne_bytes(nla_type_bytes);

        if nla_type == CTRL_ATTR_FAMILY_ID && nla_len >= 6 {
            let id_bytes: [u8; 2] = msg
                .get(offset + 4..offset + 6)
                .ok_or_else(|| NbdCowError::Netlink("truncated family id".into()))?
                .try_into()
                .map_err(|_| NbdCowError::Netlink("id conversion".into()))?;
            return Ok(u16::from_ne_bytes(id_bytes));
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

// NBD genl family version (from kernel: NBD_GENL_VERSION = 0x1)
const NBD_GENL_VERSION: u8 = 1;

fn send_genl_msg(sock: &GenlSocket, family_id: u16, cmd: u8, attrs: &[u8]) -> Result<()> {
    send_genl_msg_raw(sock, family_id, cmd, NBD_GENL_VERSION, attrs)
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

    // nlmsghdr: length(4) + type(2) + flags(2) + seq(4) + pid(4)
    if let Some(s) = msg.get_mut(..4) {
        s.copy_from_slice(&(total_len as u32).to_ne_bytes());
    }
    if let Some(s) = msg.get_mut(4..6) {
        s.copy_from_slice(&msg_type.to_ne_bytes());
    }
    if let Some(s) = msg.get_mut(6..8) {
        s.copy_from_slice(&(NLM_F_REQUEST | NLM_F_ACK).to_ne_bytes());
    }
    // seq and pid left as 0

    // genlmsghdr: cmd(1) + version(1) + reserved(2)
    if let Some(b) = msg.get_mut(16) {
        *b = cmd;
    }
    if let Some(b) = msg.get_mut(17) {
        *b = version;
    }

    // attributes
    if let Some(dest) = msg.get_mut(20..) {
        dest.copy_from_slice(attrs);
    }

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
    loop {
        let n = unsafe {
            libc::recv(
                std::os::unix::io::AsRawFd::as_raw_fd(&sock.fd),
                buf.as_mut_ptr().cast(),
                buf.len(),
                0,
            )
        };
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

fn recv_genl_ack(sock: &GenlSocket) -> Result<()> {
    let mut buf = vec![0u8; 4096];
    let n = recv_nl(sock, &mut buf)?;

    if n < 16 {
        return Err(NbdCowError::Netlink("ack response too short".into()));
    }

    let type_bytes: [u8; 2] = buf
        .get(4..6)
        .ok_or_else(|| NbdCowError::Netlink("ack too short for msg_type".into()))?
        .try_into()
        .map_err(|_| NbdCowError::Netlink("msg_type conversion".into()))?;
    let msg_type = u16::from_ne_bytes(type_bytes);
    if msg_type == NLMSG_ERROR {
        // Error message: nlmsghdr (16) + error code (4 bytes as i32)
        if n < 20 {
            return Err(NbdCowError::Netlink("error response too short".into()));
        }
        let err_bytes: [u8; 4] = buf
            .get(16..20)
            .ok_or_else(|| NbdCowError::Netlink("error response truncated".into()))?
            .try_into()
            .map_err(|_| NbdCowError::Netlink("error code conversion".into()))?;
        let error = i32::from_ne_bytes(err_bytes);
        if error == 0 {
            return Ok(()); // ACK (error=0 means success)
        }
        let errno = -error;
        return Err(NbdCowError::NetlinkErrno {
            errno,
            message: std::io::Error::from_raw_os_error(errno).to_string(),
        });
    }

    tracing::debug!(msg_type, "recv_genl_ack: ignoring non-error message type");
    Ok(())
}

/// Build the nested NBD_ATTR_SOCKETS NLA from a list of client fds.
fn build_sockets_nla(client_fds: &[OwnedFd]) -> Vec<u8> {
    let mut sockets_payload = Vec::new();
    for fd in client_fds.iter() {
        let raw_fd = std::os::unix::io::AsRawFd::as_raw_fd(fd) as u32;
        let fd_nla = build_nla(NBD_SOCK_FD, &raw_fd.to_ne_bytes());
        let item_nla = build_nested_nla(NBD_SOCK_ITEM, &fd_nla);
        sockets_payload.extend_from_slice(&item_nla);
    }
    build_nested_nla(NBD_ATTR_SOCKETS, &sockets_payload)
}

/// Build a netlink attribute (NLA).
fn build_nla(nla_type: u16, payload: &[u8]) -> Vec<u8> {
    let nla_len = 4 + payload.len();
    assert!(nla_len <= u16::MAX as usize, "NLA payload too large");
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
