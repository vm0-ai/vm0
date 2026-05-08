use std::cmp;
use std::io;
use std::net::Shutdown;
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const WRITE_DEADLINE: Duration = Duration::from_secs(10);

/// Shared guest-to-host frame writer.
///
/// The mutex is held for exactly one encoded protocol frame, so concurrent
/// producers cannot interleave bytes on the stream.
#[derive(Clone)]
pub(crate) struct GuestWriter {
    stream: Arc<Mutex<UnixStream>>,
}

impl GuestWriter {
    pub(crate) fn new(stream: UnixStream) -> Self {
        Self {
            stream: Arc::new(Mutex::new(stream)),
        }
    }

    pub(crate) fn write_frame(&self, frame: &[u8]) -> io::Result<()> {
        self.write_frame_with_deadline(frame, WRITE_DEADLINE)
    }

    pub(crate) fn write_frame_with_deadline(
        &self,
        frame: &[u8],
        deadline: Duration,
    ) -> io::Result<()> {
        let stream = self.stream.lock().unwrap_or_else(|e| e.into_inner());
        let result = send_frame(stream.as_raw_fd(), frame, deadline);
        if result.is_err() {
            // The protocol has no resync marker. After a timeout or partial
            // write failure, keep the stream from carrying corrupted frames.
            let _ = stream.shutdown(Shutdown::Both);
        }
        result
    }
}

fn send_frame(fd: RawFd, frame: &[u8], deadline: Duration) -> io::Result<()> {
    if frame.is_empty() {
        return Ok(());
    }

    let Some(deadline_at) = Instant::now().checked_add(deadline) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "guest writer deadline overflowed",
        ));
    };

    let mut written = 0usize;
    while written < frame.len() {
        if Instant::now() >= deadline_at {
            return Err(write_timeout_error());
        }

        let Some(remaining) = frame.get(written..) else {
            return Err(io::Error::other(
                "guest writer offset exceeded frame length",
            ));
        };
        match send_nonblocking(fd, remaining) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "guest writer sent zero bytes",
                ));
            }
            Ok(n) => {
                written = written
                    .checked_add(n)
                    .filter(|next| *next <= frame.len())
                    .ok_or_else(|| io::Error::other("guest writer sent past frame length"))?;
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => wait_writable(fd, deadline_at)?,
            Err(e) => return Err(e),
        }
    }

    Ok(())
}

fn wait_writable(fd: RawFd, deadline_at: Instant) -> io::Result<()> {
    loop {
        let now = Instant::now();
        if now >= deadline_at {
            return Err(write_timeout_error());
        }

        let mut pollfd = libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        };
        // SAFETY: pollfd points to one initialized descriptor entry, and the
        // timeout is a bounded non-negative millisecond value.
        let ret = unsafe {
            libc::poll(
                &mut pollfd,
                1 as libc::nfds_t,
                poll_timeout_ms(deadline_at.saturating_duration_since(now)),
            )
        };

        if ret < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(err);
        }
        if ret == 0 {
            return Err(write_timeout_error());
        }

        if pollfd.revents & libc::POLLNVAL != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "guest writer socket fd is invalid",
            ));
        }
        if pollfd.revents & (libc::POLLERR | libc::POLLHUP) != 0 {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "guest writer socket is no longer writable",
            ));
        }
        if pollfd.revents & libc::POLLOUT != 0 {
            return Ok(());
        }
    }
}

fn send_nonblocking(fd: RawFd, bytes: &[u8]) -> io::Result<usize> {
    // SAFETY: bytes points to a valid buffer for the provided length. send()
    // does not retain the pointer after returning.
    let ret = unsafe {
        libc::send(
            fd,
            bytes.as_ptr().cast::<libc::c_void>(),
            bytes.len(),
            send_flags(),
        )
    };
    if ret < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(ret as usize)
}

fn poll_timeout_ms(remaining: Duration) -> libc::c_int {
    cmp::min(cmp::max(remaining.as_millis(), 1), libc::c_int::MAX as u128) as libc::c_int
}

fn write_timeout_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        "guest writer timed out waiting for peer to drain",
    )
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn send_flags() -> libc::c_int {
    libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn send_flags() -> libc::c_int {
    libc::MSG_DONTWAIT
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn set_send_buffer(stream: &UnixStream, size: libc::c_int) -> io::Result<()> {
        // SAFETY: setsockopt receives a valid socket fd and a pointer to a
        // properly sized integer option value for the duration of the call.
        let ret = unsafe {
            libc::setsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_SNDBUF,
                (&size as *const libc::c_int).cast(),
                std::mem::size_of_val(&size) as libc::socklen_t,
            )
        };
        if ret < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    #[test]
    fn write_frame_sends_complete_frame() {
        let (guest, mut peer) = UnixStream::pair().unwrap();
        set_send_buffer(&guest, 4096).unwrap();
        let writer = GuestWriter::new(guest);
        let frame = vec![7u8; 1024 * 1024];
        let expected = frame.clone();

        let reader = std::thread::spawn(move || {
            let mut received = Vec::new();
            peer.read_to_end(&mut received).unwrap();
            received
        });

        writer
            .write_frame_with_deadline(&frame, Duration::from_secs(5))
            .unwrap();
        drop(writer);

        assert_eq!(reader.join().unwrap(), expected);
    }

    #[test]
    fn write_frame_fails_when_peer_is_closed() {
        let (guest, peer) = UnixStream::pair().unwrap();
        drop(peer);
        let writer = GuestWriter::new(guest);

        let err = writer
            .write_frame_with_deadline(&[1, 2, 3, 4], Duration::from_secs(1))
            .unwrap_err();

        assert!(matches!(
            err.kind(),
            io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
        ));
    }

    #[test]
    fn write_frame_times_out_when_peer_stops_reading() {
        let (guest, mut peer) = UnixStream::pair().unwrap();
        set_send_buffer(&guest, 4096).unwrap();
        let writer = GuestWriter::new(guest);
        let frame = vec![0xAB; 8 * 1024 * 1024];

        let started = Instant::now();
        let err = writer
            .write_frame_with_deadline(&frame, Duration::from_millis(100))
            .unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5));

        peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let mut drained = Vec::new();
        peer.read_to_end(&mut drained).unwrap();
    }
}
