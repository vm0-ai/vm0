use std::path::PathBuf;

use super::types::ProcessStat;

/// Read `/proc/{pid}/cmdline` as the NUL-separated argv.
///
/// Returns `None` for kernel threads (empty cmdline) and for processes whose
/// cmdline has been rewritten (via `prctl(PR_SET_NAME)` or similar) into a
/// single NUL-free blob — those aren't the exec-spawned processes we care
/// about identifying here.
pub(crate) async fn read_cmdline(pid: u32) -> Option<Vec<String>> {
    let path = format!("/proc/{pid}/cmdline");
    let bytes = tokio::fs::read(&path).await.ok()?;
    if bytes.is_empty() || !bytes.contains(&0) {
        return None;
    }
    let argv: Vec<String> = bytes
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect();
    if argv.is_empty() { None } else { Some(argv) }
}

/// Read `/proc/{pid}/stat` and extract the PPid field.
pub(super) async fn read_ppid(pid: u32) -> Option<u32> {
    let path = format!("/proc/{pid}/stat");
    let content = tokio::fs::read_to_string(&path).await.ok()?;
    parse_process_ppid(&content)
}

/// Return the fields after the `/proc/{pid}/stat` comm field.
///
/// Format: `pid (comm) state ppid pgrp ...`
/// The comm field may contain spaces and parentheses, so we find the
/// last `)` to skip past it reliably.
fn stat_fields_after_comm(content: &str) -> Option<std::str::SplitWhitespace<'_>> {
    let after_comm = content.rsplit_once(')')?.1;
    Some(after_comm.split_whitespace())
}

fn parse_process_ppid(content: &str) -> Option<u32> {
    let mut fields = stat_fields_after_comm(content)?;
    let _state = fields.next()?;
    fields.next()?.parse().ok()
}

/// Parse process facts from `/proc/{pid}/stat` content.
fn parse_process_stat(content: &str) -> Option<ProcessStat> {
    let mut fields = stat_fields_after_comm(content)?;

    // After the comm field, index 0 is stat field 3 (`state`), index 1 is
    // field 4 (`ppid`), index 2 is field 5 (`pgrp`), and index 19 is field
    // 22 (`starttime`).
    let state = fields.next()?.chars().next()?;
    let ppid = fields.next()?.parse().ok()?;
    let pgid = fields.next()?.parse().ok()?;
    let starttime = fields.nth(16)?.parse().ok()?;

    Some(ProcessStat {
        state,
        ppid,
        pgid,
        starttime,
    })
}

/// Read `/proc/{pid}/stat` and extract process facts.
pub(crate) async fn read_process_stat(pid: u32) -> Option<ProcessStat> {
    let path = format!("/proc/{pid}/stat");
    let content = tokio::fs::read_to_string(&path).await.ok()?;
    parse_process_stat(&content)
}

/// Read `/proc/{pid}/cwd` symlink to get the process working directory.
pub(crate) async fn read_cwd(pid: u32) -> Option<PathBuf> {
    let link = format!("/proc/{pid}/cwd");
    tokio::fs::read_link(&link).await.ok()
}

/// Read `/proc/{pid}/cgroup` and extract the systemd unit name (cgroup v2).
///
/// Example content: `0::/system.slice/vm0-runner-v0.2.0.service\n`
/// Returns `Some("vm0-runner-v0.2.0")` for the above.
pub async fn read_service_unit(pid: u32) -> Option<String> {
    let path = format!("/proc/{pid}/cgroup");
    let content = tokio::fs::read_to_string(&path).await.ok()?;
    for line in content.lines() {
        // cgroup v2 format: "0::/<slice>/<unit>.service"
        // cgroup v1 format: "<id>:<controller>:/<slice>/<unit>.service"
        let path_part = line.rsplit_once(':')?.1;
        let basename = path_part.rsplit('/').next()?;
        if let Some(unit) = basename.strip_suffix(".service") {
            return Some(unit.to_string());
        }
    }
    None
}

/// Scan `/proc` for all process argvs.
///
/// Returns `(pid, argv)` pairs for every readable process.
pub(super) async fn scan_proc_cmdlines() -> Vec<(u32, Vec<String>)> {
    let mut result = Vec::new();
    let mut entries = match tokio::fs::read_dir("/proc").await {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("scan_proc_cmdlines: cannot read /proc: {e}");
            return result;
        }
    };
    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(e) => {
                tracing::warn!("scan_proc_cmdlines: read entry in /proc: {e}");
                continue;
            }
        };
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        let Ok(pid) = name_str.parse::<u32>() else {
            continue;
        };
        if let Some(argv) = read_cmdline(pid).await {
            result.push((pid, argv));
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stat_with_comm(comm: &str, state: &str, pgid: &str, starttime: &str) -> String {
        let fields = vec![
            state, "1200", pgid, "1100", "0", "-1", "4194560", "2100", "0", "0", "0", "12", "8",
            "0", "0", "20", "0", "1", "0", starttime,
        ];
        format!("1234 ({comm}) {}", fields.join(" "))
    }

    #[test]
    fn parse_process_stat_simple() {
        // Real /proc/pid/stat: "1234 (firecracker) S 1200 1100 1100 ..."
        let stat = stat_with_comm("firecracker", "S", "1100", "123456");
        assert_eq!(
            parse_process_stat(&stat),
            Some(ProcessStat {
                state: 'S',
                ppid: 1200,
                pgid: 1100,
                starttime: 123456
            })
        );
    }

    #[test]
    fn parse_process_stat_comm_with_spaces() {
        // comm can contain spaces
        let stat = stat_with_comm("Web Content", "S", "200", "999");
        assert_eq!(
            parse_process_stat(&stat),
            Some(ProcessStat {
                state: 'S',
                ppid: 1200,
                pgid: 200,
                starttime: 999
            })
        );
    }

    #[test]
    fn parse_process_stat_comm_with_parens() {
        // comm can contain parentheses — last ')' is the delimiter
        let stat = stat_with_comm("foo (bar)", "S", "600", "888");
        assert_eq!(
            parse_process_stat(&stat),
            Some(ProcessStat {
                state: 'S',
                ppid: 1200,
                pgid: 600,
                starttime: 888
            })
        );
    }

    #[test]
    fn parse_process_stat_zombie_state() {
        let stat = stat_with_comm("firecracker", "Z", "1100", "123456");
        assert_eq!(
            parse_process_stat(&stat),
            Some(ProcessStat {
                state: 'Z',
                ppid: 1200,
                pgid: 1100,
                starttime: 123456
            })
        );
    }

    #[test]
    fn parse_process_stat_empty() {
        assert!(parse_process_stat("").is_none());
    }

    #[test]
    fn parse_process_stat_truncated_before_starttime() {
        let stat = "1234 (cmd) S 100 200 200 0 0 0";
        assert!(parse_process_stat(stat).is_none());
    }

    #[test]
    fn parse_process_stat_rejects_invalid_ppid() {
        let fields = [
            "S",
            "not-a-number",
            "1100",
            "1100",
            "0",
            "-1",
            "4194560",
            "2100",
            "0",
            "0",
            "0",
            "12",
            "8",
            "0",
            "0",
            "20",
            "0",
            "1",
            "0",
            "123456",
        ];
        let stat = format!("1234 (firecracker) {}", fields.join(" "));
        assert!(parse_process_stat(&stat).is_none());
    }

    #[test]
    fn parse_process_stat_rejects_invalid_pgid() {
        let stat = stat_with_comm("firecracker", "S", "not-a-number", "123456");
        assert!(parse_process_stat(&stat).is_none());
    }

    #[test]
    fn parse_process_stat_rejects_invalid_starttime() {
        let stat = stat_with_comm("firecracker", "S", "1100", "not-a-number");
        assert!(parse_process_stat(&stat).is_none());
    }

    #[test]
    fn parse_process_ppid_does_not_require_starttime() {
        let stat = stat_with_comm("firecracker", "S", "1100", "not-a-number");
        assert_eq!(parse_process_ppid(&stat), Some(1200));
    }

    #[test]
    fn parse_process_ppid_rejects_invalid_ppid() {
        let stat = "1234 (firecracker) S not-a-number 1100";
        assert!(parse_process_ppid(stat).is_none());
    }

    #[test]
    fn parse_process_ppid_rejects_missing_ppid() {
        let stat = "1234 (firecracker) S";
        assert!(parse_process_ppid(stat).is_none());
    }
}
