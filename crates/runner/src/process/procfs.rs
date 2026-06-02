use std::path::PathBuf;

/// Read `/proc/{pid}/cmdline` as the NUL-separated argv.
///
/// Returns `None` for kernel threads (empty cmdline) and for processes whose
/// cmdline has been rewritten (via `prctl(PR_SET_NAME)` or similar) into a
/// single NUL-free blob — those aren't the exec-spawned processes we care
/// about identifying here.
async fn read_cmdline(pid: u32) -> Option<Vec<String>> {
    let path = format!("/proc/{pid}/cmdline");
    let bytes = tokio::fs::read(&path).await.ok()?;
    if bytes.is_empty() {
        return None;
    }
    let argv: Vec<String> = bytes
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect();
    if argv.is_empty() { None } else { Some(argv) }
}

/// Read `/proc/{pid}/status` and extract the PPid field.
pub(super) async fn read_ppid(pid: u32) -> Option<u32> {
    let path = format!("/proc/{pid}/status");
    let content = tokio::fs::read_to_string(&path).await.ok()?;
    for line in content.lines() {
        if let Some(val) = line.strip_prefix("PPid:\t") {
            return val.trim().parse().ok();
        }
    }
    None
}

/// Parse the process group ID from `/proc/{pid}/stat` content.
///
/// Format: `pid (comm) state ppid pgrp ...`
/// The comm field may contain spaces and parentheses, so we find the
/// last `)` to skip past it reliably.
fn parse_pgid_from_stat(content: &str) -> Option<u32> {
    let after_comm = content.rsplit_once(')')?.1;
    let mut fields = after_comm.split_whitespace();
    let _state = fields.next()?;
    let _ppid = fields.next()?;
    let pgrp = fields.next()?;
    pgrp.parse().ok()
}

/// Read `/proc/{pid}/stat` and extract the process group ID (field 5).
pub async fn read_pgid(pid: u32) -> Option<u32> {
    let path = format!("/proc/{pid}/stat");
    let content = tokio::fs::read_to_string(&path).await.ok()?;
    parse_pgid_from_stat(&content)
}

/// Read `/proc/{pid}/cwd` symlink to get the process working directory.
pub(super) async fn read_cwd(pid: u32) -> Option<PathBuf> {
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

    #[test]
    fn parse_pgid_simple() {
        // Real /proc/pid/stat: "1234 (firecracker) S 1200 1100 1100 ..."
        let stat = "1234 (firecracker) S 1200 1100 1100 0 0 0";
        assert_eq!(parse_pgid_from_stat(stat), Some(1100));
    }

    #[test]
    fn parse_pgid_comm_with_spaces() {
        // comm can contain spaces
        let stat = "5678 (Web Content) S 100 200 200 0 0 0";
        assert_eq!(parse_pgid_from_stat(stat), Some(200));
    }

    #[test]
    fn parse_pgid_comm_with_parens() {
        // comm can contain parentheses — last ')' is the delimiter
        let stat = "9999 (foo (bar)) S 500 600 600 0 0 0";
        assert_eq!(parse_pgid_from_stat(stat), Some(600));
    }

    #[test]
    fn parse_pgid_empty() {
        assert!(parse_pgid_from_stat("").is_none());
    }

    #[test]
    fn parse_pgid_truncated() {
        // Missing pgrp field
        let stat = "1234 (cmd) S 100";
        assert!(parse_pgid_from_stat(stat).is_none());
    }
}
