//! Explicit launch inputs for operation-owned processes.
//!
//! Cgroup launches prepare one command and create the child in its target
//! cgroup. Opaque `Command::pre_exec` callbacks cannot express that boundary.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::io;
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};

use crate::process::{ChildProcess, spawn_in_own_process_group};
use crate::process_containment::ExecProcessContainment;

pub(crate) enum CommandStdio {
    Inherit,
    Piped,
    Owned(OwnedFd),
}

impl From<CommandStdio> for Stdio {
    fn from(value: CommandStdio) -> Self {
        match value {
            CommandStdio::Inherit => Self::inherit(),
            CommandStdio::Piped => Self::piped(),
            CommandStdio::Owned(fd) => Self::from(fd),
        }
    }
}

pub(crate) struct ContainedCommand {
    pub(crate) program: OsString,
    pub(crate) args: Vec<OsString>,
    pub(crate) environment: BTreeMap<OsString, OsString>,
    pub(crate) inherit_environment: bool,
    pub(crate) directory: Option<PathBuf>,
    pub(crate) stdin: CommandStdio,
    pub(crate) stdout: CommandStdio,
    pub(crate) stderr: CommandStdio,
}

impl ContainedCommand {
    pub(crate) fn new(program: impl AsRef<OsStr>) -> Self {
        Self {
            program: program.as_ref().to_owned(),
            args: Vec::new(),
            environment: BTreeMap::new(),
            inherit_environment: true,
            directory: None,
            stdin: CommandStdio::Inherit,
            stdout: CommandStdio::Inherit,
            stderr: CommandStdio::Inherit,
        }
    }

    pub(crate) fn arg(&mut self, value: impl AsRef<OsStr>) -> &mut Self {
        self.args.push(value.as_ref().to_owned());
        self
    }

    pub(crate) fn env(&mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> &mut Self {
        self.environment
            .insert(key.as_ref().to_owned(), value.as_ref().to_owned());
        self
    }

    pub(crate) fn envs<K: AsRef<OsStr>, V: AsRef<OsStr>>(
        &mut self,
        values: impl IntoIterator<Item = (K, V)>,
    ) -> &mut Self {
        for (key, value) in values {
            self.env(key, value);
        }
        self
    }

    pub(crate) fn env_clear(&mut self) -> &mut Self {
        self.inherit_environment = false;
        self.environment.clear();
        self
    }

    pub(crate) fn current_dir(&mut self, path: impl AsRef<Path>) -> &mut Self {
        self.directory = Some(path.as_ref().to_owned());
        self
    }

    pub(crate) fn stdin(&mut self, value: CommandStdio) -> &mut Self {
        self.stdin = value;
        self
    }

    pub(crate) fn stdout(&mut self, value: CommandStdio) -> &mut Self {
        self.stdout = value;
        self
    }

    pub(crate) fn stderr(&mut self, value: CommandStdio) -> &mut Self {
        self.stderr = value;
        self
    }

    pub(crate) fn spawn(
        mut self,
        sudo: bool,
        containment: &ExecProcessContainment,
    ) -> io::Result<ContainedChild> {
        let credentials = crate::user::command_credentials(sudo)?;
        if let Some(credentials) = credentials {
            self.current_dir(&credentials.home)
                .env("HOME", &credentials.home)
                .env("USER", &credentials.username)
                .env("LOGNAME", &credentials.username);
        }
        let placement = containment.prepare_command();
        if let Some(directory) = placement.directory {
            return crate::cgroup_spawn::spawn(
                self,
                directory,
                credentials,
                placement.deny_process_inspection,
            );
        }

        // Explicit TestNoop and fixed process-group-only roles, never a retry
        // after a failed cgroup spawn. Only this backend constructs Command.
        let mut command = self.into_standard_command();
        if let Some(credentials) = credentials {
            crate::user::apply_credentials(&mut command, credentials)?;
        }
        spawn_in_own_process_group(&mut command).map(ContainedChild::from)
    }

    /// Materialize only for an explicitly non-cgroup launch.
    pub(crate) fn into_standard_command(self) -> Command {
        let mut command = Command::new(self.program);
        command.args(self.args);
        if !self.inherit_environment {
            command.env_clear();
        }
        command.envs(self.environment);
        if let Some(directory) = self.directory {
            command.current_dir(directory);
        }
        command
            .stdin(self.stdin)
            .stdout(self.stdout)
            .stderr(self.stderr);
        command
    }
}

enum ChildBackend {
    Standard(Child),
    Direct {
        pid: libc::pid_t,
        status: Option<ExitStatus>,
    },
}

/// Owns the direct child until the operation's common wait path reaps it.
pub(crate) struct ContainedChild {
    backend: ChildBackend,
    pub(crate) stdin: Option<ChildStdin>,
    pub(crate) stdout: Option<ChildStdout>,
    pub(crate) stderr: Option<ChildStderr>,
}

impl From<Child> for ContainedChild {
    fn from(mut child: Child) -> Self {
        Self {
            stdin: child.stdin.take(),
            stdout: child.stdout.take(),
            stderr: child.stderr.take(),
            backend: ChildBackend::Standard(child),
        }
    }
}

impl ContainedChild {
    /// The caller transfers a freshly created, unreaped child PID.
    pub(crate) fn direct(pid: libc::pid_t) -> Self {
        Self {
            backend: ChildBackend::Direct { pid, status: None },
            stdin: None,
            stdout: None,
            stderr: None,
        }
    }
}

impl ChildProcess for ContainedChild {
    fn id(&self) -> u32 {
        match &self.backend {
            ChildBackend::Standard(child) => child.id(),
            ChildBackend::Direct { pid, .. } => *pid as u32,
        }
    }

    fn kill(&mut self) -> io::Result<()> {
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

    fn wait(&mut self) -> io::Result<ExitStatus> {
        // The wrapper owns stdin even for the standard backend.
        drop(self.stdin.take());
        match &mut self.backend {
            ChildBackend::Standard(child) => child.wait(),
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
