use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::time::Instant;

use super::{CONTROL_SINK_IO_TIMEOUT, duration_until, request_timeout_error};

/// Applies one request budget across codec reads, writes, and partial progress.
/// Per-call nonblocking flags leave the mode of all cloned handles unchanged.
pub(super) struct DeadlineStream<'a> {
    stream: &'a mut UnixStream,
    deadline: Instant,
    pub(super) io_started: bool,
}

impl<'a> DeadlineStream<'a> {
    pub(super) fn new(stream: &'a mut UnixStream, deadline: Instant) -> Self {
        Self {
            stream,
            deadline,
            io_started: false,
        }
    }

    fn perform_io(
        &mut self,
        events: libc::c_short,
        mut operation: impl FnMut(RawFd) -> libc::ssize_t,
    ) -> io::Result<usize> {
        let deadline = self.deadline.min(Instant::now() + CONTROL_SINK_IO_TIMEOUT);
        loop {
            duration_until(deadline).ok_or_else(request_timeout_error)?;
            self.io_started = true;
            let result = operation(self.stream.as_raw_fd());
            if result >= 0 {
                return Ok(result as usize);
            }
            let error = io::Error::last_os_error();
            match error.kind() {
                io::ErrorKind::Interrupted => continue,
                io::ErrorKind::WouldBlock => self.wait_ready(events, deadline)?,
                _ => return Err(error),
            }
        }
    }

    fn wait_ready(&self, events: libc::c_short, deadline: Instant) -> io::Result<()> {
        loop {
            let remaining = duration_until(deadline).ok_or_else(request_timeout_error)?;
            let timeout_ms = remaining.as_millis().clamp(1, libc::c_int::MAX as u128);
            let mut descriptor = libc::pollfd {
                fd: self.stream.as_raw_fd(),
                events,
                revents: 0,
            };
            // SAFETY: descriptor is initialized and borrowed for one entry;
            // the timeout is a bounded, positive millisecond count.
            let result = unsafe { libc::poll(&mut descriptor, 1, timeout_ms as libc::c_int) };
            if result < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if result > 0 {
                // Retry recv/send for readiness, EOF, or socket errors. The
                // caller checks the deadline again before that nonblocking I/O.
                return Ok(());
            }
            // Millisecond rounding can wake us early; retain the same deadline.
        }
    }
}

impl Read for DeadlineStream<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.perform_io(libc::POLLIN, |fd| {
            // SAFETY: fd stays live through the borrowed stream. buffer is
            // writable for its length, and recv does not retain its pointer.
            unsafe {
                libc::recv(
                    fd,
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    libc::MSG_DONTWAIT,
                )
            }
        })
    }
}

impl Write for DeadlineStream<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let flags = libc::MSG_DONTWAIT;
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let flags = flags | libc::MSG_NOSIGNAL;
        self.perform_io(libc::POLLOUT, |fd| {
            // SAFETY: fd stays live through the borrowed stream. buffer is
            // readable for its length, and send does not retain its pointer.
            unsafe { libc::send(fd, buffer.as_ptr().cast(), buffer.len(), flags) }
        })
    }

    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}
