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

use std::cell::Cell;
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
    let sock = open_genl_socket().map_err(|source| ConnectDeviceError::NotSent { source })?;
    let family_id =
        resolve_nbd_family(&sock).map_err(|source| ConnectDeviceError::NotSent { source })?;

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

    // The kernel records the sending task's TID in /sys/block/nbdN/pid on
    // successful connect. Capture it before crossing the netlink send boundary.
    let connect_tid = unsafe { libc::gettid() } as u32;
    let seq = send_genl_msg(&sock, family_id, NBD_CMD_CONNECT, &attrs)
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
    let seq = send_genl_msg(&sock, family_id, NBD_CMD_DISCONNECT, &attrs)?;
    recv_genl_completion(&sock, seq)?;

    Ok(())
}

// --- Internal netlink helpers ---

struct GenlSocket {
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
    // kernel never sends a completion message (e.g., nbd module unloaded
    // mid-call).
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

    Ok(GenlSocket {
        fd,
        next_seq: Cell::new(1),
    })
}

fn resolve_nbd_family(sock: &GenlSocket) -> Result<u16> {
    // Build CTRL_CMD_GETFAMILY request for "nbd"
    let name = b"nbd\0";
    let attrs = build_nla(CTRL_ATTR_FAMILY_NAME, name);
    // The family reply itself confirms success. Requesting a success ACK here
    // would leave an extra datagram queued before the following NBD command.
    let seq = send_genl_msg_raw(sock, GENL_ID_CTRL, CTRL_CMD_GETFAMILY, 1, &attrs, false)?;

    // Parse response to get family ID
    let mut buf = vec![0u8; 4096];
    let n = recv_nl_for_seq(sock, &mut buf, seq)?;
    match parse_nl_msg(&buf, n)? {
        NlMsg::Reply => {}
        NlMsg::Ack => {
            return Err(NbdCowError::Netlink(
                "unexpected ACK while resolving NBD family".into(),
            ));
        }
    }
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

fn send_genl_msg(sock: &GenlSocket, family_id: u16, cmd: u8, attrs: &[u8]) -> Result<u32> {
    send_genl_msg_raw(sock, family_id, cmd, NBD_GENL_VERSION, attrs, true)
}

fn send_genl_msg_raw(
    sock: &GenlSocket,
    msg_type: u16,
    cmd: u8,
    version: u8,
    attrs: &[u8],
    request_ack: bool,
) -> Result<u32> {
    let seq = sock.next_seq();
    let msg = build_genl_msg(msg_type, cmd, version, attrs, seq, request_ack);
    send_nl(sock, &msg)?;
    Ok(seq)
}

fn build_genl_msg(
    msg_type: u16,
    cmd: u8,
    version: u8,
    attrs: &[u8],
    seq: u32,
    request_ack: bool,
) -> Vec<u8> {
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
        let mut flags = NLM_F_REQUEST;
        if request_ack {
            flags |= NLM_F_ACK;
        }
        s.copy_from_slice(&flags.to_ne_bytes());
    }
    if let Some(s) = msg.get_mut(8..12) {
        s.copy_from_slice(&seq.to_ne_bytes());
    }
    // pid left as 0

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

    msg
}

fn send_nl(sock: &GenlSocket, msg: &[u8]) -> Result<()> {
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

fn recv_nl_for_seq(sock: &GenlSocket, buf: &mut [u8], expected_seq: u32) -> Result<usize> {
    loop {
        let n = recv_nl(sock, buf)?;
        if nlmsg_seq(buf, n)? == expected_seq {
            return Ok(n);
        }
    }
}

/// Result of parsing a single netlink message.
enum NlMsg {
    /// NLMSG_ERROR with error=0 (ACK).
    Ack,
    /// Non-error message (genetlink reply or broadcast).
    Reply,
}

fn nlmsg_seq(buf: &[u8], n: usize) -> Result<u32> {
    let received = buf
        .get(..n)
        .ok_or_else(|| NbdCowError::Netlink("recv length exceeds buffer".into()))?;
    if received.len() < 16 {
        return Err(NbdCowError::Netlink("message too short".into()));
    }
    let seq = u32::from_ne_bytes(
        received
            .get(8..12)
            .ok_or_else(|| NbdCowError::Netlink("seq slice".into()))?
            .try_into()
            .map_err(|_| NbdCowError::Netlink("seq conversion".into()))?,
    );
    Ok(seq)
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

fn recv_genl_completion(sock: &GenlSocket, expected_seq: u32) -> Result<()> {
    let mut buf = vec![0u8; 4096];
    let n = recv_nl_for_seq(sock, &mut buf, expected_seq)?;
    parse_genl_completion(&buf, n)
}

fn finish_connect_after_send(
    sock: &GenlSocket,
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
    match parse_nl_msg(buf, n)? {
        // NBD connect returns a genetlink reply on success; other commands may
        // complete with a netlink ACK. Non-zero NLMSG_ERROR is handled above.
        NlMsg::Ack | NlMsg::Reply => Ok(()),
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

    fn nlmsg_flags(msg: &[u8]) -> u16 {
        u16::from_ne_bytes(msg[6..8].try_into().unwrap())
    }

    fn nlmsg_seq_from_msg(msg: &[u8]) -> u32 {
        u32::from_ne_bytes(msg[8..12].try_into().unwrap())
    }

    fn nlmsg_error_msg(seq: u32, error: i32) -> Vec<u8> {
        let mut buf = vec![0u8; 24];
        buf[0..4].copy_from_slice(&24u32.to_ne_bytes());
        buf[4..6].copy_from_slice(&NLMSG_ERROR.to_ne_bytes());
        buf[8..12].copy_from_slice(&seq.to_ne_bytes());
        buf[16..20].copy_from_slice(&error.to_ne_bytes());
        buf
    }

    fn set_test_recv_timeout(fd: &OwnedFd) {
        let timeout = libc::timeval {
            tv_sec: 0,
            tv_usec: 100_000,
        };
        let ret = unsafe {
            libc::setsockopt(
                std::os::unix::io::AsRawFd::as_raw_fd(fd),
                libc::SOL_SOCKET,
                libc::SO_RCVTIMEO,
                std::ptr::from_ref(&timeout).cast(),
                std::mem::size_of::<libc::timeval>() as u32,
            )
        };
        assert_eq!(ret, 0);
    }

    fn test_genl_socket_pair() -> (GenlSocket, OwnedFd) {
        let mut fds = [0i32; 2];
        let ret = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_DGRAM, 0, fds.as_mut_ptr()) };
        assert_eq!(ret, 0);

        let recv_fd = unsafe { OwnedFd::from_raw_fd(fds[0]) };
        let send_fd = unsafe { OwnedFd::from_raw_fd(fds[1]) };
        set_test_recv_timeout(&recv_fd);
        (
            GenlSocket {
                fd: recv_fd,
                next_seq: std::cell::Cell::new(1),
            },
            send_fd,
        )
    }

    fn send_test_nl(peer: &OwnedFd, msg: &[u8]) {
        let ret = unsafe {
            libc::send(
                std::os::unix::io::AsRawFd::as_raw_fd(peer),
                msg.as_ptr().cast(),
                msg.len(),
                0,
            )
        };
        assert_eq!(ret, msg.len() as isize);
    }

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

    // --- build_genl_msg tests ---

    #[test]
    fn build_genl_msg_can_omit_ack_for_family_lookup() {
        let attrs = build_nla(CTRL_ATTR_FAMILY_NAME, b"nbd\0");
        let msg = build_genl_msg(GENL_ID_CTRL, CTRL_CMD_GETFAMILY, 1, &attrs, 42, false);

        assert_eq!(nlmsg_flags(&msg), NLM_F_REQUEST);
        assert_eq!(nlmsg_seq_from_msg(&msg), 42);
    }

    #[test]
    fn build_genl_msg_requests_ack_for_nbd_command() {
        let attrs = build_nla(NBD_ATTR_INDEX, &7u32.to_ne_bytes());
        let msg = build_genl_msg(0x19, NBD_CMD_CONNECT, NBD_GENL_VERSION, &attrs, 43, true);

        assert_eq!(nlmsg_flags(&msg), NLM_F_REQUEST | NLM_F_ACK);
        assert_eq!(nlmsg_seq_from_msg(&msg), 43);
    }

    #[test]
    fn next_seq_wraps_without_returning_zero() {
        let (sock, _peer) = test_genl_socket_pair();
        sock.next_seq.set(u32::MAX);

        assert_eq!(sock.next_seq(), u32::MAX);
        assert_eq!(sock.next_seq(), 1);
    }

    #[test]
    fn recv_nl_for_seq_ignores_stale_family_reply() {
        let (sock, peer) = test_genl_socket_pair();
        let expected_seq = 42;

        let stale_attrs = build_nla(CTRL_ATTR_FAMILY_ID, &999u16.to_ne_bytes());
        let stale_reply = build_genl_msg(
            GENL_ID_CTRL,
            CTRL_CMD_GETFAMILY,
            1,
            &stale_attrs,
            expected_seq + 1,
            false,
        );
        let matching_attrs = build_nla(CTRL_ATTR_FAMILY_ID, &123u16.to_ne_bytes());
        let matching_reply = build_genl_msg(
            GENL_ID_CTRL,
            CTRL_CMD_GETFAMILY,
            1,
            &matching_attrs,
            expected_seq,
            false,
        );

        send_test_nl(&peer, &stale_reply);
        send_test_nl(&peer, &matching_reply);

        let mut buf = vec![0u8; 4096];
        let n = recv_nl_for_seq(&sock, &mut buf, expected_seq).unwrap();
        assert!(matches!(parse_nl_msg(&buf, n), Ok(NlMsg::Reply)));
        let family_id = u16::from_ne_bytes(buf[24..26].try_into().unwrap());
        assert_eq!(family_id, 123);
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
        let seq = 42u32;
        buf[8..12].copy_from_slice(&seq.to_ne_bytes());
        // NLMSG_ERROR body: error code at offset 16 (4 bytes), error=0 means ACK
        let error: i32 = 0;
        buf[16..20].copy_from_slice(&error.to_ne_bytes());

        let result = parse_nl_msg(&buf, 24);
        assert!(matches!(result, Ok(NlMsg::Ack)));
        assert_eq!(nlmsg_seq(&buf, 24).unwrap(), 42);
    }

    #[test]
    fn parse_nl_msg_reply() {
        let mut buf = vec![0u8; 20];
        let len = 20u32;
        buf[0..4].copy_from_slice(&len.to_ne_bytes());
        // Use a non-NLMSG_ERROR type
        let msg_type: u16 = 0x0019; // arbitrary genetlink family id
        buf[4..6].copy_from_slice(&msg_type.to_ne_bytes());
        let seq = 43u32;
        buf[8..12].copy_from_slice(&seq.to_ne_bytes());

        let result = parse_nl_msg(&buf, 20);
        assert!(matches!(result, Ok(NlMsg::Reply)));
        assert_eq!(nlmsg_seq(&buf, 20).unwrap(), 43);
    }

    #[test]
    fn parse_genl_completion_accepts_reply() {
        let msg = build_genl_msg(0x19, NBD_CMD_CONNECT, NBD_GENL_VERSION, &[], 44, false);
        let result = parse_genl_completion(&msg, msg.len());

        assert!(result.is_ok());
    }

    #[test]
    fn finish_connect_after_send_success_returns_connect_tid() {
        let (sock, peer) = test_genl_socket_pair();
        let reply = build_genl_msg(0x19, NBD_CMD_CONNECT, NBD_GENL_VERSION, &[], 2, false);
        send_test_nl(&peer, &reply);

        let result = finish_connect_after_send(&sock, 2, 1234);

        assert!(matches!(
            result,
            Ok(ConnectDeviceSuccess { connect_tid: 1234 })
        ));
    }

    #[test]
    fn finish_connect_after_send_errno_is_definite_failure() {
        let (sock, peer) = test_genl_socket_pair();
        send_test_nl(&peer, &nlmsg_error_msg(2, -libc::EBUSY));

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
        let (sock, peer) = test_genl_socket_pair();
        send_test_nl(&peer, &nlmsg_error_msg(2, -libc::EINVAL));

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
        let (sock, peer) = test_genl_socket_pair();
        let reply = build_genl_msg(0x19, NBD_CMD_CONNECT, NBD_GENL_VERSION, &[], 2, false);
        send_test_nl(&peer, &nlmsg_error_msg(1, -libc::EBUSY));
        send_test_nl(&peer, &reply);

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
        let (sock, peer) = test_genl_socket_pair();
        let mut malformed = vec![0u8; 16];
        malformed[0..4].copy_from_slice(&15u32.to_ne_bytes());
        malformed[8..12].copy_from_slice(&2u32.to_ne_bytes());
        send_test_nl(&peer, &malformed);

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
        let (sock, peer) = test_genl_socket_pair();
        send_test_nl(&peer, &nlmsg_error_msg(1, 0));
        send_test_nl(&peer, &nlmsg_error_msg(2, -libc::EBUSY));

        let result = recv_genl_completion(&sock, 2);

        assert!(matches!(
            result,
            Err(NbdCowError::NetlinkErrno { errno, .. }) if errno == libc::EBUSY
        ));
    }

    #[test]
    fn recv_genl_completion_ignores_stale_error_sequence() {
        let (sock, peer) = test_genl_socket_pair();
        send_test_nl(&peer, &nlmsg_error_msg(1, -libc::EBUSY));
        send_test_nl(&peer, &nlmsg_error_msg(2, 0));

        let result = recv_genl_completion(&sock, 2);

        assert!(result.is_ok());
    }

    #[test]
    fn recv_genl_completion_accepts_reply_after_stale_error_sequence() {
        let (sock, peer) = test_genl_socket_pair();
        let reply = build_genl_msg(0x19, NBD_CMD_CONNECT, NBD_GENL_VERSION, &[], 2, false);
        send_test_nl(&peer, &nlmsg_error_msg(1, -libc::EBUSY));
        send_test_nl(&peer, &reply);

        let result = recv_genl_completion(&sock, 2);

        assert!(result.is_ok());
    }

    #[test]
    fn recv_genl_completion_ignores_stale_reply_sequence() {
        let (sock, peer) = test_genl_socket_pair();
        let stale_reply = build_genl_msg(0x19, NBD_CMD_CONNECT, NBD_GENL_VERSION, &[], 1, false);
        send_test_nl(&peer, &stale_reply);
        send_test_nl(&peer, &nlmsg_error_msg(2, -libc::EBUSY));

        let result = recv_genl_completion(&sock, 2);

        assert!(matches!(
            result,
            Err(NbdCowError::NetlinkErrno { errno, .. }) if errno == libc::EBUSY
        ));
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
