use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};

/// Buffer size for reading stdout chunks from a spawned process.
const STDOUT_CHUNK_SIZE: usize = 8 * 1024;

/// Set `O_NONBLOCK` on `raw_fd`. Returns false on fcntl failure.
///
/// Used so a drain thread can `poll()` with a short timeout and break out on
/// a cancel flag, instead of getting stuck in a blocking `read()` while a
/// leaked grandchild holds the pipe write end open past child exit.
fn set_nonblocking(raw_fd: std::os::unix::io::RawFd) -> bool {
    // SAFETY: raw_fd is a valid fd taken from a `Child`'s pipe.
    let flags = unsafe { libc::fcntl(raw_fd, libc::F_GETFL) };
    if flags < 0 {
        return false;
    }
    // SAFETY: raw_fd is valid; flags is the value just read from F_GETFL.
    let r = unsafe { libc::fcntl(raw_fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
    r >= 0
}

/// Drain `pipe` until EOF or `cancel` is set, calling `on_chunk` for each
/// non-empty read.
///
/// Cancel mechanism: each iteration polls for input with a 100 ms timeout, so
/// the cancel flag is observed at most ~100 ms after it's set. When the loop
/// returns, the caller's drop of the underlying `ChildStdout` / `ChildStderr`
/// closes the read end of the pipe — at which point any still-writing
/// producer (e.g. an orphaned grandchild) gets EPIPE / SIGPIPE on its next
/// write. That's the property a tempfile-based capture cannot offer: a
/// regular file is always writable, so a leaked daemon would grow tmpfs
/// memory indefinitely.
pub(crate) fn drain_until_eof_or_cancelled<R>(
    mut pipe: R,
    cancel: &AtomicBool,
    mut on_chunk: impl FnMut(&[u8]),
) where
    R: Read + std::os::unix::io::AsRawFd,
{
    let raw_fd = pipe.as_raw_fd();
    // If we can't set non-blocking, fall back to a blocking read. We lose the
    // cancel property (drain may hang past deadline) but produce correct data
    // for the common case. fcntl never fails in practice on a valid pipe fd.
    let nonblocking = set_nonblocking(raw_fd);

    let mut chunk = [0u8; STDOUT_CHUNK_SIZE];
    loop {
        if cancel.load(Ordering::Acquire) {
            break;
        }
        if nonblocking {
            let mut pfd = libc::pollfd {
                fd: raw_fd,
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: pfd is a valid pollfd; nfds=1 matches the array length.
            let r = unsafe { libc::poll(&mut pfd, 1, 100) };
            if r < 0 {
                if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
            if r == 0 {
                continue; // timeout — re-check cancel
            }
        }
        match pipe.read(&mut chunk) {
            Ok(0) => break, // EOF
            Ok(n) => on_chunk(chunk.get(..n).unwrap_or_default()),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => continue,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

/// Buffered variant of [`drain_until_eof_or_cancelled`]: accumulates
/// everything read into a `Vec<u8>` and returns it.
pub(crate) fn drain_into_vec_cancellable<R>(pipe: R, cancel: &AtomicBool) -> Vec<u8>
where
    R: Read + std::os::unix::io::AsRawFd,
{
    let mut buf = Vec::new();
    drain_until_eof_or_cancelled(pipe, cancel, |chunk| buf.extend_from_slice(chunk));
    buf
}
