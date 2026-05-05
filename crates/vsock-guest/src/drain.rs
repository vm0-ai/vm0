use std::io;
use std::sync::atomic::{AtomicBool, Ordering};

/// Buffer size for reading stdout chunks from a spawned process.
const STDOUT_CHUNK_SIZE: usize = 8 * 1024;
const DRAIN_POLL_TIMEOUT_MS: libc::c_int = 100;

/// Drain `pipe` until EOF or `cancel` is set, calling `on_chunk` for each
/// non-empty read.
///
/// Cancel mechanism: each iteration polls for input with a 100 ms timeout
/// before reading from the same fd, so the cancel flag is observed at most
/// ~100 ms after it's set even if a leaked grandchild still holds the pipe
/// write end open. When the loop returns, the caller's drop of the underlying
/// `ChildStdout` / `ChildStderr` closes the read end of the pipe — at which
/// point any still-writing producer gets EPIPE / SIGPIPE on its next write.
/// That's the property a tempfile-based capture cannot offer: a regular file
/// is always writable, so a leaked daemon would grow tmpfs memory indefinitely.
pub(crate) fn drain_until_eof_or_cancelled<R>(
    pipe: R,
    cancel: &AtomicBool,
    mut on_chunk: impl FnMut(&[u8]),
) where
    R: std::os::unix::io::AsRawFd,
{
    let raw_fd = pipe.as_raw_fd();
    let mut chunk = [0u8; STDOUT_CHUNK_SIZE];
    loop {
        if cancel.load(Ordering::Acquire) {
            break;
        }

        let mut pfd = libc::pollfd {
            fd: raw_fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: pfd is a valid pollfd; nfds=1 matches the single descriptor.
        let r = unsafe { libc::poll(&mut pfd, 1, DRAIN_POLL_TIMEOUT_MS) };
        if r < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            break;
        }
        if r == 0 {
            continue; // timeout — re-check cancel
        }
        if pfd.revents & libc::POLLNVAL != 0 {
            break;
        }
        if pfd.revents & (libc::POLLIN | libc::POLLHUP) == 0 {
            if pfd.revents & libc::POLLERR != 0 {
                break;
            }
            continue;
        }

        // SAFETY: raw_fd belongs to `pipe`, which remains alive until the
        // function returns. `chunk` is valid writable memory of the given len.
        let n = unsafe { libc::read(raw_fd, chunk.as_mut_ptr().cast(), chunk.len()) };
        if n == 0 {
            break; // EOF
        }
        if n < 0 {
            let kind = io::Error::last_os_error().kind();
            if matches!(kind, io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock) {
                continue;
            }
            break;
        }

        on_chunk(chunk.get(..n as usize).unwrap_or_default());
    }

    drop(pipe);
}

/// Buffered variant of [`drain_until_eof_or_cancelled`]: accumulates
/// everything read into a `Vec<u8>` and returns it.
pub(crate) fn drain_into_vec_cancellable<R>(pipe: R, cancel: &AtomicBool) -> Vec<u8>
where
    R: std::os::unix::io::AsRawFd,
{
    let mut buf = Vec::new();
    drain_until_eof_or_cancelled(pipe, cancel, |chunk| buf.extend_from_slice(chunk));
    buf
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;
    use std::os::unix::io::FromRawFd;
    use std::sync::{Arc, mpsc};
    use std::thread;
    use std::time::Duration;

    fn pipe_pair() -> (File, File) {
        let mut fds = [0; 2];
        // SAFETY: fds points to two valid c_int slots for pipe() to fill.
        let ret = unsafe { libc::pipe(fds.as_mut_ptr()) };
        assert_eq!(ret, 0, "pipe failed: {}", io::Error::last_os_error());

        // SAFETY: pipe() initialized both fds and ownership is transferred to File.
        unsafe { (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) }
    }

    #[test]
    fn drain_cancel_exits_while_writer_fd_remains_open() {
        let (reader, mut writer) = pipe_pair();
        let cancel = Arc::new(AtomicBool::new(false));
        let (chunk_tx, chunk_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();

        let drain_cancel = Arc::clone(&cancel);
        let handle = thread::spawn(move || {
            let mut output = Vec::new();
            let mut sent_first_chunk = false;
            drain_until_eof_or_cancelled(reader, &drain_cancel, |chunk| {
                output.extend_from_slice(chunk);
                if !sent_first_chunk {
                    sent_first_chunk = true;
                    let _ = chunk_tx.send(chunk.to_vec());
                }
            });
            let _ = done_tx.send(output);
        });

        writer.write_all(b"hello").unwrap();
        let first_chunk = chunk_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(first_chunk, b"hello".to_vec());

        cancel.store(true, Ordering::Release);
        let output = match done_rx.recv_timeout(Duration::from_secs(1)) {
            Ok(output) => output,
            Err(e) => {
                drop(writer);
                panic!("drain did not observe cancel while writer stayed open: {e}");
            }
        };

        assert_eq!(output, b"hello".to_vec());
        drop(writer);
        handle.join().unwrap();
    }

    #[test]
    fn drain_exits_on_eof_without_chunks() {
        let (reader, writer) = pipe_pair();
        drop(writer);

        let cancel = AtomicBool::new(false);
        let mut output = Vec::new();
        drain_until_eof_or_cancelled(reader, &cancel, |chunk| {
            output.extend_from_slice(chunk);
        });

        assert!(output.is_empty());
    }
}
