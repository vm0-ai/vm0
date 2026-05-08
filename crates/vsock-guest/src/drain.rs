use std::io;
use std::sync::atomic::{AtomicBool, Ordering};

/// Buffer size for reading stdout chunks from a spawned process.
const STDOUT_CHUNK_SIZE: usize = 8 * 1024;
const DRAIN_POLL_TIMEOUT_MS: libc::c_int = 100;

#[derive(Clone, Copy)]
pub(crate) struct BoundedStreamConfig {
    pub(crate) chunk_limit_bytes: usize,
    pub(crate) stream_limit_bytes: usize,
}

#[derive(Debug, Default)]
pub(crate) struct BoundedDrainResult {
    pub(crate) output: Vec<u8>,
    pub(crate) truncated: bool,
}

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

/// Bounded variant of [`drain_until_eof_or_cancelled`].
///
/// The returned final buffer retains only the first `final_limit_bytes` bytes,
/// but the helper continues reading after truncation so the child cannot block
/// on a full pipe. When `stream` is set, early bytes are additionally forwarded
/// through `on_stream_chunk` up to the configured stream budget. Returning
/// `false` from the callback disables further stream forwarding, but draining
/// still continues until EOF or cancellation.
pub(crate) fn drain_bounded_cancellable<R>(
    pipe: R,
    cancel: &AtomicBool,
    final_limit_bytes: usize,
    stream: Option<BoundedStreamConfig>,
    mut on_stream_chunk: impl FnMut(&[u8], bool) -> bool,
) -> BoundedDrainResult
where
    R: std::os::unix::io::AsRawFd,
{
    let mut output = Vec::with_capacity(final_limit_bytes.min(STDOUT_CHUNK_SIZE));
    let mut truncated = false;
    let mut stream_emitted = 0usize;
    let mut stream_truncated = false;
    let mut stream_enabled = stream.is_some();

    drain_until_eof_or_cancelled(pipe, cancel, |chunk| {
        if output.len() < final_limit_bytes {
            let remaining = final_limit_bytes - output.len();
            let keep = remaining.min(chunk.len());
            output.extend_from_slice(chunk.get(..keep).unwrap_or_default());
            if keep < chunk.len() {
                truncated = true;
            }
        } else if !chunk.is_empty() {
            truncated = true;
        }

        let Some(config) = stream else {
            return;
        };
        if !stream_enabled || stream_truncated || chunk.is_empty() {
            return;
        }

        if stream_emitted >= config.stream_limit_bytes || config.chunk_limit_bytes == 0 {
            stream_truncated = true;
            stream_enabled = on_stream_chunk(&[], true);
            return;
        }

        let remaining_stream = config.stream_limit_bytes - stream_emitted;
        let emit_total = remaining_stream.min(chunk.len());
        let emit = chunk.get(..emit_total).unwrap_or_default();
        for part in emit.chunks(config.chunk_limit_bytes) {
            if !on_stream_chunk(part, false) {
                stream_enabled = false;
                return;
            }
            stream_emitted += part.len();
        }

        if emit_total < chunk.len() {
            stream_truncated = true;
            stream_enabled = on_stream_chunk(&[], true);
        }
    });

    BoundedDrainResult { output, truncated }
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

    #[test]
    fn bounded_drain_retains_limit_and_reports_truncation() {
        let (reader, mut writer) = pipe_pair();
        writer.write_all(b"abcdef").unwrap();
        drop(writer);

        let cancel = AtomicBool::new(false);
        let result = drain_bounded_cancellable(reader, &cancel, 3, None, |_, _| true);

        assert_eq!(result.output, b"abc".to_vec());
        assert!(result.truncated);
    }

    #[test]
    fn bounded_drain_zero_limit_stores_no_bytes_but_truncates() {
        let (reader, mut writer) = pipe_pair();
        writer.write_all(b"abc").unwrap();
        drop(writer);

        let cancel = AtomicBool::new(false);
        let result = drain_bounded_cancellable(reader, &cancel, 0, None, |_, _| true);

        assert!(result.output.is_empty());
        assert!(result.truncated);
    }

    #[test]
    fn bounded_drain_splits_stream_chunks_and_marks_stream_truncation() {
        let (reader, mut writer) = pipe_pair();
        writer.write_all(b"abcdef").unwrap();
        drop(writer);

        let cancel = AtomicBool::new(false);
        let mut chunks = Vec::new();
        let result = drain_bounded_cancellable(
            reader,
            &cancel,
            10,
            Some(BoundedStreamConfig {
                chunk_limit_bytes: 2,
                stream_limit_bytes: 5,
            }),
            |chunk, truncated| {
                chunks.push((chunk.to_vec(), truncated));
                true
            },
        );

        assert_eq!(result.output, b"abcdef".to_vec());
        assert!(!result.truncated);
        assert_eq!(
            chunks,
            vec![
                (b"ab".to_vec(), false),
                (b"cd".to_vec(), false),
                (b"e".to_vec(), false),
                (Vec::new(), true),
            ]
        );
    }

    #[test]
    fn bounded_drain_cancel_exits_while_writer_fd_remains_open() {
        let (reader, mut writer) = pipe_pair();
        let cancel = AtomicBool::new(false);
        writer.write_all(b"hello").unwrap();

        let result = drain_bounded_cancellable(
            reader,
            &cancel,
            10,
            Some(BoundedStreamConfig {
                chunk_limit_bytes: 10,
                stream_limit_bytes: 10,
            }),
            |_, _| {
                cancel.store(true, Ordering::Release);
                true
            },
        );

        assert_eq!(result.output, b"hello".to_vec());
        assert!(!result.truncated);
        drop(writer);
    }
}
