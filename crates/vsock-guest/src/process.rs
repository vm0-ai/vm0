use std::io;
use std::process::{Child, Command, ExitStatus};

use crate::log::log;

/// Extract exit code from ExitStatus, mapping signals to 128 + signal number
#[cfg(unix)]
pub(crate) fn extract_exit_code(status: ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .unwrap_or_else(|| status.signal().map(|sig| 128 + sig).unwrap_or(1))
}

#[cfg(not(unix))]
pub(crate) fn extract_exit_code(status: ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

/// Spawn a command as the leader of a new process group on Unix.
///
/// Timeout killing targets the process group by child PID, so every child path
/// that uses the shared wait helpers must preserve this spawn invariant.
pub(crate) fn spawn_in_own_process_group(command: &mut Command) -> io::Result<Child> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0).spawn()
    }
    #[cfg(not(unix))]
    {
        command.spawn()
    }
}

/// Parse ppid and pgid from a `/proc/[pid]/stat` line.
///
/// Format: `"pid (comm) state ppid pgid session ..."` — the comm field can
/// contain spaces and parentheses, so we locate the LAST `)` first.
fn parse_stat_ppid_pgid(stat: &str) -> Option<(u32, u32)> {
    let close_paren = stat.rfind(')')?;
    if close_paren + 2 >= stat.len() {
        return None;
    }
    let remainder = &stat[close_paren + 2..]; // skip ") "
    let mut fields = remainder.split_whitespace();
    fields.next()?; // state
    let ppid = fields.next()?.parse().ok()?;
    let pgid = fields.next()?.parse().ok()?;
    Some((ppid, pgid))
}

fn process_group_signal_pid(pgid: u32) -> Option<libc::pid_t> {
    let pgid = libc::pid_t::try_from(pgid).ok()?;
    (pgid > 1).then_some(-pgid)
}

fn signalable_child_pgid(child_id: u32, pgid: u32) -> Option<u32> {
    (pgid != child_id && process_group_signal_pid(pgid).is_some()).then_some(pgid)
}

/// Find the process-group ID of a direct child of `parent_pid`.
///
/// In release builds, commands are wrapped in `su - user -c "..."`.
/// `su` forks internally and the child calls `setsid()`, creating a new
/// session and process group. `kill(-parent_pid, SIGKILL)` only reaches
/// the `su` process's group — the child's group (where the actual command
/// runs) is missed.
///
/// This function scans `/proc` to find that child and returns its distinct PGID
/// so the timeout killer can send SIGKILL to both process groups. Same-group
/// children are skipped because `kill(-parent_pid, SIGKILL)` already reaches
/// them, and a later refresh can still capture a child that calls `setsid()`.
///
/// Must be called BEFORE killing the parent, because once the parent dies
/// the child's PPID changes to 1 (init).
fn find_child_pgid(parent_pid: u32) -> Option<u32> {
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let name = entry.file_name();
        let Ok(pid) = name.to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };

        let Some((ppid, pgid)) = parse_stat_ppid_pgid(&stat) else {
            continue;
        };

        if ppid == parent_pid
            && let Some(pgid) = signalable_child_pgid(parent_pid, pgid)
        {
            return Some(pgid);
        }
    }
    None
}

#[derive(Clone, Copy)]
pub(crate) struct ProcessTreeKillTarget {
    child_id: u32,
    child_pgid: Option<u32>,
}

impl ProcessTreeKillTarget {
    pub(crate) fn child_id(self) -> u32 {
        self.child_id
    }

    fn child_pgid_to_signal(self) -> Option<u32> {
        self.child_pgid
            .and_then(|pgid| signalable_child_pgid(self.child_id, pgid))
    }
}

/// Snapshot process-tree kill targets while the direct child is still alive.
///
/// This preserves the process group created by `su - user` even if the direct
/// child exits before a later cleanup path needs to signal lingering
/// descendants that still hold stdio pipes.
pub(crate) fn process_tree_kill_target(child_id: u32) -> ProcessTreeKillTarget {
    ProcessTreeKillTarget {
        child_id,
        child_pgid: find_child_pgid(child_id),
    }
}

/// Refresh a snapshotted process-tree target while the direct child may still
/// have a distinct child session visible in `/proc`.
pub(crate) fn refresh_process_tree_kill_target(target: &mut ProcessTreeKillTarget) {
    if target.child_pgid_to_signal().is_none() {
        target.child_pgid = find_child_pgid(target.child_id);
    }
}

/// Kill a process group and, if `su -` created a child session, also kill
/// that child's process group.
///
/// # Safety
///
/// `child_id` must be a valid PID from `Command::spawn()`.
/// Returns `true` if any targeted process group was signalled.
pub(crate) unsafe fn kill_process_tree(child_id: u32) -> bool {
    // Find su's child PGID BEFORE killing — after kill, PPID changes to 1.
    let target = process_tree_kill_target(child_id);
    unsafe { kill_process_tree_target(target) }
}

/// Kill a previously snapshotted process tree target.
///
/// # Safety
///
/// `target.child_id` must come from a PID returned by `Command::spawn()`.
pub(crate) unsafe fn kill_process_tree_target(target: ProcessTreeKillTarget) -> bool {
    // Kill the direct child's process group (the su wrapper).
    let mut signalled = false;
    if let Some(signal_pid) = process_group_signal_pid(target.child_id) {
        let ret = unsafe { libc::kill(signal_pid, libc::SIGKILL) };
        signalled = ret == 0;
        if ret != 0 {
            let err = std::io::Error::last_os_error();
            log(
                "WARN",
                &format!(
                    "process-tree kill(-{}, SIGKILL) failed: {err}",
                    target.child_id
                ),
            );
        }
    } else {
        log(
            "WARN",
            &format!(
                "process-tree kill skipped invalid process group id {}",
                target.child_id
            ),
        );
    }

    // Kill the session/process group created by su's child after setsid().
    // Skip if the child is in the same group (no setsid happened, e.g. debug builds).
    // Guard pgid > 1: kill(0, sig) targets the caller's group, and kill(-1, sig)
    // broadcasts to every process the caller may signal.
    if let Some(pgid) = target.child_pgid_to_signal() {
        let Some(signal_pid) = process_group_signal_pid(pgid) else {
            return signalled;
        };
        let ret = unsafe { libc::kill(signal_pid, libc::SIGKILL) };
        if ret == 0 {
            signalled = true;
        } else {
            let err = std::io::Error::last_os_error();
            log(
                "WARN",
                &format!("process-tree kill(-{pgid}, SIGKILL) for su child group failed: {err}"),
            );
        }
    }

    signalled
}

/// Kill the process tree for a spawned child and reap the direct child.
pub(crate) fn kill_and_reap_child(child: Child) {
    let child_id = child.id();
    let target = process_tree_kill_target(child_id);
    kill_and_reap_child_with_target(child, target);
}

/// Kill a process tree using a previously snapshotted target and reap the
/// direct child.
pub(crate) fn kill_and_reap_child_with_target(mut child: Child, mut target: ProcessTreeKillTarget) {
    // Signal before waiting. The direct child may already be a zombie while
    // descendants still live in its process group; reaping first would release
    // the child PID and lose the stable PGID we need for group cleanup.
    // SAFETY: child_id comes from a live `Child` returned by Command::spawn.
    refresh_process_tree_kill_target(&mut target);
    let child_id = target.child_id;
    let tree_killed = unsafe { kill_process_tree_target(target) };
    let child_killed = child.kill().is_ok();
    let killed = tree_killed || child_killed;
    if !killed {
        log(
            "WARN",
            &format!("failed to signal process tree for child pid={child_id}"),
        );
    }

    if let Err(e) = child.wait() {
        log("WARN", &format!("failed to reap child pid={child_id}: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    #[cfg(target_os = "linux")]
    use crate::test_support::{kill_pidfd_and_wait, open_pidfd, wait_for_pidfd_exit};
    use crate::wait::{WaitOutcome, wait_with_kill_timeout};

    struct TempDirGuard(PathBuf);

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_dir(label: &str) -> (PathBuf, TempDirGuard) {
        let dir = std::env::temp_dir().join(format!(
            "vsock-guest-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let guard = TempDirGuard(dir.clone());
        (dir, guard)
    }

    fn wait_for_path(path: &std::path::Path, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if path.exists() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        path.exists()
    }

    fn read_pid_file<T: std::str::FromStr>(path: &Path) -> Option<T> {
        std::fs::read_to_string(path).ok()?.trim().parse().ok()
    }

    fn wait_for_pid_file<T: std::str::FromStr>(path: &Path, timeout: Duration) -> Option<T> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Some(pid) = read_pid_file(path) {
                return Some(pid);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        read_pid_file(path)
    }

    #[test]
    fn extract_exit_code_success() {
        let status = Command::new("true").status().unwrap();
        assert_eq!(extract_exit_code(status), 0);
    }

    #[test]
    fn extract_exit_code_failure() {
        let status = Command::new("false").status().unwrap();
        assert_eq!(extract_exit_code(status), 1);
    }

    #[test]
    fn extract_exit_code_specific() {
        let status = Command::new("sh")
            .arg("-c")
            .arg("exit 42")
            .status()
            .unwrap();
        assert_eq!(extract_exit_code(status), 42);
    }

    #[test]
    fn extract_exit_code_signal_kill() {
        // Kill a process with SIGKILL and verify 128 + 9 = 137
        let mut child = Command::new("sleep").arg("60").spawn().unwrap();
        unsafe { libc::kill(child.id() as i32, libc::SIGKILL) };
        let status = child.wait().unwrap();
        assert_eq!(extract_exit_code(status), 137);
    }

    #[test]
    fn parse_stat_ppid_pgid_normal() {
        let stat = "42 (bash) S 10 42 42 0 -1 4194560 100 0 0 0 0 0 0 0 20 0 1 0 100 0 0\n";
        assert_eq!(parse_stat_ppid_pgid(stat), Some((10, 42)));
    }

    #[test]
    fn parse_stat_ppid_pgid_comm_with_spaces() {
        // comm can contain spaces and parens
        let stat = "99 (Web Content (123)) S 50 99 99 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0\n";
        assert_eq!(parse_stat_ppid_pgid(stat), Some((50, 99)));
    }

    #[test]
    fn parse_stat_ppid_pgid_setsid_child() {
        // After setsid(): pgid (77) differs from parent's pgid
        let stat = "77 (su) S 42 77 77 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0\n";
        assert_eq!(parse_stat_ppid_pgid(stat), Some((42, 77)));
    }

    #[test]
    fn parse_stat_ppid_pgid_empty() {
        assert_eq!(parse_stat_ppid_pgid(""), None);
    }

    #[test]
    fn parse_stat_ppid_pgid_truncated() {
        // Only has closing paren, no fields after
        assert_eq!(parse_stat_ppid_pgid("1 (x)"), None);
    }

    #[test]
    fn parse_stat_ppid_pgid_not_enough_fields() {
        // Has state but no ppid/pgid
        assert_eq!(parse_stat_ppid_pgid("1 (x) S\n"), None);
    }

    #[test]
    fn parse_stat_ppid_pgid_empty_comm() {
        let stat = "1 () S 10 42 42 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n";
        assert_eq!(parse_stat_ppid_pgid(stat), Some((10, 42)));
    }

    #[test]
    fn parse_stat_ppid_pgid_no_closing_paren() {
        assert_eq!(parse_stat_ppid_pgid("1 bash S 10 42 42"), None);
    }

    #[test]
    fn child_pgid_to_signal_skips_reserved_and_self_targets() {
        assert_eq!(
            ProcessTreeKillTarget {
                child_id: 42,
                child_pgid: None
            }
            .child_pgid_to_signal(),
            None
        );
        assert_eq!(
            ProcessTreeKillTarget {
                child_id: 42,
                child_pgid: Some(0)
            }
            .child_pgid_to_signal(),
            None
        );
        assert_eq!(
            ProcessTreeKillTarget {
                child_id: 42,
                child_pgid: Some(1)
            }
            .child_pgid_to_signal(),
            None
        );
        assert_eq!(
            ProcessTreeKillTarget {
                child_id: 42,
                child_pgid: Some(42)
            }
            .child_pgid_to_signal(),
            None
        );
        assert_eq!(
            ProcessTreeKillTarget {
                child_id: 42,
                child_pgid: Some(43)
            }
            .child_pgid_to_signal(),
            Some(43)
        );
        assert_eq!(
            ProcessTreeKillTarget {
                child_id: 42,
                child_pgid: Some(i32::MAX as u32 + 1)
            }
            .child_pgid_to_signal(),
            None
        );
    }

    #[test]
    fn process_group_signal_pid_skips_reserved_and_unrepresentable_targets() {
        assert_eq!(process_group_signal_pid(0), None);
        assert_eq!(process_group_signal_pid(1), None);
        assert_eq!(process_group_signal_pid(42), Some(-42));
        assert_eq!(process_group_signal_pid(i32::MAX as u32), Some(-i32::MAX));
        assert_eq!(process_group_signal_pid(i32::MAX as u32 + 1), None);
    }

    #[cfg(target_os = "linux")]
    fn process_is_gone_or_zombie(pid: i32) -> bool {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => {
                let close_paren = stat.rfind(')').unwrap_or(0);
                stat.get(close_paren + 2..)
                    .and_then(|fields| fields.split_whitespace().next())
                    == Some("Z")
            }
            Err(_) => true,
        }
    }

    #[cfg(target_os = "linux")]
    fn wait_until_process_is_gone_or_zombie(pid: i32) -> bool {
        let deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < deadline {
            if process_is_gone_or_zombie(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        process_is_gone_or_zombie(pid)
    }

    #[cfg(target_os = "linux")]
    fn kill_spawned_child(child: &mut Option<Child>) {
        if let Some(child) = child.take() {
            kill_and_reap_child(child);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn kill_and_reap_child_kills_group_after_direct_child_exits() {
        use std::io::{BufRead, BufReader};
        use std::os::unix::process::CommandExt;

        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("sleep 60 & echo $!")
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        command.process_group(0);

        let mut child = command.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut line = String::new();
        BufReader::new(stdout).read_line(&mut line).unwrap();
        let background_pid: i32 = line.trim().parse().unwrap();

        assert_eq!(unsafe { libc::kill(background_pid, 0) }, 0);
        kill_and_reap_child(child);

        if !wait_until_process_is_gone_or_zombie(background_pid) {
            let _ = unsafe { libc::kill(background_pid, libc::SIGKILL) };
            panic!("background pid {background_pid} should have been killed");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn spawn_in_own_process_group_timeout_kills_background_child() {
        let (dir, _guard) = temp_dir("pg");
        let ready = dir.join("ready");
        let background_pid = dir.join("background-pid");

        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(
                "trap '' HUP; tail -f /dev/null & echo $! > \"$PIDFILE\"; \
                 touch \"$READY\"; wait",
            )
            .env("READY", &ready)
            .env("PIDFILE", &background_pid)
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let mut child = Some(spawn_in_own_process_group(&mut command).unwrap());
        if !wait_for_path(&ready, Duration::from_secs(2)) {
            kill_spawned_child(&mut child);
            panic!("background child should be started before timeout kill is tested");
        }
        let background_pid_text = match std::fs::read_to_string(&background_pid) {
            Ok(pid) => pid,
            Err(e) => {
                kill_spawned_child(&mut child);
                panic!("failed to read background pid: {e}");
            }
        };
        let background_pid: libc::pid_t = match background_pid_text.trim().parse() {
            Ok(pid) => pid,
            Err(e) => {
                kill_spawned_child(&mut child);
                panic!("failed to parse background pid {background_pid_text:?}: {e}");
            }
        };
        let background_pidfd = match open_pidfd(background_pid) {
            Ok(pidfd) => pidfd,
            Err(e) => {
                kill_spawned_child(&mut child);
                panic!("failed to open pidfd for pid {background_pid}: {e}");
            }
        };

        let outcome = wait_with_kill_timeout(child.take().unwrap(), 100);
        if !matches!(outcome, WaitOutcome::TimedOut) {
            kill_pidfd_and_wait(&background_pidfd)
                .unwrap_or_else(|e| panic!("failed to clean up background pidfd: {e}"));
            panic!("expected timeout kill to return WaitOutcome::TimedOut");
        }

        match wait_for_pidfd_exit(&background_pidfd, Duration::from_secs(2)) {
            Ok(true) => {}
            Ok(false) => {
                kill_pidfd_and_wait(&background_pidfd)
                    .unwrap_or_else(|e| panic!("failed to clean up background pidfd: {e}"));
                panic!(
                    "timeout kill should terminate background pid {background_pid} in the process group"
                );
            }
            Err(e) => {
                let cleanup = kill_pidfd_and_wait(&background_pidfd);
                panic!(
                    "failed to wait for background pid {background_pid} exit: {e}; cleanup={cleanup:?}"
                );
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn snapshotted_process_tree_target_kills_setsid_child_after_parent_exit() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::process::CommandExt;

        let (dir, _guard) = temp_dir("snapshot-target");
        let fifo = dir.join("parent-fifo");
        let child_pid_path = dir.join("setsid-child-pid");

        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(
                "mkfifo \"$FIFO\"; \
                 setsid sh -c 'printf %s \"$$\" > \"$CHILD_PID\"; printf \"ready\\n\"; sleep 60' & \
                 read _ < \"$FIFO\"",
            )
            .env("FIFO", &fifo)
            .env("CHILD_PID", &child_pid_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        command.process_group(0);

        let mut child = Some(command.spawn().unwrap());
        let stdout = child.as_mut().unwrap().stdout.take().unwrap();
        let mut ready = String::new();
        if let Err(e) = BufReader::new(stdout).read_line(&mut ready) {
            kill_spawned_child(&mut child);
            panic!("failed to read setsid child ready marker: {e}");
        }
        if ready != "ready\n" {
            kill_spawned_child(&mut child);
            panic!("setsid child should publish ready marker, got {ready:?}");
        }
        let child_pid_text = match std::fs::read_to_string(&child_pid_path) {
            Ok(pid) => pid,
            Err(e) => {
                kill_spawned_child(&mut child);
                panic!("failed to read setsid child pid: {e}");
            }
        };
        let child_pid: libc::pid_t = match child_pid_text.trim().parse() {
            Ok(pid) => pid,
            Err(e) => {
                kill_spawned_child(&mut child);
                panic!("failed to parse setsid child pid {child_pid_text:?}: {e}");
            }
        };
        if child_pid <= 0 {
            kill_spawned_child(&mut child);
            panic!("setsid child pid should be positive, got {child_pid}");
        }
        let child_pidfd = match open_pidfd(child_pid) {
            Ok(pidfd) => pidfd,
            Err(e) => {
                kill_spawned_child(&mut child);
                panic!("failed to open pidfd for setsid child pid {child_pid}: {e}");
            }
        };

        let target = process_tree_kill_target(child.as_ref().unwrap().id());
        {
            let mut fifo_writer = match std::fs::OpenOptions::new().write(true).open(&fifo) {
                Ok(writer) => writer,
                Err(e) => {
                    kill_spawned_child(&mut child);
                    kill_pidfd_and_wait(&child_pidfd).unwrap_or_else(|cleanup| {
                        panic!("fifo open failed: {e}; cleanup={cleanup}")
                    });
                    panic!("failed to open parent fifo: {e}");
                }
            };
            if let Err(e) = writeln!(fifo_writer, "done") {
                kill_spawned_child(&mut child);
                kill_pidfd_and_wait(&child_pidfd)
                    .unwrap_or_else(|cleanup| panic!("fifo write failed: {e}; cleanup={cleanup}"));
                panic!("failed to release parent fifo: {e}");
            }
        }
        let status = match child.take().unwrap().wait() {
            Ok(status) => status,
            Err(e) => {
                kill_pidfd_and_wait(&child_pidfd)
                    .unwrap_or_else(|cleanup| panic!("parent wait failed: {e}; cleanup={cleanup}"));
                panic!("failed to wait for parent shell: {e}");
            }
        };
        if !status.success() {
            kill_pidfd_and_wait(&child_pidfd)
                .unwrap_or_else(|cleanup| panic!("parent exited with {status}; cleanup={cleanup}"));
            panic!("parent shell should exit successfully, got {status}");
        }

        // SAFETY: `target` came from the spawned shell before it exited.
        if !unsafe { kill_process_tree_target(target) } {
            kill_pidfd_and_wait(&child_pidfd)
                .unwrap_or_else(|e| panic!("failed to clean up setsid child pidfd: {e}"));
            panic!("snapshotted target should signal at least one process group");
        }
        match wait_for_pidfd_exit(&child_pidfd, Duration::from_secs(2)) {
            Ok(true) => {}
            Ok(false) => {
                kill_pidfd_and_wait(&child_pidfd)
                    .unwrap_or_else(|e| panic!("failed to clean up setsid child pidfd: {e}"));
                panic!(
                    "snapshotted target should terminate reparented setsid child pid {child_pid}"
                );
            }
            Err(e) => {
                let cleanup = kill_pidfd_and_wait(&child_pidfd);
                panic!(
                    "failed to wait for setsid child pid {child_pid} exit: {e}; cleanup={cleanup:?}"
                );
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn refresh_process_tree_target_retries_same_group_child_pgid() {
        use std::io::Write;
        use std::os::unix::process::CommandExt;

        let (dir, _guard) = temp_dir("refresh-same-group");
        let fifo = dir.join("child-fifo");
        let child_ready = dir.join("child-ready");
        let direct_pid_path = dir.join("direct-child-pid");
        let setsid_child_pid_path = dir.join("setsid-child-pid");
        let child_script = dir.join("child.sh");
        let parent_script = dir.join("parent.sh");

        std::fs::write(
            &child_script,
            r#"#!/bin/sh
exec 3<> "$FIFO"
touch "$CHILD_READY"
read _ <&3
exec 3>&-
exec setsid sh -c 'printf %s "$$" > "$SETSID_CHILD_PID"; sleep 60'
"#,
        )
        .unwrap();
        std::fs::write(
            &parent_script,
            r#"#!/bin/sh
mkfifo "$FIFO"
sh "$CHILD_SCRIPT" &
echo $! > "$DIRECT_PID"
wait
"#,
        )
        .unwrap();

        let mut command = Command::new("sh");
        command
            .arg(&parent_script)
            .env("FIFO", &fifo)
            .env("CHILD_READY", &child_ready)
            .env("DIRECT_PID", &direct_pid_path)
            .env("SETSID_CHILD_PID", &setsid_child_pid_path)
            .env("CHILD_SCRIPT", &child_script)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.process_group(0);

        let mut child = Some(command.spawn().unwrap());
        let direct_pid: u32 = match wait_for_pid_file(&direct_pid_path, Duration::from_secs(2)) {
            Some(pid) => pid,
            None => {
                kill_spawned_child(&mut child);
                panic!("parent should publish same-group child pid before snapshot");
            }
        };
        if !wait_for_path(&child_ready, Duration::from_secs(2)) {
            kill_spawned_child(&mut child);
            panic!("same-group child should block on fifo before snapshot");
        }
        let parent_pid = child.as_ref().unwrap().id();
        let direct_stat = match std::fs::read_to_string(format!("/proc/{direct_pid}/stat")) {
            Ok(stat) => stat,
            Err(e) => {
                kill_spawned_child(&mut child);
                panic!("failed to read direct child stat: {e}");
            }
        };
        let direct_target = parse_stat_ppid_pgid(&direct_stat);
        if direct_target != Some((parent_pid, parent_pid)) {
            kill_spawned_child(&mut child);
            panic!(
                "direct child should initially share the parent process group, got {direct_target:?}"
            );
        }

        let mut target = process_tree_kill_target(parent_pid);
        {
            let mut fifo_writer = match std::fs::OpenOptions::new().write(true).open(&fifo) {
                Ok(writer) => writer,
                Err(e) => {
                    kill_spawned_child(&mut child);
                    panic!("failed to open child fifo: {e}");
                }
            };
            if let Err(e) = writeln!(fifo_writer, "go") {
                kill_spawned_child(&mut child);
                panic!("failed to release child fifo: {e}");
            }
        }

        let setsid_child_pid: libc::pid_t =
            match wait_for_pid_file(&setsid_child_pid_path, Duration::from_secs(2)) {
                Some(pid) => pid,
                None => {
                    kill_spawned_child(&mut child);
                    panic!("setsid child should publish its pid before kill");
                }
            };
        if setsid_child_pid <= 0 {
            kill_spawned_child(&mut child);
            panic!("setsid child pid should be positive, got {setsid_child_pid}");
        }
        let setsid_child_pidfd = match open_pidfd(setsid_child_pid) {
            Ok(pidfd) => pidfd,
            Err(e) => {
                kill_spawned_child(&mut child);
                // SAFETY: best-effort cleanup of a test-owned process.
                let _ = unsafe { libc::kill(setsid_child_pid, libc::SIGKILL) };
                panic!("failed to open pidfd for setsid child pid {setsid_child_pid}: {e}");
            }
        };

        refresh_process_tree_kill_target(&mut target);
        if !unsafe { kill_process_tree_target(target) } {
            kill_spawned_child(&mut child);
            kill_pidfd_and_wait(&setsid_child_pidfd)
                .unwrap_or_else(|e| panic!("failed to clean up setsid child pidfd: {e}"));
            panic!("refreshed target should signal at least one process group");
        }
        if let Err(e) = child.take().unwrap().wait() {
            kill_pidfd_and_wait(&setsid_child_pidfd)
                .unwrap_or_else(|cleanup| panic!("parent wait failed: {e}; cleanup={cleanup}"));
            panic!("failed to wait for killed parent shell: {e}");
        }

        match wait_for_pidfd_exit(&setsid_child_pidfd, Duration::from_secs(2)) {
            Ok(true) => {}
            Ok(false) => {
                kill_pidfd_and_wait(&setsid_child_pidfd)
                    .unwrap_or_else(|e| panic!("failed to clean up setsid child pidfd: {e}"));
                panic!(
                    "refresh should replace same-group child pgid and kill setsid child pid {setsid_child_pid}"
                );
            }
            Err(e) => {
                let cleanup = kill_pidfd_and_wait(&setsid_child_pidfd);
                panic!(
                    "failed to wait for setsid child pid {setsid_child_pid} exit: {e}; cleanup={cleanup:?}"
                );
            }
        }
    }
}
