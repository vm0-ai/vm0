use std::fs::{self, OpenOptions};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use guest_contracts::process_containment::SUPERVISED_CGROUP_BASE_PATH;

use crate::log::log;

const CGROUP_EVENTS_FILE: &str = "cgroup.events";
const CGROUP_KILL_FILE: &str = "cgroup.kill";
const CGROUP_PROCS_FILE: &str = "cgroup.procs";
const POLL_INTERVAL: Duration = Duration::from_millis(10);
const TERM_GRACE: Duration = Duration::from_millis(500);
const KILL_EMPTY_TIMEOUT: Duration = Duration::from_secs(1);
const REMOVE_TIMEOUT: Duration = Duration::from_millis(250);

static NEXT_CGROUP_ID: AtomicU64 = AtomicU64::new(1);

pub(crate) struct SupervisedProcessContainment {
    backend: ContainmentBackend,
}

enum ContainmentBackend {
    Cgroup(CgroupGuard),
    TestNoop,
}

struct CgroupGuard {
    group_name: String,
    group_path: PathBuf,
    placement: OwnedFd,
    create_elapsed: Duration,
}

#[derive(Debug)]
pub(crate) struct ProcessContainmentError {
    stage: &'static str,
    source: io::Error,
}

impl std::fmt::Display for ProcessContainmentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.stage, self.source)
    }
}

impl std::error::Error for ProcessContainmentError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

impl ProcessContainmentError {
    fn new(stage: &'static str, source: io::Error) -> Self {
        Self { stage, source }
    }
}

impl SupervisedProcessContainment {
    pub(crate) fn create(sequence: u32) -> Result<Self, ProcessContainmentError> {
        if cfg!(debug_assertions) || cfg!(feature = "test-support") {
            return Ok(Self {
                backend: ContainmentBackend::TestNoop,
            });
        }

        CgroupGuard::create(sequence).map(|guard| Self {
            backend: ContainmentBackend::Cgroup(guard),
        })
    }

    pub(crate) fn configure_command(
        &self,
        command: &mut Command,
    ) -> Result<(), ProcessContainmentError> {
        match &self.backend {
            ContainmentBackend::Cgroup(guard) => guard.configure_command(command),
            ContainmentBackend::TestNoop => Ok(()),
        }
    }

    pub(crate) fn cleanup(self) -> Result<(), ProcessContainmentError> {
        match self.backend {
            ContainmentBackend::Cgroup(guard) => guard.cleanup(),
            ContainmentBackend::TestNoop => Ok(()),
        }
    }
}

impl CgroupGuard {
    fn create(sequence: u32) -> Result<Self, ProcessContainmentError> {
        let started = Instant::now();
        let id = NEXT_CGROUP_ID.fetch_add(1, Ordering::Relaxed);
        let group_name = format!("exec-{}-{sequence}-{id}", std::process::id());
        let group_path = Path::new(SUPERVISED_CGROUP_BASE_PATH).join(&group_name);
        fs::create_dir(&group_path)
            .map_err(|error| ProcessContainmentError::new("create cgroup", error))?;
        let placement = OpenOptions::new()
            .write(true)
            .open(group_path.join(CGROUP_PROCS_FILE))
            .map_err(|error| ProcessContainmentError::new("open cgroup.procs", error))?;

        Ok(Self {
            group_name,
            group_path,
            placement: placement.into(),
            create_elapsed: started.elapsed(),
        })
    }

    fn configure_command(&self, command: &mut Command) -> Result<(), ProcessContainmentError> {
        let placement = self
            .placement
            .try_clone()
            .map_err(|error| ProcessContainmentError::new("clone cgroup.procs", error))?;
        install_child_placement(command, placement);
        Ok(())
    }

    fn cleanup(self) -> Result<(), ProcessContainmentError> {
        let started = Instant::now();
        let CgroupGuard {
            group_name,
            group_path,
            placement,
            create_elapsed,
        } = self;
        drop(placement);

        let result = cleanup_cgroup(&group_path);
        match result {
            Ok(report) => {
                log(
                    "INFO",
                    &format!(
                        "supervised process containment cleaned group={group_name} descendants_observed={} cgroup_kill_used={} initial_members={} graceful_errors={} create_us={} cleanup_ms={}",
                        report.descendants_observed,
                        report.cgroup_kill_used,
                        report.initial_members,
                        report.graceful_errors,
                        create_elapsed.as_micros(),
                        started.elapsed().as_millis()
                    ),
                );
                Ok(())
            }
            Err(error) => {
                log(
                    "ERROR",
                    &format!(
                        "supervised process containment cleanup failed group={group_name} stage={} error={}",
                        error.stage, error.source
                    ),
                );
                Err(error)
            }
        }
    }
}

struct CleanupReport {
    descendants_observed: bool,
    cgroup_kill_used: bool,
    initial_members: usize,
    graceful_errors: usize,
}

fn cleanup_cgroup(group_path: &Path) -> Result<CleanupReport, ProcessContainmentError> {
    let descendants_observed = read_populated(group_path)?;
    let mut cgroup_kill_used = false;
    let mut initial_members = 0;
    let mut graceful_errors = 0;

    if descendants_observed {
        match read_member_pids(group_path) {
            Ok(pids) => {
                initial_members = pids.len();
                graceful_errors = signal_term(&pids);
            }
            Err(error) => {
                graceful_errors = 1;
                log(
                    "WARN",
                    &format!(
                        "supervised process containment graceful enumeration failed error={error}"
                    ),
                );
            }
        }

        if !wait_until_empty(group_path, TERM_GRACE)? {
            fs::write(group_path.join(CGROUP_KILL_FILE), b"1")
                .map_err(|error| ProcessContainmentError::new("write cgroup.kill", error))?;
            cgroup_kill_used = true;
            if !wait_until_empty(group_path, KILL_EMPTY_TIMEOUT)? {
                return Err(ProcessContainmentError::new(
                    "wait for cgroup.kill",
                    io::Error::new(
                        io::ErrorKind::TimedOut,
                        "cgroup remained populated after cgroup.kill",
                    ),
                ));
            }
        }
    }

    remove_empty_cgroup(group_path)?;
    Ok(CleanupReport {
        descendants_observed,
        cgroup_kill_used,
        initial_members,
        graceful_errors,
    })
}

fn install_child_placement(command: &mut Command, placement: OwnedFd) {
    // SAFETY: the closure performs only a raw write to an already-open file
    // descriptor. `write` and reading errno are async-signal-safe between
    // `fork` and `exec`.
    unsafe {
        command.pre_exec(move || write_self_to_cgroup(placement.as_raw_fd()));
    }
}

fn write_self_to_cgroup(fd: RawFd) -> io::Result<()> {
    loop {
        // SAFETY: `fd` is open for writing and the one-byte buffer is valid for
        // the duration of the call.
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

fn read_populated(group_path: &Path) -> Result<bool, ProcessContainmentError> {
    let content = fs::read_to_string(group_path.join(CGROUP_EVENTS_FILE))
        .map_err(|error| ProcessContainmentError::new("read cgroup.events", error))?;
    parse_populated(&content).ok_or_else(|| {
        ProcessContainmentError::new(
            "parse cgroup.events",
            io::Error::new(
                io::ErrorKind::InvalidData,
                "cgroup.events is missing populated state",
            ),
        )
    })
}

fn parse_populated(content: &str) -> Option<bool> {
    content.lines().find_map(|line| {
        let (key, value) = line.split_once(' ')?;
        if key != "populated" {
            return None;
        }
        match value {
            "0" => Some(false),
            "1" => Some(true),
            _ => None,
        }
    })
}

fn read_member_pids(group_path: &Path) -> io::Result<Vec<libc::pid_t>> {
    let content = fs::read_to_string(group_path.join(CGROUP_PROCS_FILE))?;
    content
        .lines()
        .map(|line| {
            let pid = line
                .parse::<libc::pid_t>()
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            if pid <= 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "cgroup.procs contains a non-positive pid",
                ));
            }
            Ok(pid)
        })
        .collect()
}

fn signal_term(pids: &[libc::pid_t]) -> usize {
    let mut errors = 0;
    for &pid in pids {
        let pidfd = match open_pidfd(pid) {
            Ok(Some(pidfd)) => pidfd,
            Ok(None) => continue,
            Err(_) => {
                errors += 1;
                continue;
            }
        };
        if let Err(error) = signal_pidfd(&pidfd, libc::SIGTERM)
            && error.raw_os_error() != Some(libc::ESRCH)
        {
            errors += 1;
        }
    }
    errors
}

fn open_pidfd(pid: libc::pid_t) -> io::Result<Option<OwnedFd>> {
    // SAFETY: `pidfd_open` does not dereference user pointers and the PID came
    // from the kernel-owned cgroup.procs file.
    let result = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if result < 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        return Err(error);
    }
    let fd = RawFd::try_from(result)
        .map_err(|_| io::Error::other("pidfd_open returned an invalid file descriptor"))?;
    // SAFETY: `fd` is a new descriptor returned by pidfd_open.
    Ok(Some(unsafe { OwnedFd::from_raw_fd(fd) }))
}

fn signal_pidfd(pidfd: &OwnedFd, signal: libc::c_int) -> io::Result<()> {
    // SAFETY: `pidfd` is valid, signal is a standard signal number, and a null
    // siginfo pointer requests ordinary signal semantics.
    let result = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            pidfd.as_raw_fd(),
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn wait_until_empty(group_path: &Path, timeout: Duration) -> Result<bool, ProcessContainmentError> {
    let deadline = Instant::now() + timeout;
    loop {
        if !read_populated(group_path)? {
            return Ok(true);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(false);
        }
        thread::sleep(remaining.min(POLL_INTERVAL));
    }
}

fn remove_empty_cgroup(group_path: &Path) -> Result<(), ProcessContainmentError> {
    let deadline = Instant::now() + REMOVE_TIMEOUT;
    loop {
        match fs::remove_dir(group_path) {
            Ok(()) => return Ok(()),
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(libc::EBUSY) | Some(libc::ENOTEMPTY)
                ) && Instant::now() < deadline =>
            {
                thread::sleep(POLL_INTERVAL);
            }
            Err(error) => {
                return Err(ProcessContainmentError::new("remove cgroup", error));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Seek, SeekFrom};
    use std::process::Stdio;

    #[test]
    fn parses_recursive_populated_state() {
        assert_eq!(parse_populated("populated 0\nfrozen 0\n"), Some(false));
        assert_eq!(parse_populated("populated 1\nfrozen 0\n"), Some(true));
        assert_eq!(parse_populated("frozen 0\n"), None);
        assert_eq!(parse_populated("populated 2\n"), None);
    }

    #[test]
    fn pre_exec_writes_child_into_open_placement_file() {
        let mut placement = tempfile::tempfile().unwrap();
        let child_fd: OwnedFd = placement.try_clone().unwrap().into();
        let mut command = Command::new("/bin/true");
        command.stdout(Stdio::null()).stderr(Stdio::null());
        install_child_placement(&mut command, child_fd);

        let status = command.status().unwrap();

        assert!(status.success());
        placement.seek(SeekFrom::Start(0)).unwrap();
        let mut content = String::new();
        placement.read_to_string(&mut content).unwrap();
        assert_eq!(content, "0");
    }
}
