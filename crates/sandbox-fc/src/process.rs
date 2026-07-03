use std::fmt;
use std::io;

#[cfg(target_os = "linux")]
use std::os::fd::{FromRawFd, OwnedFd, RawFd};

/// Kill the entire process group of `child` via `killpg(SIGKILL)`.
///
/// Requires the child to have been spawned with `process_group(0)` so that its
/// PGID equals its PID. No-op if the child has already exited or the PID cannot
/// be represented as `i32`.
pub(crate) fn kill_process_group(child: &tokio::process::Child) {
    if let Some(pid) = child.id() {
        kill_process_group_by_pid(pid);
    }
}

/// Kill the process group whose PGID equals `pid`.
///
/// Callers should prefer [`kill_process_group`] when they still own the child;
/// that avoids signalling from a PID after the child has been reaped.
pub(crate) fn kill_process_group_by_pid(pid: u32) {
    if let Ok(pid) = i32::try_from(pid) {
        let pgid = nix::unistd::Pid::from_raw(pid);
        let _ = nix::sys::signal::killpg(pgid, nix::sys::signal::Signal::SIGKILL);
    }
}

pub(crate) struct ChildExitNotifier {
    inner: ChildExitNotifierInner,
}

enum ChildExitNotifierInner {
    #[cfg(target_os = "linux")]
    PidFd(tokio::io::unix::AsyncFd<OwnedFd>),
    Unavailable(ChildExitNotifierUnavailable),
}

#[derive(Debug)]
pub(crate) enum ChildExitNotifierUnavailable {
    MissingPid,
    #[cfg(not(target_os = "linux"))]
    Unsupported,
    #[cfg(target_os = "linux")]
    OpenFailed(io::Error),
    #[cfg(target_os = "linux")]
    RegisterFailed(io::Error),
    #[cfg(test)]
    ForcedForTest,
}

impl fmt::Display for ChildExitNotifierUnavailable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingPid => f.write_str("child PID is unavailable"),
            #[cfg(not(target_os = "linux"))]
            Self::Unsupported => f.write_str("pidfd is unsupported on this platform"),
            #[cfg(target_os = "linux")]
            Self::OpenFailed(error) => write!(f, "pidfd_open failed: {error}"),
            #[cfg(target_os = "linux")]
            Self::RegisterFailed(error) => write!(f, "pidfd async registration failed: {error}"),
            #[cfg(test)]
            Self::ForcedForTest => f.write_str("pidfd forced unavailable for test"),
        }
    }
}

impl ChildExitNotifier {
    pub(crate) fn open(child: &tokio::process::Child) -> Self {
        let Some(pid) = child.id() else {
            return Self::unavailable(ChildExitNotifierUnavailable::MissingPid);
        };
        Self::open_for_pid(pid)
    }

    pub(crate) fn is_available(&self) -> bool {
        match &self.inner {
            #[cfg(target_os = "linux")]
            ChildExitNotifierInner::PidFd(_) => true,
            ChildExitNotifierInner::Unavailable(_) => false,
        }
    }

    pub(crate) fn unavailable_reason(&self) -> Option<&ChildExitNotifierUnavailable> {
        match &self.inner {
            #[cfg(target_os = "linux")]
            ChildExitNotifierInner::PidFd(_) => None,
            ChildExitNotifierInner::Unavailable(reason) => Some(reason),
        }
    }

    pub(crate) async fn wait_for_exit(&self) -> io::Result<()> {
        match &self.inner {
            #[cfg(target_os = "linux")]
            ChildExitNotifierInner::PidFd(pidfd) => {
                let _ready = pidfd.readable().await?;
                Ok(())
            }
            ChildExitNotifierInner::Unavailable(reason) => Err(io::Error::new(
                io::ErrorKind::Unsupported,
                reason.to_string(),
            )),
        }
    }

    fn unavailable(reason: ChildExitNotifierUnavailable) -> Self {
        Self {
            inner: ChildExitNotifierInner::Unavailable(reason),
        }
    }

    #[cfg(target_os = "linux")]
    fn open_for_pid(pid: u32) -> Self {
        match open_pidfd(pid) {
            Ok(pidfd) => match tokio::io::unix::AsyncFd::new(pidfd) {
                Ok(pidfd) => Self {
                    inner: ChildExitNotifierInner::PidFd(pidfd),
                },
                Err(error) => {
                    Self::unavailable(ChildExitNotifierUnavailable::RegisterFailed(error))
                }
            },
            Err(error) => Self::unavailable(ChildExitNotifierUnavailable::OpenFailed(error)),
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn open_for_pid(_pid: u32) -> Self {
        Self::unavailable(ChildExitNotifierUnavailable::Unsupported)
    }

    #[cfg(test)]
    pub(crate) fn unavailable_for_test() -> Self {
        Self::unavailable(ChildExitNotifierUnavailable::ForcedForTest)
    }

    #[cfg(test)]
    pub(crate) fn available_for_current_process_for_test() -> bool {
        Self::open_for_pid(std::process::id()).is_available()
    }
}

#[cfg(target_os = "linux")]
fn open_pidfd(pid: u32) -> io::Result<OwnedFd> {
    let pid = i32::try_from(pid).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "child PID cannot be represented as libc::pid_t",
        )
    })? as libc::pid_t;

    // SAFETY: `pidfd_open` does not dereference user pointers. On success it
    // returns a new file descriptor owned by this process.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }

    let fd = RawFd::try_from(fd).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "pidfd_open returned a file descriptor outside RawFd range",
        )
    })?;

    // SAFETY: `fd` is a fresh descriptor returned by `pidfd_open` above.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}
