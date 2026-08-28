//! Fixed Guest Agent process construction.
//!
//! Controlled Agent launch never accepts a caller-selected executable,
//! arguments, sudo choice, or shell program. Structured bootstrap values are
//! installed directly in the child environment and remain absent from argv
//! and diagnostics.

use std::fs;
use std::io;
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{ChildStderr, ChildStdout, Command, Stdio};

use crate::process_containment::{ExecProcessContainment, ProcessContainmentCleanupMode};
use crate::shell_command::{SpawnedCommand, spawn_command_in_containment};

pub(crate) const GUEST_AGENT_EXECUTABLE: &str = "/usr/local/bin/guest-agent";

#[derive(Clone)]
pub(crate) enum GuestAgentProgram {
    Production,
    Test(PathBuf),
}

impl GuestAgentProgram {
    pub(crate) fn production() -> Self {
        Self::Production
    }

    pub(crate) fn for_test(path: PathBuf) -> Self {
        Self::Test(path)
    }

    fn executable(&self) -> &Path {
        match self {
            Self::Production => Path::new(GUEST_AGENT_EXECUTABLE),
            Self::Test(path) => path,
        }
    }
}

pub(crate) fn spawn_agent_command_with_pipes(
    env: &[(&str, &str)],
    process_containment: ExecProcessContainment,
    program: &GuestAgentProgram,
) -> io::Result<SpawnedCommand> {
    spawn_agent_executable_with_pipes(program.executable(), env, process_containment)
}

fn spawn_agent_executable_with_pipes(
    executable: &Path,
    env: &[(&str, &str)],
    process_containment: ExecProcessContainment,
) -> io::Result<SpawnedCommand> {
    let spawn_result = (|| {
        crate::shell_command::validate_exec_environment(env)?;
        validate_agent_executable(executable)?;
        let (output_reader, output_writer) = cloexec_pipe()?;
        let output_stderr = output_writer.try_clone()?;
        let (diagnostic_reader, diagnostic_writer) = cloexec_pipe()?;
        drop(diagnostic_writer);

        let mut command = Command::new(executable);
        command
            .env_clear()
            .envs(env.iter().copied())
            .stdout(Stdio::from(output_writer))
            .stderr(Stdio::from(output_stderr));
        crate::user::configure_agent_command_environment(&mut command)?;
        let mut child = spawn_command_in_containment(&mut command, false, &process_containment)?;
        child.stdout = Some(ChildStdout::from(output_reader));
        child.stderr = Some(ChildStderr::from(diagnostic_reader));
        Ok(child)
    })();

    match spawn_result {
        Ok(child) => Ok(SpawnedCommand {
            child,
            env_script: None,
            process_containment,
        }),
        Err(error) => {
            let _ = process_containment.cleanup(ProcessContainmentCleanupMode::Forced);
            Err(error)
        }
    }
}

fn validate_agent_executable(executable: &Path) -> io::Result<()> {
    let metadata = match fs::metadata(executable) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "agent bootstrap failed: guest-agent is missing",
            ));
        }
        Err(error) => return Err(error),
    };
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "agent bootstrap failed: guest-agent is not a regular file",
        ));
    }
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "agent bootstrap failed: guest-agent is not executable",
        ));
    }
    Ok(())
}

fn cloexec_pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    // SAFETY: `pipe2` initializes both descriptor slots on success.
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `pipe2` returned two distinct owned descriptors.
    let reader = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    // SAFETY: ownership of the second descriptor is transferred separately.
    let writer = unsafe { OwnedFd::from_raw_fd(fds[1]) };
    Ok((reader, writer))
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use tempfile::{NamedTempFile, TempDir, TempPath};
    use vsock_proto::ExecProcessRole;

    use super::*;
    use crate::process_containment::ProcessContainmentMode;

    fn test_containment(sequence: u32) -> ExecProcessContainment {
        ExecProcessContainment::create(
            sequence,
            ProcessContainmentMode::TestNoop,
            ExecProcessRole::Agent,
        )
        .unwrap()
    }

    fn executable_file(contents: &[u8]) -> TempPath {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(contents).unwrap();
        let mut permissions = file.as_file().metadata().unwrap().permissions();
        permissions.set_mode(0o755);
        file.as_file().set_permissions(permissions).unwrap();
        file.into_temp_path()
    }

    #[test]
    fn direct_agent_validation_reports_missing_path() {
        let directory = TempDir::new().unwrap();
        let error = spawn_agent_executable_with_pipes(
            &directory.path().join("missing-agent"),
            &[],
            test_containment(1),
        )
        .err()
        .unwrap();

        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert!(error.to_string().contains("guest-agent is missing"));
    }

    #[test]
    fn direct_agent_validation_rejects_non_regular_path() {
        let directory = TempDir::new().unwrap();
        let error = spawn_agent_executable_with_pipes(directory.path(), &[], test_containment(2))
            .err()
            .unwrap();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("not a regular file"));
    }

    #[test]
    fn direct_agent_validation_rejects_non_executable_file() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"not executable").unwrap();
        let error = spawn_agent_executable_with_pipes(file.path(), &[], test_containment(3))
            .err()
            .unwrap();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(error.to_string().contains("not executable"));
    }

    #[test]
    fn direct_agent_reports_exec_format_failure() {
        let file = executable_file(b"not an executable image");
        let error = spawn_agent_executable_with_pipes(file.as_ref(), &[], test_containment(4))
            .err()
            .unwrap();

        assert_eq!(error.raw_os_error(), Some(libc::ENOEXEC));
    }

    #[test]
    fn direct_agent_merges_stderr_into_streamed_stdout() {
        let file = executable_file(
            b"#!/bin/sh\nprintf 'stdout:%s\\n' \"$VM0_TEST_VALUE\"\nprintf 'stderr\\n' >&2\n",
        );
        let mut spawned = spawn_agent_executable_with_pipes(
            file.as_ref(),
            &[("VM0_TEST_VALUE", "direct-env")],
            test_containment(5),
        )
        .unwrap();
        let mut stdout = String::new();
        let mut stderr = String::new();
        spawned
            .child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut stdout)
            .unwrap();
        spawned
            .child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        let status = spawned.child.wait().unwrap();

        assert!(status.success());
        assert_eq!(stdout, "stdout:direct-env\nstderr\n");
        assert!(stderr.is_empty());
        assert!(spawned.env_script.is_none());
    }
}
