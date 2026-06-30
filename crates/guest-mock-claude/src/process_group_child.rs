use std::io;
#[cfg(unix)]
use std::io::ErrorKind;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

/// Child process spawned as its own process-group leader.
pub struct ProcessGroupChild {
    child: Child,
    child_pid: u32,
}

impl ProcessGroupChild {
    /// Spawn `command`, placing it in a new process group where supported.
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        spawn_in_process_group(command).map(Self::new)
    }

    fn new(child: Child) -> Self {
        let child_pid = child.id();

        Self { child, child_pid }
    }

    /// Return the direct child PID. On Unix this is also the expected PGID.
    pub fn id(&self) -> u32 {
        self.child_pid
    }

    /// Take the configured stdin pipe from the direct child.
    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }

    /// Take the configured stdout pipe from the direct child.
    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    /// Take the configured stderr pipe from the direct child.
    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }

    /// Wait for the direct child, then clean up the process group.
    pub fn wait_with_group_cleanup(mut self) -> io::Result<ExitStatus> {
        wait_child_and_cleanup_group(&mut self.child, self.child_pid)
    }

    /// Wait for only the direct child.
    ///
    /// Callers must handle process-group cleanup before using this.
    pub fn wait_direct_child(mut self) -> io::Result<ExitStatus> {
        self.child.wait()
    }

    /// Best-effort termination for error or drop cleanup.
    pub fn terminate(mut self) {
        terminate_process_group(self.child_pid);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(unix)]
fn spawn_in_process_group(command: &mut Command) -> io::Result<Child> {
    command.process_group(0).spawn()
}

#[cfg(not(unix))]
fn spawn_in_process_group(command: &mut Command) -> io::Result<Child> {
    command.spawn()
}

#[cfg(unix)]
fn wait_child_and_cleanup_group(child: &mut Child, child_pid: u32) -> io::Result<ExitStatus> {
    if let Err(error) = observe_child_exit_without_reaping(child_pid) {
        terminate_process_group(child_pid);
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    terminate_process_group(child_pid);
    child.wait()
}

#[cfg(not(unix))]
fn wait_child_and_cleanup_group(child: &mut Child, _child_pid: u32) -> io::Result<ExitStatus> {
    child.wait()
}

/// Best-effort termination by child PID for timeout paths that cannot own `Child`.
pub fn terminate_child_by_pid(child_pid: u32) {
    terminate_process_group(child_pid);
    terminate_direct_child_by_pid(child_pid);
}

/// Best-effort process-group termination for a group-leader child PID.
pub fn terminate_process_group(child_pid: u32) {
    #[cfg(unix)]
    if let Some(process_group) = ChildProcessGroup::from_group_leader_child_id(child_pid) {
        process_group.sigkill();
    }

    #[cfg(not(unix))]
    let _ = child_pid;
}

#[cfg(unix)]
fn terminate_direct_child_by_pid(child_pid: u32) {
    if let Some(pid) = signalable_child_pid(child_pid) {
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

#[cfg(not(unix))]
fn terminate_direct_child_by_pid(_child_pid: u32) {}

#[cfg(unix)]
fn signalable_child_pid(child_pid: u32) -> Option<libc::pid_t> {
    let pid = libc::pid_t::try_from(child_pid).ok()?;
    (pid > 1 && pid != current_process_id()).then_some(pid)
}

#[cfg(unix)]
pub fn observe_child_exit_without_reaping(child_pid: u32) -> io::Result<()> {
    let pid = libc::pid_t::try_from(child_pid).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "child PID does not fit in pid_t",
        )
    })?;

    loop {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::uninit();
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if result == 0 {
            return Ok(());
        }

        let error = io::Error::last_os_error();
        if error.kind() != ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ChildProcessGroup {
    pgid: libc::pid_t,
}

#[cfg(unix)]
impl ChildProcessGroup {
    fn from_group_leader_child_id(child_pid: u32) -> Option<Self> {
        libc::pid_t::try_from(child_pid)
            .ok()
            .and_then(Self::from_raw_pgid)
    }

    fn from_raw_pgid(pgid: libc::pid_t) -> Option<Self> {
        (pgid > 1 && pgid != current_process_group()).then_some(Self { pgid })
    }

    fn sigkill(self) {
        unsafe {
            libc::kill(-self.pgid, libc::SIGKILL);
        }
    }
}

#[cfg(unix)]
fn current_process_group() -> libc::pid_t {
    unsafe { libc::getpgrp() }
}

#[cfg(unix)]
fn current_process_id() -> libc::pid_t {
    unsafe { libc::getpid() }
}

#[cfg(all(test, unix))]
mod tests {
    use super::ChildProcessGroup;

    #[test]
    fn child_process_group_rejects_dangerous_values() {
        assert_eq!(ChildProcessGroup::from_raw_pgid(0), None);
        assert_eq!(ChildProcessGroup::from_raw_pgid(1), None);
        assert_eq!(
            ChildProcessGroup::from_raw_pgid(super::current_process_group()),
            None
        );
    }

    #[test]
    fn child_process_group_rejects_child_id_overflow() {
        let overflowing_child_id = (libc::pid_t::MAX as u32).saturating_add(1);

        assert_eq!(
            ChildProcessGroup::from_group_leader_child_id(overflowing_child_id),
            None
        );
    }

    #[test]
    fn child_process_group_preserves_signalable_child_id() {
        let current_pgid = super::current_process_group();
        let child_id = if current_pgid == 42 { 43 } else { 42 };

        let process_group =
            ChildProcessGroup::from_raw_pgid(child_id).expect("signalable process group");

        assert_eq!(process_group.pgid, child_id);
    }

    #[test]
    fn signalable_child_pid_rejects_dangerous_values() {
        assert_eq!(super::signalable_child_pid(0), None);
        assert_eq!(super::signalable_child_pid(1), None);
        assert_eq!(
            super::signalable_child_pid(super::current_process_id() as u32),
            None
        );
    }

    #[test]
    fn signalable_child_pid_rejects_overflow() {
        let overflowing_child_id = (libc::pid_t::MAX as u32).saturating_add(1);

        assert_eq!(super::signalable_child_pid(overflowing_child_id), None);
    }
}
