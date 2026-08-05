#![deny(missing_docs)]

//! Tokio child-exit notification through Linux pidfds.
//!
//! This crate observes that a direct child has exited without reaping it, so
//! callers can finish process-group cleanup while they still own the child's
//! PID and PGID identity. It does not own signaling, cleanup, timeout, or reap
//! policy.

use std::io;

#[cfg(target_os = "linux")]
use std::os::fd::OwnedFd;

use tokio::process::Child;

/// A readiness notifier for one direct Tokio child process.
#[derive(Debug)]
pub struct ChildExitNotifier {
    #[cfg(target_os = "linux")]
    pidfd: tokio::io::unix::AsyncFd<OwnedFd>,
    #[cfg(not(target_os = "linux"))]
    _private: (),
}

/// Why child-exit notification could not be constructed.
#[derive(Debug, thiserror::Error)]
pub enum ChildExitNotifierError {
    /// The Tokio child no longer exposes its process identifier.
    #[error("child PID is unavailable")]
    MissingPid,

    /// Pidfd notification is unavailable on this operating system.
    #[cfg(not(target_os = "linux"))]
    #[error("pidfd is unsupported on this platform")]
    Unsupported,

    /// The child PID was invalid or `pidfd_open` failed.
    #[cfg(target_os = "linux")]
    #[error("pidfd_open failed: {0}")]
    OpenFailed(#[source] io::Error),

    /// Tokio could not register the pidfd with its I/O driver.
    #[cfg(target_os = "linux")]
    #[error("pidfd async registration failed: {0}")]
    RegisterFailed(#[source] io::Error),
}

impl ChildExitNotifier {
    /// Opens an exit notifier for `child` without taking ownership or reaping it.
    pub fn open(child: &Child) -> Result<Self, ChildExitNotifierError> {
        let pid = child.id().ok_or(ChildExitNotifierError::MissingPid)?;
        Self::open_for_pid(pid)
    }

    /// Waits until the child exits without reaping it.
    pub async fn wait_for_exit(&self) -> io::Result<()> {
        #[cfg(target_os = "linux")]
        {
            let _ready = self.pidfd.readable().await?;
            Ok(())
        }

        #[cfg(not(target_os = "linux"))]
        {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                ChildExitNotifierError::Unsupported,
            ))
        }
    }

    #[cfg(target_os = "linux")]
    fn open_for_pid(pid: u32) -> Result<Self, ChildExitNotifierError> {
        let pid = i32::try_from(pid)
            .ok()
            .and_then(rustix::process::Pid::from_raw)
            .ok_or_else(|| {
                ChildExitNotifierError::OpenFailed(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "child PID cannot be represented as rustix::process::Pid",
                ))
            })?;
        let pidfd = rustix::process::pidfd_open(pid, rustix::process::PidfdFlags::empty())
            .map_err(|error| ChildExitNotifierError::OpenFailed(io::Error::from(error)))?;
        let pidfd =
            tokio::io::unix::AsyncFd::new(pidfd).map_err(ChildExitNotifierError::RegisterFailed)?;
        Ok(Self { pidfd })
    }

    #[cfg(not(target_os = "linux"))]
    fn open_for_pid(_pid: u32) -> Result<Self, ChildExitNotifierError> {
        Err(ChildExitNotifierError::Unsupported)
    }
}
