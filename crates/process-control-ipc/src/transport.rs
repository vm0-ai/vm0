use std::io;
use std::mem::{MaybeUninit, size_of};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::time::{Duration, Instant};

/// Build the abstract socket name for an operation-control endpoint.
///
/// The name includes the guest operation sequence number and a hexadecimal
/// encoding of the 16-byte control nonce. The returned string is suitable for
/// [`bind_abstract_listener`], [`connect_abstract`], and [`crate::BOOTSTRAP_ENV`].
pub fn endpoint_name(seq: u32, nonce: &[u8; 16]) -> String {
    let mut out = format!("vm0-process-control-{seq}-");
    for byte in nonce {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Bind a Linux abstract Unix listener for an operation-control endpoint name.
///
/// `name` is an abstract socket name, not a filesystem path. The resulting
/// listener is suitable for [`accept_with_timeout`].
///
/// # Errors
///
/// Returns `InvalidInput` when `name` is empty, contains a NUL byte, or does
/// not fit in `sockaddr_un.sun_path`. Socket creation, bind, and listen
/// failures are returned as operating-system `io::Error` values.
pub fn bind_abstract_listener(name: &str) -> io::Result<UnixListener> {
    let fd = create_unix_socket()?;
    let addr = abstract_sockaddr(name)?;
    let len = sockaddr_len(name);
    // SAFETY: fd is a valid AF_UNIX socket, addr/len describe a sockaddr_un.
    let ret = unsafe {
        libc::bind(
            fd.as_raw_fd(),
            &addr as *const _ as *const libc::sockaddr,
            len,
        )
    };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd is a valid bound AF_UNIX socket.
    let ret = unsafe { libc::listen(fd.as_raw_fd(), 1) };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd is a valid listener and ownership is transferred.
    Ok(unsafe { UnixListener::from_raw_fd(fd.into_raw_fd()) })
}

/// Connect to a Linux abstract Unix operation-control endpoint.
///
/// `name` is an abstract socket name, not a filesystem path. A newly connected
/// guest-agent side stream must send [`crate::write_hello`] before the server
/// side treats the sink as connected.
///
/// # Errors
///
/// Returns `InvalidInput` when `name` is empty, contains a NUL byte, or does
/// not fit in `sockaddr_un.sun_path`. Socket creation and connect failures are
/// returned as operating-system `io::Error` values.
pub fn connect_abstract(name: &str) -> io::Result<UnixStream> {
    let fd = create_unix_socket()?;
    let addr = abstract_sockaddr(name)?;
    let len = sockaddr_len(name);
    // SAFETY: fd is a valid AF_UNIX socket, addr/len describe a sockaddr_un.
    let ret = unsafe {
        libc::connect(
            fd.as_raw_fd(),
            &addr as *const _ as *const libc::sockaddr,
            len,
        )
    };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd is a valid connected stream and ownership is transferred.
    Ok(unsafe { UnixStream::from_raw_fd(fd.into_raw_fd()) })
}

/// Accept one stream from an operation-control listener before `timeout` elapses.
///
/// The listener is expected to come from [`bind_abstract_listener`].
///
/// # Errors
///
/// Returns `InvalidInput` if the timeout deadline overflows. Returns
/// `TimedOut` if no connection is accepted before the deadline. Poll and accept
/// failures are returned as operating-system `io::Error` values.
pub fn accept_with_timeout(listener: &UnixListener, timeout: Duration) -> io::Result<UnixStream> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "accept timeout overflowed"))?;
    loop {
        match poll_fd(listener.as_raw_fd(), libc::POLLIN, deadline)? {
            true => {
                // SAFETY: listener fd is valid and accept4 initializes addr/len.
                let fd = unsafe {
                    libc::accept4(
                        listener.as_raw_fd(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        libc::SOCK_CLOEXEC,
                    )
                };
                if fd >= 0 {
                    // SAFETY: fd is a connected stream returned by accept4.
                    return Ok(unsafe { UnixStream::from_raw_fd(fd) });
                }
                let err = io::Error::last_os_error();
                if err.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(err);
            }
            false => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "control endpoint accept timed out",
                ));
            }
        }
    }
}

fn create_unix_socket() -> io::Result<OwnedFd> {
    // SAFETY: socket arguments are constants for an AF_UNIX stream socket.
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd is a newly-created socket owned by this function.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn abstract_sockaddr(name: &str) -> io::Result<libc::sockaddr_un> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.contains(&0) || bytes.len() + 1 > sockaddr_un_path_len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid abstract socket name",
        ));
    }

    // SAFETY: zeroed sockaddr_un is a valid starting point before fields are set.
    let mut addr = unsafe { MaybeUninit::<libc::sockaddr_un>::zeroed().assume_init() };
    addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
    addr.sun_path[0] = 0;
    for (index, byte) in bytes.iter().enumerate() {
        let Some(slot) = addr.sun_path.get_mut(index + 1) else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid abstract socket name",
            ));
        };
        *slot = *byte as libc::c_char;
    }
    Ok(addr)
}

fn sockaddr_un_path_len() -> usize {
    // SAFETY: zeroed sockaddr_un is only used to inspect array length.
    let addr = unsafe { MaybeUninit::<libc::sockaddr_un>::zeroed().assume_init() };
    addr.sun_path.len()
}

fn sockaddr_len(name: &str) -> libc::socklen_t {
    (size_of::<libc::sa_family_t>() + 1 + name.len()) as libc::socklen_t
}

fn poll_fd(fd: libc::c_int, events: libc::c_short, deadline: Instant) -> io::Result<bool> {
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Ok(false);
        }
        let remaining = deadline.duration_since(now);
        let timeout_ms = i32::try_from(remaining.as_millis())
            .unwrap_or(i32::MAX)
            .max(1);
        let mut pfd = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        // SAFETY: pfd points to a valid pollfd for one descriptor.
        let ret = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
        if ret > 0 {
            return Ok((pfd.revents & events) != 0);
        }
        if ret == 0 {
            return Ok(false);
        }
        let err = io::Error::last_os_error();
        if err.kind() != io::ErrorKind::Interrupted {
            return Err(err);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_name_includes_seq_and_nonce() {
        let nonce = *b"0123456789abcdef";
        assert_eq!(
            endpoint_name(7, &nonce),
            "vm0-process-control-7-30313233343536373839616263646566"
        );
    }

    #[test]
    fn abstract_socket_rejects_invalid_names() {
        for name in ["", "bad\0name"] {
            let err = bind_abstract_listener(name).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::InvalidInput);

            let err = connect_abstract(name).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        }

        let too_long = "x".repeat(sockaddr_un_path_len());
        let err = bind_abstract_listener(&too_long).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);

        let err = connect_abstract(&too_long).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn abstract_socket_connects() {
        let name = format!(
            "vm0-test-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        );
        let listener = bind_abstract_listener(&name).unwrap();
        let client = std::thread::spawn({
            let name = name.clone();
            move || connect_abstract(&name).unwrap()
        });
        let server = accept_with_timeout(&listener, Duration::from_secs(1)).unwrap();
        let _client = client.join().unwrap();
        drop(server);
    }
}
