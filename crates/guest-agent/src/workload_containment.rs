//! Secure workload-cgroup placement owned by Guest Agent.
//!
//! The root guest supervisor places Guest Agent in an operation's `control`
//! leaf and transfers a write-only descriptor for the sibling `workload` leaf
//! over a nonce-authenticated local socket with `SCM_RIGHTS`. Guest Agent adopts
//! that descriptor before starting its async runtime and uses a cloned
//! descriptor only in each CLI child's `pre_exec` hook. The descriptor is never
//! inherited through the sandbox-user launch chain or copied into a workload
//! environment.

use std::fs;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use guest_contracts::diagnostics::WorkloadResourceLimitDiagnostic;
use guest_contracts::process_containment::{
    CGROUP_V2_MOUNT_PATH, CONTROL_CGROUP_NAME, EXEC_CGROUP_NAME_PREFIX, RUNTIME_CGROUP_NAME,
    TOOL_CGROUP_PROCS_ENDPOINT_ENV, TOOLS_CGROUP_NAME, WORKLOAD_CGROUP_NAME,
    WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV, WorkloadResourceEvents,
};

const CGROUP_PROCS_FILE: &str = "cgroup.procs";
const PROC_SELF_CGROUP: &str = "/proc/self/cgroup";
const CGROUP2_SUPER_MAGIC: u64 = 0x6367_7270;
const WORKLOAD_BOOTSTRAP_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
#[cfg(debug_assertions)]
const TEST_ALLOW_UNMANAGED_PROCESS_CONTROL_ENV: &str = "VM0_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL";

/// Root-opened capability used only to place CLI children in `workload/runtime`.
#[derive(Clone, Debug)]
pub struct WorkloadContainment {
    placement: Arc<OwnedFd>,
    workload_path: Arc<PathBuf>,
    tool_placement_endpoint: Arc<str>,
}

/// Resource enforcement observed for a completed workload.
#[derive(Debug, Eq, PartialEq)]
pub struct WorkloadResourceDiagnostics {
    /// Hard memory or PID limit counters suitable for structured attribution.
    pub hard_limit: Option<WorkloadResourceLimitDiagnostic>,
    /// CPU throttling or memory-high summary suitable for an informational log.
    pub pressure: Option<String>,
}

impl WorkloadContainment {
    /// Receive and adopt the production bootstrap descriptor.
    ///
    /// This must run before any other thread can read or mutate process-global
    /// environment state. A process-control bootstrap requires a matching
    /// workload capability in production. Direct local execution is unmanaged
    /// when neither bootstrap value exists.
    pub fn from_process_env() -> Result<Option<Self>, String> {
        let process_control_present = match std::env::var_os(process_control_ipc::BOOTSTRAP_ENV) {
            None => false,
            Some(endpoint) if endpoint.is_empty() => false,
            Some(endpoint) if endpoint.to_str().is_none() => {
                return Err(format!(
                    "{} must be valid UTF-8",
                    process_control_ipc::BOOTSTRAP_ENV
                ));
            }
            Some(_) => true,
        };
        let placement_endpoint = std::env::var_os(WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV);
        let tool_endpoint = std::env::var_os(TOOL_CGROUP_PROCS_ENDPOINT_ENV);

        match (process_control_present, placement_endpoint, tool_endpoint) {
            (false, None, None) => Ok(None),
            (true, None, None) if test_allows_unmanaged_process_control() => Ok(None),
            (true, Some(placement), Some(tool)) => {
                // SAFETY: production calls this before constructing the Tokio
                // runtime, so no other thread can access the environment.
                unsafe {
                    std::env::remove_var(WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV);
                    std::env::remove_var(TOOL_CGROUP_PROCS_ENDPOINT_ENV);
                }
                let placement = placement.into_string().map_err(|_| {
                    format!("{WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV} must be valid UTF-8")
                })?;
                let tool = tool
                    .into_string()
                    .map_err(|_| format!("{TOOL_CGROUP_PROCS_ENDPOINT_ENV} must be valid UTF-8"))?;
                if tool.is_empty() {
                    return Err(format!(
                        "{TOOL_CGROUP_PROCS_ENDPOINT_ENV} must not be empty"
                    ));
                }
                Self::receive(&placement, tool).map(Some).map_err(|error| {
                    format!("invalid {WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV}: {error}")
                })
            }
            (true, _, _) => Err(format!(
                "{} and {} are required with {}",
                WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV,
                TOOL_CGROUP_PROCS_ENDPOINT_ENV,
                process_control_ipc::BOOTSTRAP_ENV
            )),
            (false, _, _) => Err(format!(
                "{} and {} require {}",
                WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV,
                TOOL_CGROUP_PROCS_ENDPOINT_ENV,
                process_control_ipc::BOOTSTRAP_ENV
            )),
        }
    }

    /// Install runtime placement on a Tokio child command.
    ///
    /// The cloned descriptor remains close-on-exec. The pre-exec write moves
    /// the child before its program starts, and exec then closes the capability.
    pub fn configure_command(&self, command: &mut tokio::process::Command) -> io::Result<()> {
        let placement = self.placement.try_clone()?;
        // SAFETY: the closure performs one async-signal-safe raw write to an
        // already-open descriptor between fork and exec.
        unsafe {
            command
                .as_std_mut()
                .pre_exec(move || write_self_to_cgroup(placement.as_raw_fd()));
        }
        Ok(())
    }

    /// Read workload resource counters after CLI execution.
    pub fn resource_diagnostics(&self) -> io::Result<WorkloadResourceDiagnostics> {
        let cpu = fs::read_to_string(self.workload_path.join("cpu.stat"))?;
        let memory = fs::read_to_string(self.workload_path.join("memory.events"))?;
        let pids = fs::read_to_string(self.workload_path.join("pids.events"))?;
        let tool_pids = fs::read_to_string(
            self.workload_path
                .join(TOOLS_CGROUP_NAME)
                .join("pids.events"),
        )?;
        let mut events = WorkloadResourceEvents::from_file_contents(&cpu, &memory, &pids)?;
        let tool_events = WorkloadResourceEvents::from_file_contents("", "", &tool_pids)?;
        events.pids_max = events.pids_max.max(tool_events.pids_max);

        let hard_limit = events.hard_limit_diagnostic();
        let pressure = events.has_material_pressure().then(|| {
            format!(
                "workload resource pressure observed (cpu_nr_throttled={}, cpu_throttled_usec={}, memory_high={})",
                events.cpu_nr_throttled, events.cpu_throttled_usec, events.memory_high
            )
        });
        Ok(WorkloadResourceDiagnostics {
            hard_limit,
            pressure,
        })
    }

    /// Runner-owned endpoint injected into managed CLI environments.
    pub(crate) fn tool_placement_env(&self) -> (&'static str, String) {
        (
            TOOL_CGROUP_PROCS_ENDPOINT_ENV,
            self.tool_placement_endpoint.to_string(),
        )
    }

    fn receive(endpoint: &str, tool_endpoint: String) -> io::Result<Self> {
        let stream = process_control_ipc::connect_abstract(endpoint)?;
        stream.set_read_timeout(Some(WORKLOAD_BOOTSTRAP_READ_TIMEOUT))?;
        let placement = process_control_ipc::receive_workload_placement(&stream)?;
        Self::adopt(placement, tool_endpoint)
    }

    fn adopt(placement: OwnedFd, tool_endpoint: String) -> io::Result<Self> {
        // SAFETY: F_GETFD only inspects the supplied descriptor.
        let descriptor_flags = unsafe { libc::fcntl(placement.as_raw_fd(), libc::F_GETFD) };
        if descriptor_flags < 0 {
            return Err(io::Error::last_os_error());
        }
        deny_peer_process_inspection()?;
        let runtime_path = validate_descriptor(&placement)?;
        let workload_path = runtime_path
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| io::Error::other("runtime cgroup has no workload parent"))?;
        set_close_on_exec(placement.as_raw_fd(), descriptor_flags)?;

        Ok(Self {
            placement: Arc::new(placement),
            workload_path: Arc::new(workload_path),
            tool_placement_endpoint: Arc::from(tool_endpoint),
        })
    }
}

fn test_allows_unmanaged_process_control() -> bool {
    #[cfg(debug_assertions)]
    {
        matches!(
            std::env::var(TEST_ALLOW_UNMANAGED_PROCESS_CONTROL_ENV),
            Ok(value) if value == "true"
        )
    }
    #[cfg(not(debug_assertions))]
    {
        false
    }
}

fn deny_peer_process_inspection() -> io::Result<()> {
    // SAFETY: PR_SET_DUMPABLE changes only the current single-threaded Guest
    // Agent bootstrap process. Reapplying it here is required because the
    // preceding credential and exec transitions may reset the value set by
    // `vsock-guest` before exec.
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn validate_descriptor(placement: &OwnedFd) -> io::Result<PathBuf> {
    // SAFETY: F_GETFL only reads flags from a valid owned descriptor.
    let status_flags = unsafe { libc::fcntl(placement.as_raw_fd(), libc::F_GETFL) };
    if status_flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if status_flags & libc::O_ACCMODE != libc::O_WRONLY {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "workload placement fd is not write-only",
        ));
    }

    let mut stats = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: `placement` is valid and `stats` points to writable memory.
    if unsafe { libc::fstatfs(placement.as_raw_fd(), stats.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful fstatfs initialized `stats`.
    if unsafe { stats.assume_init() }.f_type as u64 != CGROUP2_SUPER_MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "workload placement fd is not on cgroup v2",
        ));
    }

    let expected = expected_workload_procs_path()?;
    let actual = fs::read_link(format!("/proc/self/fd/{}", placement.as_raw_fd()))?;
    if actual != expected {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "workload placement fd targets {}, expected {}",
                actual.display(),
                expected.display()
            ),
        ));
    }
    expected
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| io::Error::other("workload cgroup.procs path has no parent"))
}

fn expected_workload_procs_path() -> io::Result<PathBuf> {
    let content = fs::read_to_string(PROC_SELF_CGROUP)?;
    let relative = content
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "current unified cgroup path is missing",
            )
        })?;
    let path = Path::new(relative);
    let components = path.components().collect::<Vec<_>>();
    let [
        Component::RootDir,
        Component::Normal(base),
        Component::Normal(operation),
        Component::Normal(leaf),
    ] = components.as_slice()
    else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Guest Agent is not in a canonical control cgroup",
        ));
    };
    if *base != "vm0-exec"
        || !operation
            .as_encoded_bytes()
            .starts_with(EXEC_CGROUP_NAME_PREFIX.as_bytes())
        || *leaf != CONTROL_CGROUP_NAME
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Guest Agent is not in a canonical control cgroup",
        ));
    }

    Ok(Path::new(CGROUP_V2_MOUNT_PATH)
        .join(base)
        .join(operation)
        .join(WORKLOAD_CGROUP_NAME)
        .join(RUNTIME_CGROUP_NAME)
        .join(CGROUP_PROCS_FILE))
}

fn set_close_on_exec(fd: RawFd, current_flags: libc::c_int) -> io::Result<()> {
    // SAFETY: `fd` is valid and this only adds FD_CLOEXEC.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, current_flags | libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn write_self_to_cgroup(fd: RawFd) -> io::Result<()> {
    loop {
        // SAFETY: `fd` is open for writing and the one-byte buffer is valid.
        let written = unsafe { libc::write(fd, b"0".as_ptr().cast(), 1) };
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Seek, SeekFrom};
    use std::process::Stdio;

    use guest_contracts::process_containment::MATERIAL_CPU_THROTTLED_USEC;

    #[test]
    fn pre_exec_places_child_without_inheriting_descriptor() {
        let mut placement = tempfile::tempfile().unwrap();
        let containment = WorkloadContainment {
            placement: Arc::new(placement.try_clone().unwrap().into()),
            workload_path: Arc::new(PathBuf::from("/unused")),
            tool_placement_endpoint: Arc::from("test-tool-endpoint"),
        };
        let placement_fd = containment.placement.as_raw_fd();
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(format!("test ! -e /proc/self/fd/{placement_fd}"))
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        containment.configure_command(&mut command).unwrap();

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let status = runtime
            .block_on(async move { command.status().await })
            .unwrap();

        assert!(status.success());
        placement.seek(SeekFrom::Start(0)).unwrap();
        let mut content = String::new();
        placement.read_to_string(&mut content).unwrap();
        assert_eq!(content, "0");
    }

    #[test]
    fn exposes_runner_owned_tool_endpoint_for_cli_environment() {
        let containment = WorkloadContainment {
            placement: Arc::new(tempfile::tempfile().unwrap().into()),
            workload_path: Arc::new(PathBuf::from("/unused")),
            tool_placement_endpoint: Arc::from("runner-tool-endpoint"),
        };

        assert_eq!(
            containment.tool_placement_env(),
            (
                TOOL_CGROUP_PROCS_ENDPOINT_ENV,
                "runner-tool-endpoint".to_string()
            )
        );
    }

    #[test]
    fn reports_hard_limits_and_pressure_from_cgroup_counters() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("cpu.stat"),
            "usage_usec 10\nnr_throttled 2\nthrottled_usec 3\n",
        )
        .unwrap();
        fs::write(
            directory.path().join("memory.events"),
            "low 0\nhigh 4\nmax 5\noom 1\noom_kill 1\noom_group_kill 1\n",
        )
        .unwrap();
        fs::write(directory.path().join("pids.events"), "max 6\n").unwrap();
        fs::create_dir(directory.path().join(TOOLS_CGROUP_NAME)).unwrap();
        fs::write(
            directory.path().join(TOOLS_CGROUP_NAME).join("pids.events"),
            "max 7\n",
        )
        .unwrap();
        let containment = WorkloadContainment {
            placement: Arc::new(tempfile::tempfile().unwrap().into()),
            workload_path: Arc::new(directory.path().to_path_buf()),
            tool_placement_endpoint: Arc::from("test-tool-endpoint"),
        };

        let diagnostics = containment.resource_diagnostics().unwrap();

        assert_eq!(
            diagnostics.hard_limit,
            Some(WorkloadResourceLimitDiagnostic {
                memory_max_events: 5,
                memory_oom_events: 1,
                memory_oom_kill_events: 1,
                memory_oom_group_kill_events: 1,
                pids_max_events: 7,
            })
        );
        assert_eq!(
            diagnostics.pressure.as_deref(),
            Some(
                "workload resource pressure observed (cpu_nr_throttled=2, cpu_throttled_usec=3, memory_high=4)"
            )
        );
    }

    #[test]
    fn ignores_immaterial_cpu_throttling() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("cpu.stat"),
            format!(
                "usage_usec 10\nnr_throttled 2\nthrottled_usec {}\n",
                MATERIAL_CPU_THROTTLED_USEC - 1
            ),
        )
        .unwrap();
        fs::write(
            directory.path().join("memory.events"),
            "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n",
        )
        .unwrap();
        fs::write(directory.path().join("pids.events"), "max 0\n").unwrap();
        fs::create_dir(directory.path().join(TOOLS_CGROUP_NAME)).unwrap();
        fs::write(
            directory.path().join(TOOLS_CGROUP_NAME).join("pids.events"),
            "max 0\n",
        )
        .unwrap();
        let containment = WorkloadContainment {
            placement: Arc::new(tempfile::tempfile().unwrap().into()),
            workload_path: Arc::new(directory.path().to_path_buf()),
            tool_placement_endpoint: Arc::from("test-tool-endpoint"),
        };

        let diagnostics = containment.resource_diagnostics().unwrap();

        assert_eq!(
            diagnostics,
            WorkloadResourceDiagnostics {
                hard_limit: None,
                pressure: None,
            }
        );
    }
}
