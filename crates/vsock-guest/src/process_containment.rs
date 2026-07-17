use std::collections::HashSet;
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
    #[cfg(test)]
    TestDirectory(PathBuf),
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
        // Host-side debug integration tests have no guest cgroup hierarchy.
        // A real guest, including a debug build, gets the hierarchy from
        // guest-init before vsock-guest starts and therefore uses cgroups.
        if cfg!(feature = "test-support")
            || (cfg!(debug_assertions) && !Path::new(SUPERVISED_CGROUP_BASE_PATH).is_dir())
        {
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
            #[cfg(test)]
            ContainmentBackend::TestDirectory(_) => Ok(()),
        }
    }

    pub(crate) fn cleanup(self) -> Result<(), ProcessContainmentError> {
        match self.backend {
            ContainmentBackend::Cgroup(guard) => guard.cleanup(),
            ContainmentBackend::TestNoop => Ok(()),
            #[cfg(test)]
            ContainmentBackend::TestDirectory(group_path) => fs::remove_dir(group_path)
                .map_err(|error| ProcessContainmentError::new("remove test cgroup", error)),
        }
    }
}

impl CgroupGuard {
    fn create(sequence: u32) -> Result<Self, ProcessContainmentError> {
        Self::create_in(Path::new(SUPERVISED_CGROUP_BASE_PATH), sequence)
    }

    fn create_in(base_path: &Path, sequence: u32) -> Result<Self, ProcessContainmentError> {
        let started = Instant::now();
        let id = NEXT_CGROUP_ID.fetch_add(1, Ordering::Relaxed);
        let group_name = format!("exec-{}-{sequence}-{id}", std::process::id());
        let group_path = base_path.join(&group_name);
        fs::create_dir(&group_path)
            .map_err(|error| ProcessContainmentError::new("create cgroup", error))?;
        let placement = match OpenOptions::new()
            .write(true)
            .open(group_path.join(CGROUP_PROCS_FILE))
        {
            Ok(placement) => placement,
            Err(source) => {
                let original = ProcessContainmentError::new("open cgroup.procs", source);
                if let Err(rollback) = remove_empty_cgroup(&group_path) {
                    log(
                        "ERROR",
                        &format!(
                            "supervised process containment creation rollback failed group={group_name} original_stage={} original_error={} rollback_stage={} rollback_error={}",
                            original.stage, original.source, rollback.stage, rollback.source
                        ),
                    );
                }
                return Err(original);
            }
        };

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
                graceful_errors = signal_term(group_path, &pids);
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

fn signal_term(group_path: &Path, pids: &[libc::pid_t]) -> usize {
    let mut errors = 0;
    let mut candidates = Vec::with_capacity(pids.len());
    for &pid in pids {
        let pidfd = match open_pidfd(pid) {
            Ok(Some(pidfd)) => pidfd,
            Ok(None) => continue,
            Err(_) => {
                errors += 1;
                continue;
            }
        };
        candidates.push((pid, pidfd));
    }
    if candidates.is_empty() {
        return errors;
    }

    // Opening a pidfd stabilizes identity only from that point onward. Recheck
    // membership so a PID recycled after the first enumeration is never
    // signalled through a pidfd opened for an unrelated process.
    let current_members = match read_member_pids(group_path) {
        Ok(pids) => pids.into_iter().collect::<HashSet<_>>(),
        Err(_) => return errors + 1,
    };
    for (pid, pidfd) in candidates {
        if !current_members.contains(&pid) {
            continue;
        }
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
    use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
    use std::process::{Child, Stdio};

    struct ChildGuard(Child);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

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

    #[test]
    fn partial_creation_failure_removes_operation_cgroup() {
        let base = tempfile::tempdir().unwrap();

        let result = CgroupGuard::create_in(base.path(), 17);
        let Err(error) = result else {
            panic!("placement-file open unexpectedly succeeded");
        };

        assert_eq!(error.stage, "open cgroup.procs");
        assert_eq!(error.source.kind(), io::ErrorKind::NotFound);
        assert!(fs::read_dir(base.path()).unwrap().next().is_none());
    }

    #[test]
    fn spawn_failure_removes_owned_operation_cgroup() {
        let base = tempfile::tempdir().unwrap();
        let group_path = base.path().join("exec-spawn-failure");
        fs::create_dir(&group_path).unwrap();
        let containment = SupervisedProcessContainment {
            backend: ContainmentBackend::TestDirectory(group_path.clone()),
        };

        let result = crate::shell_command::spawn_shell_command_with_pipes(
            "bad\0command",
            &[],
            false,
            false,
            Some(containment),
        );
        let Err(error) = result else {
            panic!("invalid command unexpectedly spawned");
        };

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(!group_path.exists());
    }

    #[test]
    fn spawn_failure_preserves_primary_error_when_cleanup_fails() {
        let base = tempfile::tempdir().unwrap();
        let group_path = base.path().join("exec-cleanup-failure");
        fs::create_dir(&group_path).unwrap();
        fs::write(group_path.join("blocker"), b"keep directory non-empty").unwrap();
        let containment = SupervisedProcessContainment {
            backend: ContainmentBackend::TestDirectory(group_path.clone()),
        };

        let result = crate::shell_command::spawn_shell_command_with_pipes(
            "bad\0command",
            &[],
            false,
            false,
            Some(containment),
        );
        let Err(error) = result else {
            panic!("invalid command unexpectedly spawned");
        };

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(group_path.is_dir());
    }

    #[test]
    fn graceful_signal_rechecks_membership_after_opening_pidfd() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join(CGROUP_PROCS_FILE), "").unwrap();
        let mut child = ChildGuard(
            Command::new("/bin/sh")
                .arg("-c")
                .arg(
                    "trap 'printf \"term\\n\"; exit 42' TERM; \
                     printf 'ready\\n'; \
                     while IFS= read -r line; do printf '%s\\n' \"$line\"; done",
                )
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let enumerated_pid = libc::pid_t::try_from(child.0.id()).unwrap();
        let mut stdout = BufReader::new(child.0.stdout.take().unwrap());
        let mut response = String::new();
        stdout.read_line(&mut response).unwrap();
        assert_eq!(response, "ready\n");

        let errors = signal_term(directory.path(), &[enumerated_pid]);
        writeln!(child.0.stdin.as_mut().unwrap(), "probe").unwrap();
        response.clear();
        stdout.read_line(&mut response).unwrap();

        assert_eq!(errors, 0);
        assert_eq!(response, "probe\n");
    }
}
