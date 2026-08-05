use std::io;

#[cfg(target_os = "linux")]
use std::os::fd::OwnedFd;

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
    let pid = i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "child PID cannot be represented as rustix::process::Pid",
            )
        })?;

    rustix::process::pidfd_open(pid, rustix::process::PidfdFlags::empty()).map_err(io::Error::from)
}
