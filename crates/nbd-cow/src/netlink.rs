//! NBD device setup via generic netlink.
//!
//! This module handles creating and destroying `/dev/nbdN` devices using the
//! kernel's NBD generic netlink interface. This is the modern approach (vs ioctl)
//! and supports multi-connection.
//!
//! Timeouts set on every connect:
//! - `NBD_ATTR_TIMEOUT = 30s`: per-request timeout. On expiry the kernel
//!   retries on another connection (multi-conn). Enables the dead-connection
//!   auto-disconnect path in the kernel's `nbd_xmit_timeout`.
//! - `NBD_ATTR_DEAD_CONN_TIMEOUT = 30s`: after all connections are dead for
//!   this long, the kernel auto-disconnects the device. Combined with the
//!   per-request timeout, orphaned devices (SIGKILL, no Drop) are reclaimed
//!   by the kernel within ~60s if there is pending I/O. Idle orphans still
//!   require `runner gc`.

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
const NBD_ATTR_TIMEOUT: u16 = 4;
const NBD_ATTR_DEAD_CONN_TIMEOUT: u16 = 8;

// NBD socket item attribute types (nested inside NBD_ATTR_SOCKETS)
const NBD_SOCK_ITEM: u16 = 1;
const NBD_SOCK_FD: u16 = 1;

// NBD server flags
const NBD_FLAG_HAS_FLAGS: u64 = 1 << 0;
const NBD_FLAG_SEND_FLUSH: u64 = 1 << 2;
const NBD_FLAG_SEND_TRIM: u64 = 1 << 5;
const NBD_FLAG_CAN_MULTI_CONN: u64 = 1 << 8;

// Netlink constants
const NETLINK_GENERIC: i32 = 16;
const GENL_ID_CTRL: u16 = 0x10;
const CTRL_CMD_GETFAMILY: u8 = 3;
const CTRL_ATTR_FAMILY_NAME: u16 = 2;
const CTRL_ATTR_FAMILY_ID: u16 = 1;

const NLM_F_REQUEST: u16 = 1;
const NLM_F_ACK: u16 = 4;

/// Timeout (seconds) used for both `NBD_ATTR_TIMEOUT` and `NBD_ATTR_DEAD_CONN_TIMEOUT`.
const TIMEOUT_SECS: u64 = 30;

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
pub fn nbds_max() -> u32 {
    std::fs::read_to_string("/sys/module/nbd/parameters/nbds_max")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(256)
}

/// Generate a random offset in `0..max` for device scanning.
///
/// Uses `RandomState` (OS-seeded) to avoid pulling in an external RNG crate.
pub fn random_offset(max: u32) -> u32 {
    if max == 0 {
        return 0;
    }
    use std::hash::{BuildHasher, Hasher, RandomState};
    (RandomState::new().build_hasher().finish() % max as u64) as u32
}

/// Check if a device index appears free by inspecting its pid file.
pub fn device_appears_free(index: u32) -> bool {
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
        Err(_) => false, // Can't read pid file → skip (EBUSY fallback will catch free devices)
    }
}

/// Connect to a specific NBD device by index.
///
/// The caller provides the device index (typically from a `DevicePool`).
/// Returns `Ok(())` on success, or an error. In
/// particular, `NbdCowError::NetlinkErrno { errno: EBUSY }` means the device
/// was grabbed by another process between validation and connect.
pub fn connect_device(
    device_index: u32,
    client_fds: &[OwnedFd],
    size: u64,
    block_size: u64,
) -> Result<()> {
    let sock = open_genl_socket()?;
    let family_id = resolve_nbd_family(&sock)?;

    let sockets_nla = build_sockets_nla(client_fds);
    let flags =
        NBD_FLAG_HAS_FLAGS | NBD_FLAG_SEND_FLUSH | NBD_FLAG_SEND_TRIM | NBD_FLAG_CAN_MULTI_CONN;

    let mut attrs = Vec::new();
    attrs.extend_from_slice(&build_nla(NBD_ATTR_INDEX, &device_index.to_ne_bytes()));
    attrs.extend_from_slice(&build_nla(NBD_ATTR_SIZE_BYTES, &size.to_ne_bytes()));
    attrs.extend_from_slice(&build_nla(
        NBD_ATTR_BLOCK_SIZE_BYTES,
        &block_size.to_ne_bytes(),
    ));
    attrs.extend_from_slice(&build_nla(NBD_ATTR_SERVER_FLAGS, &flags.to_ne_bytes()));
    attrs.extend_from_slice(&build_nla(NBD_ATTR_TIMEOUT, &TIMEOUT_SECS.to_ne_bytes()));
    attrs.extend_from_slice(&build_nla(
        NBD_ATTR_DEAD_CONN_TIMEOUT,
        &TIMEOUT_SECS.to_ne_bytes(),
    ));
    attrs.extend_from_slice(&sockets_nla);

    send_genl_msg(&sock, family_id, NBD_CMD_CONNECT, &attrs)?;
    recv_genl_ack(&sock)?;

    Ok(())
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
    assert!(total_len <= u32::MAX as usize, "netlink message too large");
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

/// Result of parsing a single netlink message.
enum NlMsg {
    /// NLMSG_ERROR with error=0 (ACK).
    Ack,
    /// Non-error message (genetlink reply or broadcast).
    Reply,
}

/// Parse a single netlink message from the buffer. Returns `NlMsg` on
/// success, or an error for NLMSG_ERROR with non-zero errno.
fn parse_nl_msg(buf: &[u8], n: usize) -> Result<NlMsg> {
    let received = buf
        .get(..n)
        .ok_or_else(|| NbdCowError::Netlink("recv length exceeds buffer".into()))?;

    if received.len() < 16 {
        return Err(NbdCowError::Netlink("message too short".into()));
    }

    let nlmsg_len = u32::from_ne_bytes(
        received
            .get(..4)
            .ok_or_else(|| NbdCowError::Netlink("msg_len slice".into()))?
            .try_into()
            .map_err(|_| NbdCowError::Netlink("msg_len conversion".into()))?,
    ) as usize;
    if nlmsg_len < 16 {
        return Err(NbdCowError::Netlink("message too short".into()));
    }
    let msg = received
        .get(..nlmsg_len)
        .ok_or_else(|| NbdCowError::Netlink("truncated netlink message".into()))?;

    let msg_type = u16::from_ne_bytes(
        msg.get(4..6)
            .ok_or_else(|| NbdCowError::Netlink("msg_type slice".into()))?
            .try_into()
            .map_err(|_| NbdCowError::Netlink("msg_type conversion".into()))?,
    );

    if msg_type == NLMSG_ERROR {
        let error = i32::from_ne_bytes(
            msg.get(16..20)
                .ok_or_else(|| NbdCowError::Netlink("error response too short".into()))?
                .try_into()
                .map_err(|_| NbdCowError::Netlink("error code conversion".into()))?,
        );
        if error == 0 {
            return Ok(NlMsg::Ack);
        }
        let errno = -error;
        return Err(NbdCowError::NetlinkErrno {
            errno,
            message: std::io::Error::from_raw_os_error(errno).to_string(),
        });
    }

    Ok(NlMsg::Reply)
}

fn recv_genl_ack(sock: &GenlSocket) -> Result<()> {
    let mut buf = vec![0u8; 4096];
    let n = recv_nl(sock, &mut buf)?;
    match parse_nl_msg(&buf, n)? {
        NlMsg::Ack => Ok(()),
        NlMsg::Reply => {
            // Non-error, non-ACK message — ignore (e.g., unsolicited broadcast).
            Ok(())
        }
    }
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
    assert!(nla_len <= u16::MAX as usize, "nested NLA payload too large");
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_offset_zero_max() {
        assert_eq!(random_offset(0), 0);
    }

    #[test]
    fn random_offset_within_range() {
        for max in [1, 2, 16, 256, 4096] {
            for _ in 0..100 {
                assert!(random_offset(max) < max, "offset >= max for max={max}");
            }
        }
    }

    // --- build_nla tests ---

    #[test]
    fn build_nla_basic() {
        let payload: &[u8] = &[0xAA, 0xBB];
        let nla = build_nla(42, payload);
        // NLA header: len(2) + type(2) = 4 bytes
        let len = u16::from_ne_bytes([nla[0], nla[1]]);
        let nla_type = u16::from_ne_bytes([nla[2], nla[3]]);
        assert_eq!(len, 6); // 4 header + 2 payload
        assert_eq!(nla_type, 42);
        assert_eq!(&nla[4..6], payload);
    }

    #[test]
    fn build_nla_padding_to_4byte_alignment() {
        // 3-byte payload → 7 bytes total → padded to 8
        let payload: &[u8] = &[1, 2, 3];
        let nla = build_nla(1, payload);
        assert_eq!(nla.len(), 8);
        assert_eq!(&nla[4..7], payload);
        assert_eq!(nla[7], 0); // padding byte
    }

    #[test]
    fn build_nla_no_padding_when_aligned() {
        // 4-byte payload → 8 bytes total → already aligned
        let payload: &[u8] = &[1, 2, 3, 4];
        let nla = build_nla(1, payload);
        assert_eq!(nla.len(), 8);
    }

    #[test]
    fn build_nla_empty_payload() {
        let nla = build_nla(99, &[]);
        assert_eq!(nla.len(), 4); // header only, already aligned
        let len = u16::from_ne_bytes([nla[0], nla[1]]);
        assert_eq!(len, 4);
    }

    // --- build_nested_nla tests ---

    #[test]
    fn build_nested_nla_sets_nested_flag() {
        let payload: &[u8] = &[0xDE, 0xAD];
        let nla = build_nested_nla(7, payload);
        let nla_type = u16::from_ne_bytes([nla[2], nla[3]]);
        assert_eq!(nla_type, 7 | (1 << 15)); // NLA_F_NESTED set
        assert_eq!(nla.len(), 8); // 4+2 padded to 8
    }

    // --- parse_nl_msg tests ---

    #[test]
    fn parse_nl_msg_ack() {
        let mut buf = vec![0u8; 24];
        // nlmsghdr: len(4) + type(2) + flags(2) + seq(4) + pid(4) = 16 bytes
        let len = 24u32;
        buf[0..4].copy_from_slice(&len.to_ne_bytes());
        let msg_type: u16 = NLMSG_ERROR;
        buf[4..6].copy_from_slice(&msg_type.to_ne_bytes());
        // NLMSG_ERROR body: error code at offset 16 (4 bytes), error=0 means ACK
        let error: i32 = 0;
        buf[16..20].copy_from_slice(&error.to_ne_bytes());

        let result = parse_nl_msg(&buf, 24);
        assert!(matches!(result, Ok(NlMsg::Ack)));
    }

    #[test]
    fn parse_nl_msg_reply() {
        let mut buf = vec![0u8; 20];
        let len = 20u32;
        buf[0..4].copy_from_slice(&len.to_ne_bytes());
        // Use a non-NLMSG_ERROR type
        let msg_type: u16 = 0x0019; // arbitrary genetlink family id
        buf[4..6].copy_from_slice(&msg_type.to_ne_bytes());

        let result = parse_nl_msg(&buf, 20);
        assert!(matches!(result, Ok(NlMsg::Reply)));
    }

    #[test]
    fn parse_nl_msg_error_errno() {
        let mut buf = vec![0u8; 24];
        let len = 24u32;
        buf[0..4].copy_from_slice(&len.to_ne_bytes());
        let msg_type: u16 = NLMSG_ERROR;
        buf[4..6].copy_from_slice(&msg_type.to_ne_bytes());
        // Pin the reconnect-path errno documented above the NLMSG_ERROR branch.
        let error: i32 = -libc::EBUSY;
        buf[16..20].copy_from_slice(&error.to_ne_bytes());

        let result = parse_nl_msg(&buf, 24);
        assert!(result.is_err());
        if let Err(NbdCowError::NetlinkErrno { errno, .. }) = result {
            assert_eq!(errno, libc::EBUSY);
        } else {
            panic!("expected NetlinkErrno with EBUSY");
        }
    }

    #[test]
    fn parse_nl_msg_too_short() {
        let buf = [0u8; 15];
        let result = parse_nl_msg(&buf, 15);
        assert!(result.is_err());
    }

    #[test]
    fn parse_nl_msg_error_response_truncated() {
        let mut buf = vec![0u8; 4096]; // Production recv buffer size.
        let len = 20u32;
        buf[0..4].copy_from_slice(&len.to_ne_bytes());
        let msg_type: u16 = NLMSG_ERROR;
        buf[4..6].copy_from_slice(&msg_type.to_ne_bytes());

        let result = parse_nl_msg(&buf, 18);
        assert!(result.is_err());
    }

    #[test]
    fn parse_nl_msg_declared_length_too_short() {
        let mut buf = vec![0u8; 24];
        let len = 15u32;
        buf[0..4].copy_from_slice(&len.to_ne_bytes());

        let result = parse_nl_msg(&buf, 24);
        assert!(result.is_err());
    }

    #[test]
    fn parse_nl_msg_error_body_bounded_by_declared_length() {
        let mut buf = vec![0u8; 24];
        let len = 18u32;
        buf[0..4].copy_from_slice(&len.to_ne_bytes());
        let msg_type: u16 = NLMSG_ERROR;
        buf[4..6].copy_from_slice(&msg_type.to_ne_bytes());
        let error: i32 = 0;
        buf[16..20].copy_from_slice(&error.to_ne_bytes());

        let result = parse_nl_msg(&buf, 24);
        assert!(result.is_err());
    }
}
