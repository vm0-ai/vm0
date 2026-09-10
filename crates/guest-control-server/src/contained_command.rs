//! Guest policy adapter for the shared process launch mechanism.

use std::io;

use crate::process::{ChildProcess, spawn_in_own_process_group};
use crate::process_containment::ExecProcessContainment;
pub(crate) use process_launch::{
    Child as ContainedChild, Command as ContainedCommand, Stdio as CommandStdio,
};

pub(crate) trait ContainedCommandExt {
    fn spawn(self, sudo: bool, containment: &ExecProcessContainment) -> io::Result<ContainedChild>;
}

impl ContainedCommandExt for ContainedCommand {
    fn spawn(
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
            return process_launch::spawn(
                self,
                directory,
                process_launch::SpawnOptions {
                    credentials: credentials.map(|value| process_launch::Credentials {
                        uid: value.uid,
                        gid: value.gid,
                        groups: &value.groups,
                    }),
                    deny_process_inspection: placement.deny_process_inspection,
                },
            );
        }
        // Explicit fixed-helper/TestNoop backend, never a failed-cgroup retry.
        let mut command = self.into_standard_command();
        if let Some(credentials) = credentials {
            crate::user::apply_credentials(&mut command, credentials)?;
        }
        spawn_in_own_process_group(&mut command).map(ContainedChild::from)
    }
}

impl ChildProcess for ContainedChild {
    fn id(&self) -> u32 {
        self.id()
    }
    fn kill(&mut self) -> io::Result<()> {
        self.kill()
    }
    fn wait(&mut self) -> io::Result<std::process::ExitStatus> {
        self.wait()
    }
}
