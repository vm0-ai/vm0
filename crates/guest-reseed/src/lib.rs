use std::ffi::OsStr;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::io::AsRawFd;

/// ioctl request code for RNDRESEEDCRNG.
///
/// Forces an immediate reseed of the kernel CRNG from the input pool.
/// Requires CAP_SYS_ADMIN.
///
/// See `include/uapi/linux/random.h` in the kernel source.
const RNDRESEEDCRNG: libc::Ioctl = 0x5207;
const MAX_ENTROPY_BYTES: usize = 64 * 1024;

fn read_entropy(mut input: impl Read) -> io::Result<Vec<u8>> {
    let mut entropy = Vec::new();
    input
        .by_ref()
        .take((MAX_ENTROPY_BYTES + 1) as u64)
        .read_to_end(&mut entropy)
        .map_err(|e| io::Error::new(e.kind(), format!("read stdin: {e}")))?;
    if entropy.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty entropy"));
    }
    if entropy.len() > MAX_ENTROPY_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "entropy too large",
        ));
    }
    Ok(entropy)
}

fn reseed(entropy: &[u8]) -> io::Result<()> {
    if entropy.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty entropy"));
    }
    if entropy.len() > MAX_ENTROPY_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "entropy too large",
        ));
    }

    fs::write("/dev/urandom", entropy)
        .map_err(|e| io::Error::new(e.kind(), format!("write /dev/urandom: {e}")))?;
    let f = fs::File::open("/dev/urandom")
        .map_err(|e| io::Error::new(e.kind(), format!("open /dev/urandom: {e}")))?;

    // SAFETY: fd is a valid open file descriptor for /dev/urandom.
    let ret = unsafe { libc::ioctl(f.as_raw_fd(), RNDRESEEDCRNG) };
    if ret < 0 {
        let err = io::Error::last_os_error();
        return Err(io::Error::new(
            err.kind(),
            format!("RNDRESEEDCRNG failed: {err}"),
        ));
    }
    Ok(())
}

pub fn run_cli<I, A>(input: impl Read, stderr: impl Write, args: I) -> i32
where
    I: IntoIterator<Item = A>,
    A: AsRef<OsStr>,
{
    run_with_reseed(input, stderr, args, reseed)
}

fn run_with_reseed<R, W, I, A, F>(input: R, mut stderr: W, args: I, reseed_fn: F) -> i32
where
    R: Read,
    W: Write,
    I: IntoIterator<Item = A>,
    A: AsRef<OsStr>,
    F: FnOnce(&[u8]) -> io::Result<()>,
{
    if args.into_iter().next().is_some() {
        let _ = writeln!(stderr, "usage: guest-reseed < entropy-bytes");
        return 1;
    }

    let entropy = match read_entropy(input) {
        Ok(entropy) => entropy,
        Err(e) => {
            let _ = writeln!(stderr, "guest-reseed: {e}");
            return 1;
        }
    };

    match reseed_fn(&entropy) {
        Ok(()) => 0,
        Err(e) => {
            let _ = writeln!(stderr, "guest-reseed: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn read_entropy_accepts_raw_stdin_bytes() {
        let entropy = read_entropy(&b"\0host-entropy"[..]).unwrap();
        assert_eq!(entropy, b"\0host-entropy");
    }

    #[test]
    fn read_entropy_rejects_empty_stdin() {
        let err = read_entropy(&b""[..]).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(err.to_string(), "empty entropy");
    }

    #[test]
    fn read_entropy_rejects_oversized_stdin() {
        let entropy = vec![0; MAX_ENTROPY_BYTES + 1];
        let err = read_entropy(&entropy[..]).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(err.to_string(), "entropy too large");
    }

    #[test]
    fn read_entropy_accepts_max_size_stdin() {
        let input = vec![7; MAX_ENTROPY_BYTES];
        let entropy = read_entropy(&input[..]).unwrap();
        assert_eq!(entropy, input);
    }

    #[test]
    fn run_with_reseed_passes_raw_entropy_to_reseed() {
        let mut stderr = Vec::new();
        let mut seen = Vec::new();
        let code = run_with_reseed(
            &b"\0secret"[..],
            &mut stderr,
            std::iter::empty::<&str>(),
            |entropy| {
                seen.extend_from_slice(entropy);
                Ok(())
            },
        );

        assert_eq!(code, 0);
        assert_eq!(seen, b"\0secret");
        assert!(stderr.is_empty());
    }

    #[test]
    fn run_with_reseed_rejects_empty_entropy_without_calling_reseed() {
        let called = Cell::new(false);
        let mut stderr = Vec::new();
        let code = run_with_reseed(&b""[..], &mut stderr, std::iter::empty::<&str>(), |_| {
            called.set(true);
            Ok(())
        });

        assert_eq!(code, 1);
        assert!(!called.get());
        assert_eq!(
            String::from_utf8(stderr).unwrap(),
            "guest-reseed: empty entropy\n"
        );
    }

    #[test]
    fn run_with_reseed_reports_reseed_failure() {
        let mut stderr = Vec::new();
        let code = run_with_reseed(
            &b"entropy"[..],
            &mut stderr,
            std::iter::empty::<&str>(),
            |_| Err(io::Error::other("ioctl denied")),
        );

        assert_eq!(code, 1);
        assert_eq!(
            String::from_utf8(stderr).unwrap(),
            "guest-reseed: ioctl denied\n"
        );
    }

    #[test]
    fn run_with_reseed_rejects_argv_entropy_without_calling_reseed() {
        let called = Cell::new(false);
        let mut stderr = Vec::new();
        let code = run_with_reseed(&b"entropy"[..], &mut stderr, ["old-hex-argv"], |_| {
            called.set(true);
            Ok(())
        });

        assert_eq!(code, 1);
        assert!(!called.get());
        assert_eq!(
            String::from_utf8(stderr).unwrap(),
            "usage: guest-reseed < entropy-bytes\n"
        );
    }
}
