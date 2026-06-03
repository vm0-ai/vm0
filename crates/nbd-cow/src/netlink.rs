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

use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::Path;

use crate::error::{NbdCowError, Result};

mod socket;
mod wire;

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

// Generic netlink control family constants.
const GENL_ID_CTRL: u16 = 0x10;
const CTRL_CMD_GETFAMILY: u8 = 3;
const CTRL_ATTR_FAMILY_NAME: u16 = 2;
const CTRL_ATTR_FAMILY_ID: u16 = 1;

/// Timeout (seconds) used for both `NBD_ATTR_TIMEOUT` and `NBD_ATTR_DEAD_CONN_TIMEOUT`.
const TIMEOUT_SECS: u64 = 30;

// NBD genl family version (from kernel: NBD_GENL_VERSION = 0x1)
const NBD_GENL_VERSION: u8 = 1;

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
        // No pid file: free if the device node exists.
        return Path::new(&format!("/dev/nbd{index}")).exists();
    }

    match std::fs::read_to_string(path) {
        Ok(contents) => {
            let pid = contents.trim();
            pid == "-1" || pid == "0" || pid.is_empty()
        }
        Err(_) => false, // Can't read pid file; EBUSY fallback will catch free devices.
    }
}

/// Successful NBD connect metadata.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ConnectDeviceSuccess {
    /// TID of the thread that sent `NBD_CMD_CONNECT`.
    ///
    /// The kernel records this value in `/sys/block/nbdN/pid` after a
    /// successful connect. Cleanup uses it to avoid disconnecting a device
    /// recycled by another process.
    pub(crate) connect_tid: u32,
}

/// Error state for `NBD_CMD_CONNECT`.
///
/// `NBD_CMD_CONNECT` has a kernel commit boundary: after the command is sent,
/// userspace may fail to observe completion even though the kernel accepted the
/// connection. Callers that own an NBD device lease need this state to decide
/// whether ownership-checked cleanup is required.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ConnectDeviceError {
    /// The connect command was not sent to the kernel.
    #[error("NBD connect failed before sending command: {source}")]
    NotSent {
        /// Underlying error.
        source: NbdCowError,
    },
    /// The connect command was sent and the kernel returned a definitive error.
    #[error("NBD connect failed definitively after sending command: {source}")]
    DefiniteAfterSend {
        /// Underlying kernel/netlink error.
        source: NbdCowError,
    },
    /// The connect command was sent, but userspace could not observe completion.
    #[error("NBD connect completion is ambiguous after sending command: {source}")]
    AmbiguousAfterSend {
        /// TID of the thread that sent `NBD_CMD_CONNECT`.
        connect_tid: u32,
        /// Underlying completion-observation error.
        source: NbdCowError,
    },
}

impl ConnectDeviceError {
    /// Return the underlying error for legacy callers that do not need state.
    pub(crate) fn into_source(self) -> NbdCowError {
        match self {
            Self::NotSent { source }
            | Self::DefiniteAfterSend { source }
            | Self::AmbiguousAfterSend { source, .. } => source,
        }
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
    connect_device_with_state(device_index, client_fds, size, block_size)
        .map(|_| ())
        .map_err(ConnectDeviceError::into_source)
}

/// Connect to a specific NBD device and preserve post-send ambiguity state.
pub(crate) fn connect_device_with_state(
    device_index: u32,
    client_fds: &[OwnedFd],
    size: u64,
    block_size: u64,
) -> std::result::Result<ConnectDeviceSuccess, ConnectDeviceError> {
    let sock =
        socket::open_genl_socket().map_err(|source| ConnectDeviceError::NotSent { source })?;
    let family_id =
        resolve_nbd_family(&sock).map_err(|source| ConnectDeviceError::NotSent { source })?;

    let sockets_nla = build_sockets_nla(client_fds);
    let flags =
        NBD_FLAG_HAS_FLAGS | NBD_FLAG_SEND_FLUSH | NBD_FLAG_SEND_TRIM | NBD_FLAG_CAN_MULTI_CONN;

    let mut attrs = Vec::new();
    attrs.extend_from_slice(&wire::build_nla(
        NBD_ATTR_INDEX,
        &device_index.to_ne_bytes(),
    ));
    attrs.extend_from_slice(&wire::build_nla(NBD_ATTR_SIZE_BYTES, &size.to_ne_bytes()));
    attrs.extend_from_slice(&wire::build_nla(
        NBD_ATTR_BLOCK_SIZE_BYTES,
        &block_size.to_ne_bytes(),
    ));
    attrs.extend_from_slice(&wire::build_nla(
        NBD_ATTR_SERVER_FLAGS,
        &flags.to_ne_bytes(),
    ));
    attrs.extend_from_slice(&wire::build_nla(
        NBD_ATTR_TIMEOUT,
        &TIMEOUT_SECS.to_ne_bytes(),
    ));
    attrs.extend_from_slice(&wire::build_nla(
        NBD_ATTR_DEAD_CONN_TIMEOUT,
        &TIMEOUT_SECS.to_ne_bytes(),
    ));
    attrs.extend_from_slice(&sockets_nla);

    // The kernel records the sending task's TID in /sys/block/nbdN/pid on
    // successful connect. Capture it before crossing the netlink send boundary.
    let connect_tid = unsafe { libc::gettid() } as u32;
    let seq = send_nbd_genl_msg(&sock, family_id, NBD_CMD_CONNECT, &attrs)
        .map_err(|source| ConnectDeviceError::NotSent { source })?;

    finish_connect_after_send(&sock, seq, connect_tid)
}

/// Check whether the device has the expected size via sysfs.
///
/// Returns `true` if the size matches within a brief polling window.
/// On reconnect (same index after a recent disconnect), the kernel may
/// briefly report the old (zero) capacity before the new config takes
/// effect. A few milliseconds of polling handles this.
///
/// Uses sync `std::fs::read_to_string` for sysfs reads; these are
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
    let sock = socket::open_genl_socket()?;
    let family_id = resolve_nbd_family(&sock)?;

    let attrs = wire::build_nla(NBD_ATTR_INDEX, &device_index.to_ne_bytes());
    let seq = send_nbd_genl_msg(&sock, family_id, NBD_CMD_DISCONNECT, &attrs)?;
    recv_genl_completion(&sock, seq)?;

    Ok(())
}

// --- Internal netlink helpers ---

fn resolve_nbd_family(sock: &socket::GenlSocket) -> Result<u16> {
    let request_attrs = wire::build_nla(CTRL_ATTR_FAMILY_NAME, b"nbd\0");
    // The family reply itself confirms success. Requesting a success ACK here
    // would leave an extra datagram queued before the following NBD command.
    let seq = socket::send_genl_msg(
        sock,
        GENL_ID_CTRL,
        CTRL_CMD_GETFAMILY,
        1,
        &request_attrs,
        false,
    )?;

    let mut buf = vec![0u8; 4096];
    let n = socket::recv_for_seq(sock, &mut buf, seq)?;
    match wire::parse_nl_msg(&buf, n)? {
        wire::NlMsg::Reply => {}
        wire::NlMsg::Ack => {
            return Err(NbdCowError::Netlink(
                "unexpected ACK while resolving NBD family".into(),
            ));
        }
    }

    let reply_attrs = wire::genl_attrs(&buf, n)?;
    wire::find_nla_u16(reply_attrs, CTRL_ATTR_FAMILY_ID, "truncated family id")?
        .ok_or_else(|| NbdCowError::Netlink("NBD family ID not found in response".into()))
}

fn send_nbd_genl_msg(
    sock: &socket::GenlSocket,
    family_id: u16,
    cmd: u8,
    attrs: &[u8],
) -> Result<u32> {
    socket::send_genl_msg(sock, family_id, cmd, NBD_GENL_VERSION, attrs, true)
}

fn recv_genl_completion(sock: &socket::GenlSocket, expected_seq: u32) -> Result<()> {
    let mut buf = vec![0u8; 4096];
    let n = socket::recv_for_seq(sock, &mut buf, expected_seq)?;
    parse_genl_completion(&buf, n)
}

fn finish_connect_after_send(
    sock: &socket::GenlSocket,
    expected_seq: u32,
    connect_tid: u32,
) -> std::result::Result<ConnectDeviceSuccess, ConnectDeviceError> {
    classify_connect_completion(connect_tid, recv_genl_completion(sock, expected_seq))
}

fn classify_connect_completion(
    connect_tid: u32,
    completion: Result<()>,
) -> std::result::Result<ConnectDeviceSuccess, ConnectDeviceError> {
    match completion {
        Ok(()) => Ok(ConnectDeviceSuccess { connect_tid }),
        Err(source @ NbdCowError::NetlinkErrno { .. }) => {
            Err(ConnectDeviceError::DefiniteAfterSend { source })
        }
        Err(source) => Err(ConnectDeviceError::AmbiguousAfterSend {
            connect_tid,
            source,
        }),
    }
}

fn parse_genl_completion(buf: &[u8], n: usize) -> Result<()> {
    match wire::parse_nl_msg(buf, n)? {
        // NBD connect returns a genetlink reply on success; other commands may
        // complete with a netlink ACK. Non-zero NLMSG_ERROR is handled above.
        wire::NlMsg::Ack | wire::NlMsg::Reply => Ok(()),
    }
}

/// Build the nested NBD_ATTR_SOCKETS NLA from a list of client fds.
fn build_sockets_nla(client_fds: &[OwnedFd]) -> Vec<u8> {
    let mut sockets_payload = Vec::new();
    for fd in client_fds {
        let raw_fd = fd.as_raw_fd() as u32;
        let fd_nla = wire::build_nla(NBD_SOCK_FD, &raw_fd.to_ne_bytes());
        let item_nla = wire::build_nested_nla(NBD_SOCK_ITEM, &fd_nla);
        sockets_payload.extend_from_slice(&item_nla);
    }
    wire::build_nested_nla(NBD_ATTR_SOCKETS, &sockets_payload)
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

    #[test]
    fn parse_genl_completion_accepts_reply() {
        let msg = wire::build_genl_msg(0x19, NBD_CMD_CONNECT, NBD_GENL_VERSION, &[], 44, false);
        let result = parse_genl_completion(&msg, msg.len());

        assert!(result.is_ok());
    }

    #[test]
    fn resolve_nbd_family_reads_family_id_attr() {
        let (sock, peer) = socket::test_genl_socket_pair();
        let attrs = wire::build_nla(CTRL_ATTR_FAMILY_ID, &123u16.to_ne_bytes());
        let reply = wire::build_genl_msg(GENL_ID_CTRL, CTRL_CMD_GETFAMILY, 1, &attrs, 1, false);
        socket::send_test_nl(&peer, &reply);

        let result = resolve_nbd_family(&sock);

        assert_eq!(result.unwrap(), 123);
    }

    #[test]
    fn resolve_nbd_family_rejects_ack() {
        let (sock, peer) = socket::test_genl_socket_pair();
        socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(1, 0));

        let result = resolve_nbd_family(&sock);

        assert!(
            matches!(result, Err(NbdCowError::Netlink(message)) if message == "unexpected ACK while resolving NBD family")
        );
    }

    #[test]
    fn finish_connect_after_send_success_returns_connect_tid() {
        let (sock, peer) = socket::test_genl_socket_pair();
        let reply = wire::build_genl_msg(0x19, NBD_CMD_CONNECT, NBD_GENL_VERSION, &[], 2, false);
        socket::send_test_nl(&peer, &reply);

        let result = finish_connect_after_send(&sock, 2, 1234);

        assert!(matches!(
            result,
            Ok(ConnectDeviceSuccess { connect_tid: 1234 })
        ));
    }

    #[test]
    fn finish_connect_after_send_errno_is_definite_failure() {
        let (sock, peer) = socket::test_genl_socket_pair();
        socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(2, -libc::EBUSY));

        let result = finish_connect_after_send(&sock, 2, 1234);

        assert!(matches!(
            result,
            Err(ConnectDeviceError::DefiniteAfterSend {
                source: NbdCowError::NetlinkErrno { errno, .. },
            }) if errno == libc::EBUSY
        ));
    }

    #[test]
    fn finish_connect_after_send_non_ebusy_errno_is_definite_failure() {
        let (sock, peer) = socket::test_genl_socket_pair();
        socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(2, -libc::EINVAL));

        let result = finish_connect_after_send(&sock, 2, 1234);

        assert!(matches!(
            result,
            Err(ConnectDeviceError::DefiniteAfterSend {
                source: NbdCowError::NetlinkErrno { errno, .. },
            }) if errno == libc::EINVAL
        ));
    }

    #[test]
    fn finish_connect_after_send_ignores_stale_error_before_success() {
        let (sock, peer) = socket::test_genl_socket_pair();
        let reply = wire::build_genl_msg(0x19, NBD_CMD_CONNECT, NBD_GENL_VERSION, &[], 2, false);
        socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(1, -libc::EBUSY));
        socket::send_test_nl(&peer, &reply);

        let result = finish_connect_after_send(&sock, 2, 1234);

        assert!(matches!(
            result,
            Ok(ConnectDeviceSuccess { connect_tid: 1234 })
        ));
    }

    #[test]
    fn classify_connect_completion_io_error_is_ambiguous() {
        let result = classify_connect_completion(
            1234,
            Err(NbdCowError::Io(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "completion timed out",
            ))),
        );

        assert!(matches!(
            result,
            Err(ConnectDeviceError::AmbiguousAfterSend {
                connect_tid: 1234,
                ..
            })
        ));
    }

    #[test]
    fn finish_connect_after_send_malformed_matching_completion_is_ambiguous() {
        let (sock, peer) = socket::test_genl_socket_pair();
        let mut malformed = wire::build_nlmsg_error_for_test(2, 0);
        wire::set_nlmsg_len_for_test(&mut malformed, 15);
        socket::send_test_nl(&peer, &malformed);

        let result = finish_connect_after_send(&sock, 2, 1234);

        assert!(matches!(
            result,
            Err(ConnectDeviceError::AmbiguousAfterSend {
                connect_tid: 1234,
                ..
            })
        ));
    }

    #[test]
    fn recv_genl_completion_ignores_stale_sequence() {
        let (sock, peer) = socket::test_genl_socket_pair();
        socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(1, 0));
        socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(2, -libc::EBUSY));

        let result = recv_genl_completion(&sock, 2);

        assert!(matches!(
            result,
            Err(NbdCowError::NetlinkErrno { errno, .. }) if errno == libc::EBUSY
        ));
    }

    #[test]
    fn recv_genl_completion_ignores_stale_error_sequence() {
        let (sock, peer) = socket::test_genl_socket_pair();
        socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(1, -libc::EBUSY));
        socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(2, 0));

        let result = recv_genl_completion(&sock, 2);

        assert!(result.is_ok());
    }

    #[test]
    fn recv_genl_completion_accepts_reply_after_stale_error_sequence() {
        let (sock, peer) = socket::test_genl_socket_pair();
        let reply = wire::build_genl_msg(0x19, NBD_CMD_CONNECT, NBD_GENL_VERSION, &[], 2, false);
        socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(1, -libc::EBUSY));
        socket::send_test_nl(&peer, &reply);

        let result = recv_genl_completion(&sock, 2);

        assert!(result.is_ok());
    }

    #[test]
    fn recv_genl_completion_ignores_stale_reply_sequence() {
        let (sock, peer) = socket::test_genl_socket_pair();
        let stale_reply =
            wire::build_genl_msg(0x19, NBD_CMD_CONNECT, NBD_GENL_VERSION, &[], 1, false);
        socket::send_test_nl(&peer, &stale_reply);
        socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(2, -libc::EBUSY));

        let result = recv_genl_completion(&sock, 2);

        assert!(matches!(
            result,
            Err(NbdCowError::NetlinkErrno { errno, .. }) if errno == libc::EBUSY
        ));
    }
}
