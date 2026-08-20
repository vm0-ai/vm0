//! Transparent Bash launcher for VM0-managed agent shell tools.

use std::env;
use std::ffi::{OsStr, OsString};
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path};
use std::process::{Command, ExitCode};
use std::time::Duration;

use guest_contracts::process_containment::{
    EXEC_CGROUP_NAME_PREFIX, RUNTIME_CGROUP_NAME, TOOL_CGROUP_PROCS_ENDPOINT_ENV,
    WORKLOAD_CGROUP_NAME,
};

const REAL_BASH_PATH: &str = "/bin/bash.vm0-real";
const PROC_SELF_CGROUP: &str = "/proc/self/cgroup";
const PLACEMENT_TIMEOUT: Duration = Duration::from_secs(5);

/// Place a managed shell in its assigned tool cgroup and execute real Bash.
pub fn run() -> ExitCode {
    if let Err(error) = prepare_launch() {
        eprintln!("vm0 tool shell: placement failed: {error}");
        return ExitCode::from(125);
    }

    let error = exec_real_bash();
    eprintln!("vm0 tool shell: failed to exec {REAL_BASH_PATH}: {error}");
    ExitCode::from(126)
}

fn prepare_launch() -> io::Result<()> {
    if current_process_is_runtime()? {
        match env::var_os(TOOL_CGROUP_PROCS_ENDPOINT_ENV) {
            Some(endpoint) => place_current_process(&endpoint)?,
            None => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "managed runtime is missing the tool placement endpoint",
                ));
            }
        }
    }
    Ok(())
}

fn current_process_is_runtime() -> io::Result<bool> {
    let contents = std::fs::read_to_string(PROC_SELF_CGROUP)?;
    let Some(path) = contents.lines().find_map(|line| line.strip_prefix("0::")) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "current unified cgroup path is missing",
        ));
    };
    Ok(is_canonical_runtime_path(Path::new(path)))
}

fn is_canonical_runtime_path(path: &Path) -> bool {
    let components = path.components().collect::<Vec<_>>();
    let [
        Component::RootDir,
        Component::Normal(base),
        Component::Normal(operation),
        Component::Normal(workload),
        Component::Normal(runtime),
    ] = components.as_slice()
    else {
        return false;
    };
    *base == "vm0-exec"
        && operation
            .as_encoded_bytes()
            .starts_with(EXEC_CGROUP_NAME_PREFIX.as_bytes())
        && *workload == WORKLOAD_CGROUP_NAME
        && *runtime == RUNTIME_CGROUP_NAME
}

fn place_current_process(endpoint: &OsStr) -> io::Result<()> {
    let endpoint = endpoint.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "tool placement endpoint is not valid UTF-8",
        )
    })?;
    if endpoint.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "tool placement endpoint is empty",
        ));
    }
    let stream = process_control_ipc::connect_abstract(endpoint)?;
    stream.set_read_timeout(Some(PLACEMENT_TIMEOUT))?;
    stream.set_write_timeout(Some(PLACEMENT_TIMEOUT))?;
    let placement = process_control_ipc::receive_tool_placement(&stream)?;
    write_self_to_cgroup(&placement)?;
    drop(placement);
    process_control_ipc::write_tool_placement_confirmation(&stream)?;
    process_control_ipc::read_tool_placement_ack(&stream)
}

fn write_self_to_cgroup(placement: &OwnedFd) -> io::Result<()> {
    loop {
        // SAFETY: `placement` is open for writing and the one-byte buffer is
        // valid for the duration of the call.
        let written = unsafe { libc::write(placement.as_raw_fd(), b"0".as_ptr().cast(), 1) };
        if written == 1 {
            return Ok(());
        }
        if written < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        return Err(io::Error::from_raw_os_error(libc::EIO));
    }
}

fn exec_real_bash() -> io::Error {
    let mut arguments = env::args_os();
    let argument_zero = arguments.next().unwrap_or_else(|| OsString::from("bash"));
    let mut command = Command::new(REAL_BASH_PATH);
    command.arg0(argument_zero).args(arguments);
    command.exec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_canonical_runtime_leaf() {
        assert!(is_canonical_runtime_path(Path::new(
            "/vm0-exec/exec-12-34/workload/runtime"
        )));
        assert!(!is_canonical_runtime_path(Path::new(
            "/vm0-exec/exec-12-34/workload/tools/tool-1"
        )));
        assert!(!is_canonical_runtime_path(Path::new(
            "/vm0-exec/not-an-operation/workload/runtime"
        )));
        assert!(!is_canonical_runtime_path(Path::new("/workload/runtime")));
    }

    #[test]
    fn self_placement_writes_kernel_self_selector() {
        use std::io::{Read, Seek, SeekFrom};

        let mut file = tempfile::tempfile().unwrap();
        let placement: OwnedFd = file.try_clone().unwrap().into();
        write_self_to_cgroup(&placement).unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut contents = String::new();
        file.read_to_string(&mut contents).unwrap();
        assert_eq!(contents, "0");
    }
}
