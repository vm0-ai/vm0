use std::io;
use std::process::{Child as StandardChild, ChildStderr, ChildStdin, ChildStdout, ExitStatus};

enum ChildBackend {
    Standard(StandardChild),
    Direct {
        pid: libc::pid_t,
        status: Option<ExitStatus>,
    },
}

/// Owns the direct child until the operation's common wait path reaps it.
pub struct Child {
    backend: ChildBackend,
    pub stdin: Option<ChildStdin>,
    pub stdout: Option<ChildStdout>,
    pub stderr: Option<ChildStderr>,
    reaped: bool,
}

impl From<StandardChild> for Child {
    fn from(mut child: StandardChild) -> Self {
        Self {
            stdin: child.stdin.take(),
            stdout: child.stdout.take(),
            stderr: child.stderr.take(),
            backend: ChildBackend::Standard(child),
            reaped: false,
        }
    }
}

impl Child {
    /// The caller transfers a freshly created, unreaped child PID.
    pub(crate) fn direct(pid: libc::pid_t) -> Self {
        Self {
            backend: ChildBackend::Direct { pid, status: None },
            stdin: None,
            stdout: None,
            stderr: None,
            reaped: false,
        }
    }
}

impl Child {
    pub fn id(&self) -> u32 {
        match &self.backend {
            ChildBackend::Standard(child) => child.id(),
            ChildBackend::Direct { pid, .. } => *pid as u32,
        }
    }

    pub fn kill(&mut self) -> io::Result<()> {
        match &mut self.backend {
            ChildBackend::Standard(child) => child.kill(),
            ChildBackend::Direct {
                status: Some(_), ..
            } => Ok(()),
            ChildBackend::Direct { pid, status: None } => {
                // SAFETY: this owner has not reaped the direct child.
                if unsafe { libc::kill(*pid, libc::SIGKILL) } == 0 {
                    Ok(())
                } else {
                    Err(io::Error::last_os_error())
                }
            }
        }
    }

    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        // The wrapper owns stdin even for the standard backend.
        drop(self.stdin.take());
        match &mut self.backend {
            ChildBackend::Standard(child) => {
                let result = child.wait();
                self.reaped |= result.is_ok();
                result
            }
            ChildBackend::Direct {
                status: Some(status),
                ..
            } => Ok(*status),
            ChildBackend::Direct { pid, status } => {
                use std::os::unix::process::ExitStatusExt;

                let mut raw_status = 0;
                loop {
                    // SAFETY: pid is our unreaped child; waitpid fills the status.
                    if unsafe { libc::waitpid(*pid, &mut raw_status, 0) } >= 0 {
                        let exit = ExitStatus::from_raw(raw_status);
                        *status = Some(exit);
                        self.reaped = true;
                        return Ok(exit);
                    }
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::Interrupted {
                        return Err(error);
                    }
                }
            }
        }
    }
}

impl Child {
    pub fn is_reaped(&self) -> bool {
        self.reaped
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        use std::os::unix::process::ExitStatusExt;
        let result = match &mut self.backend {
            ChildBackend::Standard(child) => child.try_wait(),
            ChildBackend::Direct {
                status: Some(status),
                ..
            } => Ok(Some(*status)),
            ChildBackend::Direct { pid, status } => loop {
                let mut raw_status = 0;
                // SAFETY: this owner retains the unreaped direct child PID.
                let result = unsafe { libc::waitpid(*pid, &mut raw_status, libc::WNOHANG) };
                if result == 0 {
                    break Ok(None);
                }
                if result > 0 {
                    let exit = ExitStatus::from_raw(raw_status);
                    *status = Some(exit);
                    break Ok(Some(exit));
                }
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    break Err(error);
                }
            },
        };
        if let Ok(Some(_)) = &result {
            self.reaped = true;
        }
        result
    }

    pub fn kill_and_reap(mut self) -> io::Result<ExitStatus> {
        if !self.is_reaped() {
            // SAFETY: the unreaped direct child owns this process-group ID.
            unsafe {
                libc::kill(-(self.id() as libc::pid_t), libc::SIGKILL);
            }
            let _ = self.kill();
        }
        self.wait()
    }
}
