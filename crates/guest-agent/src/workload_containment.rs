//! Secure workload-cgroup placement owned by Guest Agent.
//!
//! The root guest supervisor places Guest Agent in an operation's `control`
//! leaf and passes a write-only descriptor for the sibling `workload` leaf.
//! Guest Agent adopts that descriptor before starting its async runtime, marks
//! it close-on-exec, and uses a cloned descriptor only in each CLI child's
//! `pre_exec` hook. The descriptor is never copied into a workload environment.

use std::fs;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use guest_contracts::process_containment::{
    CGROUP_V2_MOUNT_PATH, CONTROL_CGROUP_NAME, EXEC_CGROUP_NAME_PREFIX,
    MATERIAL_CPU_THROTTLED_USEC, WORKLOAD_CGROUP_NAME, WORKLOAD_CGROUP_PROCS_FD_ENV,
};

const CGROUP_PROCS_FILE: &str = "cgroup.procs";
const PROC_SELF_CGROUP: &str = "/proc/self/cgroup";
const CGROUP2_SUPER_MAGIC: u64 = 0x6367_7270;
#[cfg(debug_assertions)]
const TEST_ALLOW_UNMANAGED_PROCESS_CONTROL_ENV: &str = "VM0_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL";

/// Root-opened capability used only to place CLI children in `workload`.
#[derive(Clone, Debug)]
pub struct WorkloadContainment {
    placement: Arc<OwnedFd>,
    workload_path: Arc<PathBuf>,
}

/// Resource enforcement observed for a completed workload.
#[derive(Debug, Eq, PartialEq)]
pub struct WorkloadResourceDiagnostics {
    /// Hard memory or PID limit summary suitable for a failure message.
    pub hard_limit: Option<String>,
    /// CPU throttling or memory-high summary suitable for an informational log.
    pub pressure: Option<String>,
}

impl WorkloadContainment {
    /// Adopt the production bootstrap descriptor from the process environment.
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
        let placement_value = std::env::var_os(WORKLOAD_CGROUP_PROCS_FD_ENV);

        match (process_control_present, placement_value) {
            (false, None) => Ok(None),
            (true, None) if test_allows_unmanaged_process_control() => Ok(None),
            (true, None) => Err(format!(
                "{} is required with {}",
                WORKLOAD_CGROUP_PROCS_FD_ENV,
                process_control_ipc::BOOTSTRAP_ENV
            )),
            (false, Some(_)) => Err(format!(
                "{} requires {}",
                WORKLOAD_CGROUP_PROCS_FD_ENV,
                process_control_ipc::BOOTSTRAP_ENV
            )),
            (true, Some(value)) => {
                // SAFETY: production calls this before constructing the Tokio
                // runtime, so no other thread can access the environment.
                unsafe { std::env::remove_var(WORKLOAD_CGROUP_PROCS_FD_ENV) };
                let value = value
                    .into_string()
                    .map_err(|_| format!("{WORKLOAD_CGROUP_PROCS_FD_ENV} must be valid UTF-8"))?;
                Self::adopt(&value)
                    .map(Some)
                    .map_err(|error| format!("invalid {WORKLOAD_CGROUP_PROCS_FD_ENV}: {error}"))
            }
        }
    }

    /// Install workload placement on a Tokio child command.
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
        let cpu = read_key_values(&self.workload_path.join("cpu.stat"))?;
        let memory = read_key_values(&self.workload_path.join("memory.events"))?;
        let pids = read_key_values(&self.workload_path.join("pids.events"))?;
        let memory_max = value_or_zero(&memory, "max");
        let memory_oom = value_or_zero(&memory, "oom");
        let memory_oom_kill = value_or_zero(&memory, "oom_kill");
        let memory_oom_group_kill = value_or_zero(&memory, "oom_group_kill");
        let pids_max = value_or_zero(&pids, "max");
        let cpu_nr_throttled = value_or_zero(&cpu, "nr_throttled");
        let cpu_throttled_usec = value_or_zero(&cpu, "throttled_usec");
        let memory_high = value_or_zero(&memory, "high");

        let hard_limit = (memory_max > 0
            || memory_oom > 0
            || memory_oom_kill > 0
            || memory_oom_group_kill > 0
            || pids_max > 0)
            .then(|| {
                format!(
                    "workload resource limit reached (memory_max={memory_max}, memory_oom={memory_oom}, memory_oom_kill={memory_oom_kill}, memory_oom_group_kill={memory_oom_group_kill}, pids_max={pids_max})"
                )
            });
        let pressure =
            (cpu_throttled_usec >= MATERIAL_CPU_THROTTLED_USEC || memory_high > 0).then(|| {
            format!(
                "workload resource pressure observed (cpu_nr_throttled={cpu_nr_throttled}, cpu_throttled_usec={cpu_throttled_usec}, memory_high={memory_high})"
            )
        });
        Ok(WorkloadResourceDiagnostics {
            hard_limit,
            pressure,
        })
    }

    fn adopt(value: &str) -> io::Result<Self> {
        let raw_fd = value.parse::<RawFd>().map_err(|error| {
            io::Error::new(io::ErrorKind::InvalidInput, format!("invalid fd: {error}"))
        })?;
        if raw_fd < 3 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "workload placement fd must be at least 3",
            ));
        }

        // SAFETY: F_GETFD only inspects the supplied descriptor.
        let descriptor_flags = unsafe { libc::fcntl(raw_fd, libc::F_GETFD) };
        if descriptor_flags < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `raw_fd` was validated above and ownership is transferred
        // exactly once from the inherited bootstrap descriptor.
        let placement = unsafe { OwnedFd::from_raw_fd(raw_fd) };
        deny_peer_process_inspection()?;
        let workload_path = validate_descriptor(&placement)?;
        set_close_on_exec(placement.as_raw_fd(), descriptor_flags)?;

        Ok(Self {
            placement: Arc::new(placement),
            workload_path: Arc::new(workload_path),
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
    // preceding `su` and exec transitions may reset the value set by
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

fn read_key_values(path: &Path) -> io::Result<std::collections::HashMap<String, u64>> {
    fs::read_to_string(path)?
        .lines()
        .map(|line| {
            let mut fields = line.split_ascii_whitespace();
            let key = fields.next().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "missing cgroup counter name")
            })?;
            let value = fields
                .next()
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "missing cgroup counter value")
                })?
                .parse::<u64>()
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            if fields.next().is_some() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "unexpected cgroup counter field",
                ));
            }
            Ok((key.to_string(), value))
        })
        .collect()
}

fn value_or_zero(values: &std::collections::HashMap<String, u64>, key: &str) -> u64 {
    values.get(key).copied().unwrap_or(0)
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

    #[test]
    fn pre_exec_places_child_without_inheriting_descriptor() {
        let mut placement = tempfile::tempfile().unwrap();
        let containment = WorkloadContainment {
            placement: Arc::new(placement.try_clone().unwrap().into()),
            workload_path: Arc::new(PathBuf::from("/unused")),
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
        let containment = WorkloadContainment {
            placement: Arc::new(tempfile::tempfile().unwrap().into()),
            workload_path: Arc::new(directory.path().to_path_buf()),
        };

        let diagnostics = containment.resource_diagnostics().unwrap();

        assert_eq!(
            diagnostics.hard_limit.as_deref(),
            Some(
                "workload resource limit reached (memory_max=5, memory_oom=1, memory_oom_kill=1, memory_oom_group_kill=1, pids_max=6)"
            )
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
        let containment = WorkloadContainment {
            placement: Arc::new(tempfile::tempfile().unwrap().into()),
            workload_path: Arc::new(directory.path().to_path_buf()),
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
