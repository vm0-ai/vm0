use std::io;

#[cfg(target_os = "linux")]
use std::os::fd::{FromRawFd, OwnedFd, RawFd};

use tokio::process::Child;

pub(super) struct ChildExitNotifier {
    #[cfg(target_os = "linux")]
    pidfd: tokio::io::unix::AsyncFd<OwnedFd>,
}

impl ChildExitNotifier {
    pub(super) fn open(child: &Child) -> io::Result<Self> {
        let pid = child.id().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "child PID is unavailable for pidfd notification",
            )
        })?;
        Self::open_for_pid(pid)
    }

    pub(super) async fn wait_for_exit(&self) -> io::Result<()> {
        #[cfg(target_os = "linux")]
        {
            let _ready = self.pidfd.readable().await?;
            Ok(())
        }

        #[cfg(not(target_os = "linux"))]
        {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "pidfd child exit notification is unavailable",
            ))
        }
    }

    #[cfg(target_os = "linux")]
    fn open_for_pid(pid: u32) -> io::Result<Self> {
        let pidfd = open_pidfd(pid)
            .map_err(|error| io::Error::new(error.kind(), format!("pidfd_open failed: {error}")))?;
        Ok(Self {
            pidfd: tokio::io::unix::AsyncFd::new(pidfd).map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!("pidfd async registration failed: {error}"),
                )
            })?,
        })
    }

    #[cfg(not(target_os = "linux"))]
    fn open_for_pid(_pid: u32) -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "pidfd child exit notification is unavailable",
        ))
    }
}

#[cfg(target_os = "linux")]
fn open_pidfd(pid: u32) -> io::Result<OwnedFd> {
    let pid = libc::pid_t::try_from(pid).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "child PID cannot be represented as libc::pid_t",
        )
    })?;

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
