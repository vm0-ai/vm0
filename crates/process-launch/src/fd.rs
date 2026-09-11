use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

/// Keep a private launch descriptor out of the standard descriptor slots.
pub fn private_descriptor(fd: OwnedFd) -> io::Result<OwnedFd> {
    if fd.as_raw_fd() > libc::STDERR_FILENO {
        return Ok(fd);
    }
    // SAFETY: fd is owned and valid. fcntl returns a distinct owned CLOEXEC fd.
    let duplicate = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
    if duplicate < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the successful duplicate is transferred to exactly one owner.
    Ok(unsafe { OwnedFd::from_raw_fd(duplicate) })
}
