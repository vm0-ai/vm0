//! Explicit launch inputs for operation-owned processes.
//!
//! Cgroup launches prepare one command and create the child in its target
//! cgroup. Opaque `Command::pre_exec` callbacks cannot express that boundary.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::io;
use std::os::fd::OwnedFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command as StandardCommand, Stdio as StandardStdio};

pub enum Stdio {
    Inherit,
    Null,
    Piped,
    Owned(OwnedFd),
}

impl From<Stdio> for StandardStdio {
    fn from(value: Stdio) -> Self {
        match value {
            Stdio::Inherit => Self::inherit(),
            Stdio::Null => Self::null(),
            Stdio::Piped => Self::piped(),
            Stdio::Owned(fd) => Self::from(fd),
        }
    }
}

pub struct Command {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub environment: BTreeMap<OsString, OsString>,
    pub inherit_environment: bool,
    pub directory: Option<PathBuf>,
    pub stdin: Stdio,
    pub stdout: Stdio,
    pub stderr: Stdio,
    pub(crate) nofile_limit: Option<libc::rlim_t>,
}

impl Command {
    pub fn new(program: impl AsRef<OsStr>) -> Self {
        Self {
            program: program.as_ref().to_owned(),
            args: Vec::new(),
            environment: BTreeMap::new(),
            inherit_environment: true,
            directory: None,
            stdin: Stdio::Inherit,
            stdout: Stdio::Inherit,
            stderr: Stdio::Inherit,
            nofile_limit: None,
        }
    }

    pub fn arg(&mut self, value: impl AsRef<OsStr>) -> &mut Self {
        self.args.push(value.as_ref().to_owned());
        self
    }

    pub fn args<I, S>(&mut self, values: I) -> &mut Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.args
            .extend(values.into_iter().map(|value| value.as_ref().to_owned()));
        self
    }

    pub fn nofile_limit(&mut self, limit: libc::rlim_t) -> &mut Self {
        self.nofile_limit = Some(limit);
        self
    }

    pub fn env(&mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> &mut Self {
        self.environment
            .insert(key.as_ref().to_owned(), value.as_ref().to_owned());
        self
    }

    pub fn envs<K: AsRef<OsStr>, V: AsRef<OsStr>>(
        &mut self,
        values: impl IntoIterator<Item = (K, V)>,
    ) -> &mut Self {
        for (key, value) in values {
            self.env(key, value);
        }
        self
    }

    pub fn env_clear(&mut self) -> &mut Self {
        self.inherit_environment = false;
        self.environment.clear();
        self
    }

    pub fn current_dir(&mut self, path: impl AsRef<Path>) -> &mut Self {
        self.directory = Some(path.as_ref().to_owned());
        self
    }

    pub fn stdin(&mut self, value: Stdio) -> &mut Self {
        self.stdin = value;
        self
    }

    pub fn stdout(&mut self, value: Stdio) -> &mut Self {
        self.stdout = value;
        self
    }

    pub fn stderr(&mut self, value: Stdio) -> &mut Self {
        self.stderr = value;
        self
    }

    /// Materialize only for an explicitly non-cgroup launch.
    pub fn into_standard_command(self) -> StandardCommand {
        let mut command = StandardCommand::new(self.program);
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
        if let Some(limit) = self.nofile_limit {
            // SAFETY: the callback performs only one raw resource-limit syscall.
            unsafe {
                command.pre_exec(move || {
                    if set_nofile_limit(limit) == 0 {
                        Ok(())
                    } else {
                        Err(io::Error::last_os_error())
                    }
                });
            }
        }
        command
    }
}

pub(crate) fn set_nofile_limit(limit: libc::rlim_t) -> libc::c_long {
    let limit = libc::rlimit {
        rlim_cur: limit,
        rlim_max: limit,
    };
    // SAFETY: prlimit64 reads the live limit value and only changes the caller.
    unsafe {
        libc::syscall(
            libc::SYS_prlimit64,
            0,
            libc::RLIMIT_NOFILE,
            &limit,
            std::ptr::null_mut::<libc::rlimit>(),
        )
    }
}
