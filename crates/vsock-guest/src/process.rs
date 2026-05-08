use std::process::{Child, ExitStatus};

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
    let fields: Vec<&str> = remainder.split_whitespace().collect();
    // fields: [0]=state [1]=ppid [2]=pgid [3]=session ...
    let ppid = fields.get(1)?.parse().ok()?;
    let pgid = fields.get(2)?.parse().ok()?;
    Some((ppid, pgid))
}

/// Find the process-group ID of a direct child of `parent_pid`.
///
/// In release builds, commands are wrapped in `su - user -c "..."`.
/// `su` forks internally and the child calls `setsid()`, creating a new
/// session and process group. `kill(-parent_pid, SIGKILL)` only reaches
/// the `su` process's group — the child's group (where the actual command
/// runs) is missed.
///
/// This function scans `/proc` to find that child and returns its PGID so
/// the timeout killer can send SIGKILL to both process groups.
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

        if ppid == parent_pid {
            return Some(pgid);
        }
    }
    None
}

/// Kill a process group and, if `su -` created a child session, also kill
/// that child's process group.
///
/// # Safety
///
/// `child_id` must be a valid PID from `Command::spawn()`.
/// Returns `true` if the primary kill (the direct child's group) succeeded.
pub(crate) unsafe fn kill_process_tree(child_id: u32) -> bool {
    // Find su's child PGID BEFORE killing — after kill, PPID changes to 1.
    let child_pgid = find_child_pgid(child_id);

    // Kill the direct child's process group (the su wrapper).
    let ret = unsafe { libc::kill(-(child_id as i32), libc::SIGKILL) };
    if ret != 0 {
        let err = std::io::Error::last_os_error();
        log(
            "WARN",
            &format!("process-tree kill(-{child_id}, SIGKILL) failed: {err}"),
        );
        return false;
    }

    // Kill the session/process group created by su's child after setsid().
    // Skip if the child is in the same group (no setsid happened, e.g. debug builds).
    // Guard pgid != 0: kill(0, sig) sends to the calling process's own group.
    if let Some(pgid) = child_pgid
        && pgid != 0
        && pgid != child_id
    {
        let ret = unsafe { libc::kill(-(pgid as i32), libc::SIGKILL) };
        if ret != 0 {
            let err = std::io::Error::last_os_error();
            log(
                "WARN",
                &format!("process-tree kill(-{pgid}, SIGKILL) for su child group failed: {err}"),
            );
        }
    }

    true
}

/// Kill the process tree for a spawned child and reap the direct child.
pub(crate) fn kill_and_reap_child(mut child: Child) {
    let child_id = child.id();

    // Signal before waiting. The direct child may already be a zombie while
    // descendants still live in its process group; reaping first would release
    // the child PID and lose the stable PGID we need for group cleanup.
    // SAFETY: child_id comes from a live `Child` returned by Command::spawn.
    let killed = unsafe { kill_process_tree(child_id) } || child.kill().is_ok();
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

pub(crate) struct ChildReapGuard {
    child: Option<Child>,
}

impl ChildReapGuard {
    pub(crate) fn new(child: Child) -> Self {
        Self { child: Some(child) }
    }

    pub(crate) fn into_child(mut self) -> Option<Child> {
        self.child.take()
    }
}

impl Drop for ChildReapGuard {
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            kill_and_reap_child(child);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

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
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while std::time::Instant::now() < deadline {
            if process_is_gone_or_zombie(pid) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        process_is_gone_or_zombie(pid)
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn kill_and_reap_child_kills_group_after_direct_child_exits() {
        use std::io::{BufRead, BufReader};
        use std::os::unix::process::CommandExt;
        use std::process::Stdio;

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
}
