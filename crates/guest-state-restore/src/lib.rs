//! Repair snapshot-sensitive guest state and apply the guest timezone.
//!
//! On ARM64 with Linux 6.1, VMGenID does not automatically reseed the CRNG
//! after snapshot restore because the kernel driver supports ACPI but not
//! DeviceTree until Linux 6.10. This crate accepts fresh host entropy through
//! stdin, writes it to `/dev/urandom`, and forces an immediate reseed through
//! the `RNDRESEEDCRNG` ioctl so restored VMs do not share identical random
//! output. Its timezone-only mode applies the canonical guest timezone policy
//! without changing the clock or reading entropy.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::symlink;
use std::os::unix::io::AsRawFd;
use std::path::Path;

/// ioctl request code for RNDRESEEDCRNG.
///
/// Forces an immediate reseed of the kernel CRNG from the input pool.
/// Requires CAP_SYS_ADMIN.
///
/// See `include/uapi/linux/random.h` in the kernel source.
const RNDRESEEDCRNG: libc::Ioctl = 0x5207;
const MAX_ENTROPY_BYTES: usize = 64 * 1024;
const RESTORE_ENTROPY_BYTES: usize = 256;
const RESTORE_MODE_ARG: &str = "--restore-state";
const TIMEZONE_MODE_ARG: &str = "--sync-timezone";
const CLOCK_SYNC_FAILED_MARKER: &str = "guest clock sync failed";
const RESEED_FAILED_MARKER: &str = "guest-reseed failed";
const TIMEZONE_SYNC_FAILED_MARKER: &str = "guest timezone sync failed";
const TIMEZONE_UNAVAILABLE_MARKER: &str = "guest timezone unavailable";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RestoreTimezoneMode {
    None,
    BestEffort,
    Required,
}

#[derive(Debug, Eq, PartialEq)]
struct RestoreArgs {
    seconds: u64,
    nanoseconds: u32,
    timezone_mode: RestoreTimezoneMode,
    timezone: Option<String>,
}

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

fn read_restore_entropy(mut input: impl Read) -> io::Result<[u8; RESTORE_ENTROPY_BYTES]> {
    let mut entropy = [0u8; RESTORE_ENTROPY_BYTES];
    input
        .read_exact(&mut entropy)
        .map_err(|error| io::Error::new(error.kind(), format!("read stdin: {error}")))?;
    let mut trailing = [0u8; 1];
    if input
        .read(&mut trailing)
        .map_err(|error| io::Error::new(error.kind(), format!("read stdin: {error}")))?
        != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "restore entropy must contain exactly 256 bytes",
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

fn set_realtime(seconds: u64, nanoseconds: u32) -> io::Result<()> {
    let timestamp = libc::timespec {
        tv_sec: seconds
            .try_into()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "seconds exceed time_t"))?,
        tv_nsec: libc::c_long::from(nanoseconds),
    };

    // SAFETY: `timestamp` is fully initialized, nanoseconds are validated by
    // the CLI parser, and CLOCK_REALTIME accepts a pointer to this structure.
    if unsafe { libc::clock_settime(libc::CLOCK_REALTIME, &timestamp) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn is_safe_timezone_name(timezone: &str) -> bool {
    !timezone.is_empty()
        && timezone.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || byte == b'/'
                || byte == b'_'
                || byte == b'-'
                || byte == b'+'
        })
}

fn sync_timezone(timezone: &str) -> io::Result<bool> {
    sync_timezone_at(Path::new("/"), timezone)
}

fn sync_timezone_at(root: &Path, timezone: &str) -> io::Result<bool> {
    // The previous shell command appended the validated name to the zoneinfo
    // directory textually. Strip leading separators before `Path::join` so an
    // accepted name such as `/UTC` keeps that behavior instead of replacing
    // the trusted root prefix.
    let zoneinfo = root
        .join("usr/share/zoneinfo")
        .join(timezone.trim_start_matches('/'));
    if !zoneinfo.is_file() {
        return Ok(false);
    }

    fs::write(root.join("etc/timezone"), format!("{timezone}\n"))?;
    let localtime = root.join("etc/localtime");
    match fs::symlink_metadata(&localtime) {
        Ok(_) => fs::remove_file(&localtime)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    symlink(format!("/usr/share/zoneinfo/{timezone}"), &localtime)?;

    let environment_path = root.join("etc/environment");
    let environment = fs::read(&environment_path)?;
    let mut updated = Vec::with_capacity(environment.len() + timezone.len() + 4);
    for line in environment.split_inclusive(|byte| *byte == b'\n') {
        if !line.starts_with(b"TZ=") {
            updated.extend_from_slice(line);
        }
    }
    if !updated.is_empty() && !updated.ends_with(b"\n") {
        updated.push(b'\n');
    }
    updated.extend_from_slice(b"TZ=");
    updated.extend_from_slice(timezone.as_bytes());
    updated.push(b'\n');
    fs::write(environment_path, updated)?;

    Ok(true)
}

fn parse_restore_args(args: &[OsString]) -> Result<RestoreArgs, &'static str> {
    if args.first().and_then(|arg| arg.to_str()) != Some(RESTORE_MODE_ARG) {
        return Err("missing restore mode");
    }
    let seconds = args
        .get(1)
        .and_then(|arg| arg.to_str())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or("invalid restore seconds")?;
    let nanoseconds = args
        .get(2)
        .and_then(|arg| arg.to_str())
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value < 1_000_000_000)
        .ok_or("invalid restore nanoseconds")?;
    let timezone_mode = match args.get(3).and_then(|arg| arg.to_str()) {
        Some("none") => RestoreTimezoneMode::None,
        Some("best-effort") => RestoreTimezoneMode::BestEffort,
        Some("required") => RestoreTimezoneMode::Required,
        _ => return Err("invalid restore timezone mode"),
    };
    let timezone = args.get(4).and_then(|arg| arg.to_str());
    match timezone_mode {
        RestoreTimezoneMode::None if args.len() == 4 => Ok(RestoreArgs {
            seconds,
            nanoseconds,
            timezone_mode,
            timezone: None,
        }),
        RestoreTimezoneMode::BestEffort | RestoreTimezoneMode::Required
            if args.len() == 5 && timezone.is_some_and(is_safe_timezone_name) =>
        {
            Ok(RestoreArgs {
                seconds,
                nanoseconds,
                timezone_mode,
                timezone: timezone.map(ToOwned::to_owned),
            })
        }
        RestoreTimezoneMode::None => Err("restore timezone is not allowed for none mode"),
        RestoreTimezoneMode::BestEffort | RestoreTimezoneMode::Required => {
            Err("restore timezone is missing or invalid")
        }
    }
}

fn parse_timezone_args(args: &[OsString]) -> Result<&str, &'static str> {
    let [mode, timezone] = args else {
        return Err("timezone is missing or invalid");
    };
    if mode != TIMEZONE_MODE_ARG {
        return Err("timezone is missing or invalid");
    }
    timezone
        .to_str()
        .filter(|timezone| is_safe_timezone_name(timezone))
        .ok_or("timezone is missing or invalid")
}

/// Runs the `guest-reseed` CLI.
///
/// `args` must contain the command-line arguments after the executable name,
/// matching `std::env::args_os().skip(1)`. Entropy-only mode uses:
///
/// ```text
/// guest-reseed < entropy-bytes
/// ```
///
/// The fixed guest-state operation uses:
///
/// ```text
/// guest-reseed --restore-state <seconds> <nanoseconds> \
///   <none|best-effort|required> [timezone] < entropy-bytes
/// ```
///
/// The timezone-only operation uses:
///
/// ```text
/// guest-reseed --sync-timezone <timezone>
/// ```
///
/// Entropy-only input must contain between 1 and 65,536 bytes. Restore input
/// must contain exactly 256 bytes. Timezone-only mode does not read input.
/// `stderr` receives usage and runtime diagnostics.
///
/// Valid input is written to `/dev/urandom`, then the kernel CRNG is force-
/// reseeded through the `RNDRESEEDCRNG` ioctl. This operation requires
/// `CAP_SYS_ADMIN`.
///
/// Restore mode sets the realtime clock, reseeds the CRNG, then optionally
/// applies the timezone. Required timezone failures return non-zero;
/// best-effort application failures emit a marker and return success.
/// Timezone-only mode uses the same best-effort marker contract without
/// setting the clock or reseeding the CRNG.
///
/// Returns process-style exit codes: `0` for success and `1` for argument,
/// input, clock, reseed, or required-timezone failures.
pub fn run_cli<I, A>(input: impl Read, stderr: impl Write, args: I) -> i32
where
    I: IntoIterator<Item = A>,
    A: AsRef<OsStr>,
{
    run_with_operations(input, stderr, args, set_realtime, reseed, sync_timezone)
}

fn run_with_operations<R, W, I, A, C, S, T>(
    input: R,
    mut stderr: W,
    args: I,
    clock_fn: C,
    reseed_fn: S,
    timezone_fn: T,
) -> i32
where
    R: Read,
    W: Write,
    I: IntoIterator<Item = A>,
    A: AsRef<OsStr>,
    C: FnOnce(u64, u32) -> io::Result<()>,
    S: FnOnce(&[u8]) -> io::Result<()>,
    T: FnOnce(&str) -> io::Result<bool>,
{
    let args = args
        .into_iter()
        .map(|arg| arg.as_ref().to_owned())
        .collect::<Vec<_>>();
    if args.is_empty() {
        return run_entropy_only(input, &mut stderr, reseed_fn);
    }
    if args
        .first()
        .and_then(|arg| arg.to_str())
        .is_some_and(|arg| arg == TIMEZONE_MODE_ARG)
    {
        let timezone = match parse_timezone_args(&args) {
            Ok(timezone) => timezone,
            Err(error) => {
                let _ = writeln!(stderr, "guest-reseed: {error}");
                let _ = writeln!(stderr, "usage: guest-reseed --sync-timezone <timezone>");
                return 1;
            }
        };
        return report_timezone_result(timezone_fn(timezone), false, &mut stderr);
    }

    let restore = match parse_restore_args(&args) {
        Ok(restore) => restore,
        Err(error) => {
            let _ = writeln!(stderr, "guest-reseed: {error}");
            let _ = writeln!(
                stderr,
                "usage: guest-reseed --restore-state <seconds> <nanoseconds> <none|best-effort|required> [timezone] < entropy-bytes"
            );
            return 1;
        }
    };
    let entropy = match read_restore_entropy(input) {
        Ok(entropy) => entropy,
        Err(error) => {
            let _ = writeln!(stderr, "guest-reseed: {error}");
            return 1;
        }
    };
    if let Err(error) = clock_fn(restore.seconds, restore.nanoseconds) {
        let _ = writeln!(stderr, "{CLOCK_SYNC_FAILED_MARKER}: {error}");
        return 1;
    }
    if let Err(error) = reseed_fn(&entropy) {
        let _ = writeln!(stderr, "{RESEED_FAILED_MARKER}: {error}");
        return 1;
    }

    let Some(timezone) = restore.timezone.as_deref() else {
        return 0;
    };
    report_timezone_result(
        timezone_fn(timezone),
        restore.timezone_mode == RestoreTimezoneMode::Required,
        &mut stderr,
    )
}

fn report_timezone_result(result: io::Result<bool>, required: bool, mut stderr: impl Write) -> i32 {
    match result {
        Ok(true) => 0,
        Ok(false) => {
            let _ = writeln!(stderr, "{TIMEZONE_UNAVAILABLE_MARKER}");
            i32::from(required)
        }
        Err(error) => {
            let _ = writeln!(stderr, "{TIMEZONE_SYNC_FAILED_MARKER}: {error}");
            i32::from(required)
        }
    }
}

fn run_entropy_only(
    input: impl Read,
    mut stderr: impl Write,
    reseed_fn: impl FnOnce(&[u8]) -> io::Result<()>,
) -> i32 {
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
fn run_with_reseed<R, W, I, A, F>(input: R, stderr: W, args: I, reseed_fn: F) -> i32
where
    R: Read,
    W: Write,
    I: IntoIterator<Item = A>,
    A: AsRef<OsStr>,
    F: FnOnce(&[u8]) -> io::Result<()>,
{
    let args = args.into_iter().collect::<Vec<_>>();
    if !args.is_empty() {
        let mut stderr = stderr;
        let _ = writeln!(stderr, "usage: guest-reseed < entropy-bytes");
        return 1;
    }
    run_entropy_only(input, stderr, reseed_fn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::cell::RefCell;
    use std::fs;
    use std::os::unix::fs::MetadataExt;

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

    #[test]
    fn timezone_mode_only_applies_timezone() {
        let clock_called = Cell::new(false);
        let reseed_called = Cell::new(false);
        let timezone = RefCell::new(None);
        let mut stderr = Vec::new();

        let code = run_with_operations(
            &b""[..],
            &mut stderr,
            [TIMEZONE_MODE_ARG, "Asia/Shanghai"],
            |_, _| {
                clock_called.set(true);
                Ok(())
            },
            |_| {
                reseed_called.set(true);
                Ok(())
            },
            |received| {
                timezone.replace(Some(received.to_owned()));
                Ok(true)
            },
        );

        assert_eq!(code, 0);
        assert!(!clock_called.get());
        assert!(!reseed_called.get());
        assert_eq!(timezone.into_inner().as_deref(), Some("Asia/Shanghai"));
        assert!(stderr.is_empty());
    }

    #[test]
    fn timezone_mode_reports_best_effort_outcomes() {
        for (timezone_result, marker) in [
            (Ok(false), TIMEZONE_UNAVAILABLE_MARKER),
            (
                Err(io::Error::other("write denied")),
                TIMEZONE_SYNC_FAILED_MARKER,
            ),
        ] {
            let mut stderr = Vec::new();
            let code = run_with_operations(
                &b""[..],
                &mut stderr,
                [TIMEZONE_MODE_ARG, "UTC"],
                |_, _| Ok(()),
                |_| Ok(()),
                |_| timezone_result,
            );
            let stderr = String::from_utf8(stderr).unwrap();

            assert_eq!(code, 0, "stderr={stderr}");
            assert!(stderr.contains(marker), "stderr={stderr}");
        }
    }

    #[test]
    fn timezone_mode_rejects_invalid_arguments_before_operations() {
        let cases: &[&[&str]] = &[
            &[TIMEZONE_MODE_ARG],
            &[TIMEZONE_MODE_ARG, "UTC", "extra"],
            &[TIMEZONE_MODE_ARG, "../UTC"],
            &[TIMEZONE_MODE_ARG, "UTC;id"],
        ];

        for args in cases {
            let clock_called = Cell::new(false);
            let reseed_called = Cell::new(false);
            let timezone_called = Cell::new(false);
            let mut stderr = Vec::new();
            let code = run_with_operations(
                &b""[..],
                &mut stderr,
                args.iter().copied(),
                |_, _| {
                    clock_called.set(true);
                    Ok(())
                },
                |_| {
                    reseed_called.set(true);
                    Ok(())
                },
                |_| {
                    timezone_called.set(true);
                    Ok(true)
                },
            );

            assert_eq!(code, 1, "args={args:?}");
            assert!(!clock_called.get(), "args={args:?}");
            assert!(!reseed_called.get(), "args={args:?}");
            assert!(!timezone_called.get(), "args={args:?}");
            assert!(
                String::from_utf8(stderr).unwrap().contains("usage:"),
                "args={args:?}"
            );
        }
    }

    #[test]
    fn restore_mode_runs_clock_reseed_and_timezone_in_order() {
        let events = RefCell::new(Vec::new());
        let entropy = [7u8; RESTORE_ENTROPY_BYTES];
        let mut stderr = Vec::new();

        let code = run_with_operations(
            &entropy[..],
            &mut stderr,
            [
                RESTORE_MODE_ARG,
                "123",
                "456000000",
                "required",
                "Asia/Shanghai",
            ],
            |seconds, nanoseconds| {
                events
                    .borrow_mut()
                    .push(format!("clock:{seconds}:{nanoseconds}"));
                Ok(())
            },
            |received| {
                assert_eq!(received, entropy);
                events.borrow_mut().push("reseed".to_string());
                Ok(())
            },
            |timezone| {
                events.borrow_mut().push(format!("timezone:{timezone}"));
                Ok(true)
            },
        );

        assert_eq!(code, 0);
        assert!(stderr.is_empty());
        assert_eq!(
            events.into_inner(),
            ["clock:123:456000000", "reseed", "timezone:Asia/Shanghai"]
        );
    }

    #[test]
    fn restore_mode_requires_exact_entropy_and_stops_before_clock() {
        for entropy in [
            vec![1; RESTORE_ENTROPY_BYTES - 1],
            vec![1; RESTORE_ENTROPY_BYTES + 1],
        ] {
            let clock_called = Cell::new(false);
            let mut stderr = Vec::new();
            let code = run_with_operations(
                &entropy[..],
                &mut stderr,
                [RESTORE_MODE_ARG, "123", "0", "none"],
                |_, _| {
                    clock_called.set(true);
                    Ok(())
                },
                |_| Ok(()),
                |_| Ok(true),
            );

            assert_eq!(code, 1);
            assert!(!clock_called.get());
            assert!(!stderr.is_empty());
        }
    }

    #[test]
    fn restore_mode_stops_after_clock_or_reseed_failure() {
        let entropy = [3u8; RESTORE_ENTROPY_BYTES];
        let reseed_called = Cell::new(false);
        let timezone_called = Cell::new(false);
        let mut stderr = Vec::new();
        let code = run_with_operations(
            &entropy[..],
            &mut stderr,
            [RESTORE_MODE_ARG, "123", "0", "required", "UTC"],
            |_, _| Err(io::Error::other("clock denied")),
            |_| {
                reseed_called.set(true);
                Ok(())
            },
            |_| {
                timezone_called.set(true);
                Ok(true)
            },
        );
        assert_eq!(code, 1);
        assert!(!reseed_called.get());
        assert!(!timezone_called.get());
        assert!(
            String::from_utf8(stderr)
                .unwrap()
                .contains(CLOCK_SYNC_FAILED_MARKER)
        );

        let timezone_called = Cell::new(false);
        let mut stderr = Vec::new();
        let code = run_with_operations(
            &entropy[..],
            &mut stderr,
            [RESTORE_MODE_ARG, "123", "0", "required", "UTC"],
            |_, _| Ok(()),
            |_| Err(io::Error::other("ioctl denied")),
            |_| {
                timezone_called.set(true);
                Ok(true)
            },
        );
        assert_eq!(code, 1);
        assert!(!timezone_called.get());
        assert!(
            String::from_utf8(stderr)
                .unwrap()
                .contains(RESEED_FAILED_MARKER)
        );
    }

    #[test]
    fn restore_mode_preserves_required_and_best_effort_timezone_failures() {
        let entropy = [5u8; RESTORE_ENTROPY_BYTES];
        for (mode, timezone_result, expected_code, marker) in [
            (
                "best-effort",
                Ok(false),
                0,
                Some(TIMEZONE_UNAVAILABLE_MARKER),
            ),
            (
                "best-effort",
                Err(io::Error::other("write denied")),
                0,
                Some(TIMEZONE_SYNC_FAILED_MARKER),
            ),
            ("required", Ok(false), 1, Some(TIMEZONE_UNAVAILABLE_MARKER)),
            (
                "required",
                Err(io::Error::other("write denied")),
                1,
                Some(TIMEZONE_SYNC_FAILED_MARKER),
            ),
        ] {
            let mut stderr = Vec::new();
            let code = run_with_operations(
                &entropy[..],
                &mut stderr,
                [RESTORE_MODE_ARG, "123", "0", mode, "UTC"],
                |_, _| Ok(()),
                |_| Ok(()),
                |_| timezone_result,
            );
            let stderr = String::from_utf8(stderr).unwrap();

            assert_eq!(code, expected_code, "mode={mode} stderr={stderr}");
            if let Some(marker) = marker {
                assert!(stderr.contains(marker), "mode={mode} stderr={stderr}");
            } else {
                assert!(stderr.is_empty(), "mode={mode} stderr={stderr}");
            }
        }
    }

    #[test]
    fn restore_mode_rejects_invalid_timestamp_mode_and_timezone() {
        let cases: &[&[&str]] = &[
            &[RESTORE_MODE_ARG, "bad", "0", "none"],
            &[RESTORE_MODE_ARG, "1", "1000000000", "none"],
            &[RESTORE_MODE_ARG, "1", "0", "unknown"],
            &[RESTORE_MODE_ARG, "1", "0", "none", "UTC"],
            &[RESTORE_MODE_ARG, "1", "0", "required"],
            &[RESTORE_MODE_ARG, "1", "0", "required", "../UTC"],
        ];
        let entropy = [8u8; RESTORE_ENTROPY_BYTES];

        for args in cases {
            let mut stderr = Vec::new();
            let code = run_with_operations(
                &entropy[..],
                &mut stderr,
                args.iter().copied(),
                |_, _| Ok(()),
                |_| Ok(()),
                |_| Ok(true),
            );

            assert_eq!(code, 1, "args={args:?}");
            assert!(
                String::from_utf8(stderr).unwrap().contains("usage:"),
                "args={args:?}"
            );
        }
    }

    #[test]
    fn timezone_sync_updates_guest_files_in_order_compatible_shape() {
        let root = tempfile::tempdir().unwrap();
        let zone = root.path().join("usr/share/zoneinfo/Asia/Shanghai");
        fs::create_dir_all(zone.parent().unwrap()).unwrap();
        fs::write(&zone, b"zone").unwrap();
        fs::create_dir_all(root.path().join("etc")).unwrap();
        fs::write(root.path().join("etc/timezone"), b"UTC\n").unwrap();
        fs::write(root.path().join("etc/localtime"), b"old").unwrap();
        fs::write(
            root.path().join("etc/environment"),
            b"PATH=/usr/bin\nTZ=UTC\nLANG=C",
        )
        .unwrap();

        assert!(sync_timezone_at(root.path(), "Asia/Shanghai").unwrap());

        assert_eq!(
            fs::read(root.path().join("etc/timezone")).unwrap(),
            b"Asia/Shanghai\n"
        );
        let localtime = root.path().join("etc/localtime");
        assert_eq!(
            fs::read_link(&localtime).unwrap(),
            Path::new("/usr/share/zoneinfo/Asia/Shanghai")
        );
        assert_eq!(
            fs::symlink_metadata(localtime).unwrap().mode() & libc::S_IFMT,
            libc::S_IFLNK
        );
        assert_eq!(
            fs::read(root.path().join("etc/environment")).unwrap(),
            b"PATH=/usr/bin\nLANG=C\nTZ=Asia/Shanghai\n"
        );
        assert!(!sync_timezone_at(root.path(), "Mars/Olympus").unwrap());
        assert!(!sync_timezone_at(root.path(), "/etc/passwd").unwrap());
    }
}
