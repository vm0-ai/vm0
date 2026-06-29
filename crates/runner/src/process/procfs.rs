use std::path::PathBuf;

use super::types::{ProcessStat, process_stat_is_live};

#[derive(Debug, Eq, PartialEq)]
enum CmdlineRead {
    Args(Vec<String>),
    Ignored,
    Missing,
    Unreadable(String),
}

fn parse_cmdline_bytes(bytes: &[u8]) -> Option<Vec<String>> {
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

/// Read `/proc/{pid}/cmdline` as the NUL-separated argv.
///
/// Returns `None` for kernel threads (empty cmdline) and for processes whose
/// cmdline has been rewritten (via `prctl(PR_SET_NAME)` or similar) into a
/// single NUL-free blob — those aren't the exec-spawned processes we care
/// about identifying here.
pub(crate) async fn read_cmdline(pid: u32) -> Option<Vec<String>> {
    let path = format!("/proc/{pid}/cmdline");
    let bytes = tokio::fs::read(&path).await.ok()?;
    parse_cmdline_bytes(&bytes)
}

async fn read_cmdline_for_scan(pid: u32) -> CmdlineRead {
    let path = format!("/proc/{pid}/cmdline");
    match tokio::fs::read(&path).await {
        Ok(bytes) => match parse_cmdline_bytes(&bytes) {
            Some(argv) => CmdlineRead::Args(argv),
            None => cmdline_problem_for_scan(pid, "cmdline is empty or NUL-free").await,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => CmdlineRead::Missing,
        Err(e) => {
            let problem = format!("cmdline read failed: {e}");
            cmdline_problem_for_scan(pid, &problem).await
        }
    }
}

async fn cmdline_problem_for_scan(pid: u32, problem: &str) -> CmdlineRead {
    cmdline_problem_for_comm(read_process_comm_for_scan(pid).await, problem)
}

fn cmdline_problem_for_comm(comm_read: ProcessCommRead, problem: &str) -> CmdlineRead {
    match comm_read {
        ProcessCommRead::Name {
            comm,
            live: Some(true),
        } if comm == b"firecracker" => CmdlineRead::Unreadable(problem.to_string()),
        ProcessCommRead::Name { comm, live: None } if comm == b"firecracker" => {
            CmdlineRead::Unreadable(format!("{problem}; stat parse failed"))
        }
        ProcessCommRead::Name { .. } => CmdlineRead::Ignored,
        ProcessCommRead::Missing => CmdlineRead::Missing,
        ProcessCommRead::Unreadable(stat_error) => {
            CmdlineRead::Unreadable(format!("{problem}; stat read failed: {stat_error}"))
        }
        ProcessCommRead::Invalid => {
            CmdlineRead::Unreadable(format!("{problem}; stat parse failed"))
        }
    }
}

/// Read `/proc/{pid}/stat` and extract the PPid field.
pub(super) async fn read_ppid(pid: u32) -> Option<u32> {
    let path = format!("/proc/{pid}/stat");
    let content = tokio::fs::read(&path).await.ok()?;
    parse_process_ppid(&content)
}

/// Return the byte fields after the `/proc/{pid}/stat` comm field.
///
/// Format: `pid (comm) state ppid pgrp ...`
/// The comm field may contain spaces and parentheses, so we find the
/// last `)` to skip past it reliably.
fn stat_fields_after_comm(content: &[u8]) -> Option<impl Iterator<Item = &[u8]> + '_> {
    let close_paren = content.iter().rposition(|byte| *byte == b')')?;
    let after_comm = content.get(close_paren + 1..)?;
    Some(
        after_comm
            .split(|byte| byte.is_ascii_whitespace())
            .filter(|field| !field.is_empty()),
    )
}

fn process_comm(content: &[u8]) -> Option<&[u8]> {
    let open_paren = content.iter().position(|byte| *byte == b'(')?;
    let close_paren = content.iter().rposition(|byte| *byte == b')')?;
    if close_paren <= open_paren {
        return None;
    }
    content.get(open_paren + 1..close_paren)
}

enum ProcessCommRead {
    Name { comm: Vec<u8>, live: Option<bool> },
    Missing,
    Unreadable(std::io::Error),
    Invalid,
}

async fn read_process_comm_for_scan(pid: u32) -> ProcessCommRead {
    let path = format!("/proc/{pid}/stat");
    match tokio::fs::read(&path).await {
        Ok(content) => {
            let Some(comm) = process_comm(&content) else {
                return ProcessCommRead::Invalid;
            };
            ProcessCommRead::Name {
                comm: comm.to_vec(),
                live: parse_process_stat(&content).map(|stat| process_stat_is_live(&stat)),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ProcessCommRead::Missing,
        Err(e) => ProcessCommRead::Unreadable(e),
    }
}

fn parse_char_field(field: &[u8]) -> Option<char> {
    std::str::from_utf8(field).ok()?.chars().next()
}

fn parse_u32_field(field: &[u8]) -> Option<u32> {
    std::str::from_utf8(field).ok()?.parse().ok()
}

fn parse_u64_field(field: &[u8]) -> Option<u64> {
    std::str::from_utf8(field).ok()?.parse().ok()
}

fn parse_process_ppid(content: &[u8]) -> Option<u32> {
    let mut fields = stat_fields_after_comm(content)?;
    let _state = fields.next()?;
    parse_u32_field(fields.next()?)
}

/// Parse process facts from `/proc/{pid}/stat` content.
fn parse_process_stat(content: &[u8]) -> Option<ProcessStat> {
    let mut fields = stat_fields_after_comm(content)?;

    // After the comm field, index 0 is stat field 3 (`state`), index 1 is
    // field 4 (`ppid`), index 2 is field 5 (`pgrp`), and index 19 is field
    // 22 (`starttime`).
    let state = parse_char_field(fields.next()?)?;
    let ppid = parse_u32_field(fields.next()?)?;
    let pgid = parse_u32_field(fields.next()?)?;
    let starttime = parse_u64_field(fields.nth(16)?)?;

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
    let content = tokio::fs::read(&path).await.ok()?;
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
/// Returns `(pid, argv)` pairs for every readable process plus whether the
/// top-level directory scan completed without errors.
pub(super) struct ProcCmdlineScan {
    pub(super) entries: Vec<(u32, Vec<String>)>,
    pub(super) complete: bool,
}

pub(super) async fn scan_proc_cmdlines() -> ProcCmdlineScan {
    let mut result = Vec::new();
    let mut complete = true;
    let mut entries = match tokio::fs::read_dir("/proc").await {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("scan_proc_cmdlines: cannot read /proc: {e}");
            return ProcCmdlineScan {
                entries: result,
                complete: false,
            };
        }
    };
    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(e) => {
                tracing::warn!("scan_proc_cmdlines: read entry in /proc: {e}");
                complete = false;
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
        match read_cmdline_for_scan(pid).await {
            CmdlineRead::Args(argv) => result.push((pid, argv)),
            CmdlineRead::Ignored | CmdlineRead::Missing => {}
            CmdlineRead::Unreadable(e) => {
                tracing::warn!("scan_proc_cmdlines: cannot read /proc/{pid}/cmdline: {e}");
                complete = false;
            }
        }
    }
    ProcCmdlineScan {
        entries: result,
        complete,
    }
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

    fn stat_bytes_with_comm(comm: &[u8], state: &str, pgid: &str, starttime: &str) -> Vec<u8> {
        let fields = [
            state, "1200", pgid, "1100", "0", "-1", "4194560", "2100", "0", "0", "0", "12", "8",
            "0", "0", "20", "0", "1", "0", starttime,
        ];
        let mut stat = b"1234 (".to_vec();
        stat.extend_from_slice(comm);
        stat.extend_from_slice(b") ");
        stat.extend_from_slice(fields.join(" ").as_bytes());
        stat
    }

    #[test]
    fn parse_cmdline_bytes_accepts_nul_separated_argv() {
        assert_eq!(
            parse_cmdline_bytes(b"firecracker\0--no-api\0"),
            Some(vec!["firecracker".to_string(), "--no-api".to_string()])
        );
    }

    #[test]
    fn parse_cmdline_bytes_rejects_empty_or_nul_free_content() {
        assert_eq!(parse_cmdline_bytes(b""), None);
        assert_eq!(parse_cmdline_bytes(b"firecracker"), None);
    }

    #[test]
    fn parse_cmdline_bytes_rejects_all_empty_segments() {
        assert_eq!(parse_cmdline_bytes(b"\0\0"), None);
    }

    #[test]
    fn cmdline_problem_for_firecracker_comm_is_unreadable() {
        assert_eq!(
            cmdline_problem_for_comm(
                ProcessCommRead::Name {
                    comm: b"firecracker".to_vec(),
                    live: Some(true),
                },
                "cmdline is empty or NUL-free",
            ),
            CmdlineRead::Unreadable("cmdline is empty or NUL-free".to_string())
        );
    }

    #[test]
    fn cmdline_problem_for_zombie_firecracker_comm_is_ignored() {
        assert_eq!(
            cmdline_problem_for_comm(
                ProcessCommRead::Name {
                    comm: b"firecracker".to_vec(),
                    live: Some(false),
                },
                "cmdline is empty or NUL-free",
            ),
            CmdlineRead::Ignored
        );
    }

    #[test]
    fn cmdline_problem_for_firecracker_comm_with_invalid_stat_is_unreadable() {
        assert_eq!(
            cmdline_problem_for_comm(
                ProcessCommRead::Name {
                    comm: b"firecracker".to_vec(),
                    live: None,
                },
                "cmdline is empty or NUL-free",
            ),
            CmdlineRead::Unreadable("cmdline is empty or NUL-free; stat parse failed".to_string())
        );
    }

    #[test]
    fn cmdline_problem_for_non_firecracker_comm_is_ignored() {
        assert_eq!(
            cmdline_problem_for_comm(
                ProcessCommRead::Name {
                    comm: b"postgres".to_vec(),
                    live: Some(true),
                },
                "cmdline is empty or NUL-free",
            ),
            CmdlineRead::Ignored
        );
    }

    #[test]
    fn process_comm_extracts_comm_with_spaces_and_parens() {
        let stat = stat_with_comm("firecracker (worker)", "S", "1100", "123456");

        assert_eq!(
            process_comm(stat.as_bytes()),
            Some(&b"firecracker (worker)"[..])
        );
    }

    #[test]
    fn process_comm_accepts_non_utf8_comm() {
        let stat = stat_bytes_with_comm(b"firecracker\xff", "S", "1100", "123456");

        assert_eq!(process_comm(&stat), Some(&b"firecracker\xff"[..]));
    }

    #[test]
    fn process_comm_rejects_missing_delimiters() {
        assert_eq!(process_comm(b"1234 firecracker) S 1 1"), None);
        assert_eq!(process_comm(b"1234 (firecracker S 1 1"), None);
    }

    #[test]
    fn parse_process_stat_simple() {
        // Real /proc/pid/stat: "1234 (firecracker) S 1200 1100 1100 ..."
        let stat = stat_with_comm("firecracker", "S", "1100", "123456");
        assert_eq!(
            parse_process_stat(stat.as_bytes()),
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
            parse_process_stat(stat.as_bytes()),
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
            parse_process_stat(stat.as_bytes()),
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
            parse_process_stat(stat.as_bytes()),
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
        assert!(parse_process_stat(b"").is_none());
    }

    #[test]
    fn parse_process_stat_truncated_before_starttime() {
        let stat = "1234 (cmd) S 100 200 200 0 0 0";
        assert!(parse_process_stat(stat.as_bytes()).is_none());
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
        assert!(parse_process_stat(stat.as_bytes()).is_none());
    }

    #[test]
    fn parse_process_stat_rejects_invalid_pgid() {
        let stat = stat_with_comm("firecracker", "S", "not-a-number", "123456");
        assert!(parse_process_stat(stat.as_bytes()).is_none());
    }

    #[test]
    fn parse_process_stat_rejects_invalid_starttime() {
        let stat = stat_with_comm("firecracker", "S", "1100", "not-a-number");
        assert!(parse_process_stat(stat.as_bytes()).is_none());
    }

    #[test]
    fn parse_process_ppid_does_not_require_starttime() {
        let stat = stat_with_comm("firecracker", "S", "1100", "not-a-number");
        assert_eq!(parse_process_ppid(stat.as_bytes()), Some(1200));
    }

    #[test]
    fn parse_process_ppid_rejects_invalid_ppid() {
        let stat = "1234 (firecracker) S not-a-number 1100";
        assert!(parse_process_ppid(stat.as_bytes()).is_none());
    }

    #[test]
    fn parse_process_ppid_rejects_missing_ppid() {
        let stat = "1234 (firecracker) S";
        assert!(parse_process_ppid(stat.as_bytes()).is_none());
    }

    #[test]
    fn parse_process_stat_accepts_non_utf8_comm() {
        let stat = stat_bytes_with_comm(b"bad \xff ) name", "S", "1100", "123456");
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
    fn parse_process_ppid_accepts_non_utf8_comm() {
        let stat = stat_bytes_with_comm(b"bad \xff ) name", "S", "1100", "not-a-number");
        assert_eq!(parse_process_ppid(&stat), Some(1200));
    }
}
