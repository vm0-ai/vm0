//! Process discovery via `/proc` scanning.
//!
//! Shared between `doctor` and `kill` commands. All cmdline parsers
//! are pure functions testable without a running system.

use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Info structs
// ---------------------------------------------------------------------------

/// Info extracted from a runner process cmdline.
pub struct RunnerProcessInfo {
    pub pid: u32,
    pub config_path: PathBuf,
    pub subcommand: String,
}

/// Info extracted from a firecracker process cmdline.
pub struct FirecrackerProcessInfo {
    pub pid: u32,
    pub ppid: Option<u32>,
    pub run_id: String,
    pub base_dir: Option<PathBuf>,
}

/// Info extracted from a mitmdump process cmdline.
pub struct MitmproxyProcessInfo {
    pub pid: u32,
    pub ppid: Option<u32>,
    pub port: u16,
}

/// Info extracted from a dnsmasq process cmdline.
pub struct DnsmasqProcessInfo {
    pub pid: u32,
    pub port: u16,
}

/// All discovered process info from a single `/proc` scan.
pub struct DiscoveredProcesses {
    pub runners: Vec<RunnerProcessInfo>,
    pub firecrackers: Vec<FirecrackerProcessInfo>,
    pub mitmdumps: Vec<MitmproxyProcessInfo>,
    pub dnsmasqs: Vec<DnsmasqProcessInfo>,
}

// ---------------------------------------------------------------------------
// Pure parsers — unit-testable without a running system
// ---------------------------------------------------------------------------

/// Parse a runner cmdline for `start`/`benchmark` subcommand and `--config` path.
///
/// Returns `(config_path, subcommand)` or `None` if the cmdline doesn't match.
fn parse_runner_cmdline(cmdline: &str) -> Option<(PathBuf, String)> {
    let tokens: Vec<&str> = cmdline.split_whitespace().collect();

    // Must have "start" or "benchmark" subcommand
    let subcmd_pos = tokens
        .iter()
        .position(|&t| t == "start" || t == "benchmark")?;
    let subcmd = (*tokens.get(subcmd_pos)?).to_string();

    // Must have "--config" (or "-c") followed by a path
    let config_pos = tokens.iter().position(|&t| t == "--config" || t == "-c")?;
    let config_path = *tokens.get(config_pos + 1)?;

    Some((PathBuf::from(config_path), subcmd))
}

/// Check if a cmdline belongs to a firecracker process.
///
/// Looks at the binary name (first token) — the run ID and base directory
/// are resolved from `/proc/{pid}/cwd` instead of argument parsing,
/// since our sandbox always sets `current_dir` to the workspace.
fn is_firecracker_cmdline(cmdline: &str) -> bool {
    let binary = cmdline.split_whitespace().next().unwrap_or("");
    Path::new(binary).file_name().and_then(|n| n.to_str()) == Some("firecracker")
}

/// Parse a mitmdump cmdline for the listen port.
///
/// Identifies our mitmdump by `vm0_proxy_registry_path=` and extracts
/// the `--listen-port` value.
fn parse_mitmdump_cmdline(cmdline: &str) -> Option<u16> {
    let tokens: Vec<&str> = cmdline.split_whitespace().collect();
    // Must be our mitmdump (has vm0_proxy_registry_path)
    if !tokens
        .iter()
        .any(|t| t.starts_with("vm0_proxy_registry_path="))
    {
        return None;
    }
    // Extract --listen-port value
    let pos = tokens.iter().position(|&t| t == "--listen-port")?;
    tokens.get(pos + 1)?.parse().ok()
}

/// Parse a dnsmasq cmdline for the listen port.
///
/// Identifies dnsmasq by binary name and extracts the `--port` value.
fn parse_dnsmasq_cmdline(cmdline: &str) -> Option<u16> {
    let tokens: Vec<&str> = cmdline.split_whitespace().collect();
    let binary = tokens.first()?;
    if !binary.ends_with("dnsmasq") {
        return None;
    }
    let pos = tokens.iter().position(|&t| t == "--port")?;
    tokens.get(pos + 1)?.parse().ok()
}

// ---------------------------------------------------------------------------
// /proc helpers
// ---------------------------------------------------------------------------

/// Read `/proc/{pid}/cmdline`, replacing NUL separators with spaces.
async fn read_cmdline(pid: u32) -> Option<String> {
    let path = format!("/proc/{pid}/cmdline");
    let mut bytes = tokio::fs::read(&path).await.ok()?;
    if bytes.is_empty() {
        return None;
    }
    for b in &mut bytes {
        if *b == 0 {
            *b = b' ';
        }
    }
    let s = String::from_utf8_lossy(&bytes);
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Read `/proc/{pid}/status` and extract the PPid field.
async fn read_ppid(pid: u32) -> Option<u32> {
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
async fn read_cwd(pid: u32) -> Option<PathBuf> {
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

/// Scan `/proc` for all process cmdlines.
///
/// Returns `(pid, cmdline)` pairs for every readable process.
async fn scan_proc_cmdlines() -> Vec<(u32, String)> {
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
                break;
            }
        };
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        let Ok(pid) = name_str.parse::<u32>() else {
            continue;
        };
        if let Some(cmdline) = read_cmdline(pid).await {
            result.push((pid, cmdline));
        }
    }
    result
}

/// Extract run_id and base_dir from a firecracker workspace CWD.
///
/// CWD is `{base_dir}/workspaces/{id}/`, so:
/// - `id` is the last component (run_id)
/// - `base_dir` is the grandparent of `workspaces`
fn parse_workspace_cwd(cwd: &Path) -> Option<(String, PathBuf)> {
    let run_id = cwd.file_name()?.to_string_lossy().into_owned();
    let workspaces_dir = cwd.parent()?;
    if workspaces_dir.file_name().and_then(|n| n.to_str()) == Some("workspaces") {
        let base_dir = workspaces_dir.parent()?.to_path_buf();
        Some((run_id, base_dir))
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Discovery — single /proc scan, dispatches to all parsers
// ---------------------------------------------------------------------------

/// Scan `/proc` once and discover all runner, firecracker, and mitmdump processes.
pub async fn discover_all() -> DiscoveredProcesses {
    let procs = scan_proc_cmdlines().await;

    let mut runners = Vec::new();
    let mut firecrackers = Vec::new();
    let mut mitmdumps = Vec::new();
    let mut dnsmasqs = Vec::new();

    for (pid, cmdline) in &procs {
        if let Some((config_path, subcommand)) = parse_runner_cmdline(cmdline) {
            runners.push(RunnerProcessInfo {
                pid: *pid,
                config_path,
                subcommand,
            });
        }
        if is_firecracker_cmdline(cmdline) {
            firecrackers.push(*pid);
        }
        if let Some(port) = parse_mitmdump_cmdline(cmdline) {
            mitmdumps.push((*pid, port));
        }
        if let Some(port) = parse_dnsmasq_cmdline(cmdline) {
            dnsmasqs.push(DnsmasqProcessInfo { pid: *pid, port });
        }
    }

    // Resolve run_id + base_dir + ppid from CWD for firecracker processes
    let mut fc_infos = Vec::with_capacity(firecrackers.len());
    for pid in firecrackers {
        let cwd_info = read_cwd(pid)
            .await
            .and_then(|cwd| parse_workspace_cwd(&cwd));
        let ppid = read_ppid(pid).await;
        let (run_id, base_dir) = match cwd_info {
            Some((id, bd)) => (id, Some(bd)),
            None => (format!("pid-{pid}"), None),
        };
        fc_infos.push(FirecrackerProcessInfo {
            pid,
            ppid,
            run_id,
            base_dir,
        });
    }

    // Resolve ppid for mitmdump processes
    let mut mitm_infos = Vec::with_capacity(mitmdumps.len());
    for (pid, port) in mitmdumps {
        let ppid = read_ppid(pid).await;
        mitm_infos.push(MitmproxyProcessInfo { pid, ppid, port });
    }

    DiscoveredProcesses {
        runners,
        firecrackers: fc_infos,
        mitmdumps: mitm_infos,
        dnsmasqs,
    }
}

// ---------------------------------------------------------------------------
// Orphan detection
// ---------------------------------------------------------------------------

/// Walk the ppid chain from `pid` upward to determine if it's an orphan.
///
/// Firecracker is not a direct child of the runner — the spawn chain is
/// `runner → sudo → ip netns exec → sudo -u → firecracker`, so checking
/// only the immediate ppid is insufficient. This function walks up the
/// process tree until it either finds a runner PID (not orphan) or reaches
/// PID 1 / init (orphan).
///
/// Returns `false` (not orphan) when the ppid chain cannot be read, to
/// avoid false positives.
pub async fn is_orphan(pid: u32, runner_pids: &[u32]) -> bool {
    let mut current = pid;
    // Max depth prevents infinite loops from circular pid references.
    for _ in 0..16 {
        let Some(ppid) = read_ppid(current).await else {
            return false; // can't read → don't flag
        };
        if runner_pids.contains(&ppid) {
            return false;
        }
        if ppid <= 1 {
            return true; // reached init → orphaned
        }
        current = ppid;
    }
    false // max depth reached → don't flag
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- Runner parser tests --

    #[test]
    fn parse_runner_start_cmdline() {
        let cmdline = "/var/lib/vm0-runner/bin/runner start --config /data/runner-01/config.yaml";
        let (config, subcmd) = parse_runner_cmdline(cmdline).unwrap();
        assert_eq!(config, Path::new("/data/runner-01/config.yaml"));
        assert_eq!(subcmd, "start");
    }

    #[test]
    fn parse_runner_benchmark_cmdline() {
        let cmdline = "/usr/local/bin/runner benchmark --config /etc/runner/bench.yaml";
        let (config, subcmd) = parse_runner_cmdline(cmdline).unwrap();
        assert_eq!(config, Path::new("/etc/runner/bench.yaml"));
        assert_eq!(subcmd, "benchmark");
    }

    #[test]
    fn parse_runner_short_config_flag() {
        let cmdline = "runner start -c /data/runner.yaml";
        let (config, subcmd) = parse_runner_cmdline(cmdline).unwrap();
        assert_eq!(config, Path::new("/data/runner.yaml"));
        assert_eq!(subcmd, "start");
    }

    #[test]
    fn parse_runner_no_config_returns_none() {
        assert!(parse_runner_cmdline("runner start").is_none());
    }

    #[test]
    fn parse_runner_no_subcommand_returns_none() {
        assert!(parse_runner_cmdline("runner --config /data/config.yaml").is_none());
    }

    #[test]
    fn parse_runner_empty_cmdline() {
        assert!(parse_runner_cmdline("").is_none());
    }

    // -- Firecracker identification tests --

    #[test]
    fn is_firecracker_bare_name() {
        assert!(is_firecracker_cmdline(
            "firecracker --api-sock /run/vm0/sock/abc/api.sock"
        ));
    }

    #[test]
    fn is_firecracker_full_path() {
        assert!(is_firecracker_cmdline(
            "/var/lib/vm0-runner/firecracker/v1.10.1/firecracker --no-api"
        ));
    }

    #[test]
    fn is_firecracker_not_runner() {
        assert!(!is_firecracker_cmdline(
            "runner start --config /data/config.yaml"
        ));
    }

    #[test]
    fn is_firecracker_empty() {
        assert!(!is_firecracker_cmdline(""));
    }

    // -- Mitmdump parser tests --

    #[test]
    fn parse_mitmdump_listen_port() {
        let cmdline = "mitmdump --mode transparent --listen-port 8080 --set vm0_proxy_registry_path=/data/runner-01/proxy-registry.json";
        assert_eq!(parse_mitmdump_cmdline(cmdline), Some(8080));
    }

    #[test]
    fn parse_mitmdump_no_registry_returns_none() {
        assert!(parse_mitmdump_cmdline("mitmdump --mode transparent --listen-port 8080").is_none());
    }

    #[test]
    fn parse_mitmdump_no_listen_port_returns_none() {
        let cmdline = "mitmdump --set vm0_proxy_registry_path=/data/proxy-registry.json";
        assert!(parse_mitmdump_cmdline(cmdline).is_none());
    }

    // -- Dnsmasq parser tests --

    #[test]
    fn parse_dnsmasq_port() {
        let cmdline = "dnsmasq --no-daemon --no-resolv --port 5353 --server 8.8.8.8";
        assert_eq!(parse_dnsmasq_cmdline(cmdline), Some(5353));
    }

    #[test]
    fn parse_dnsmasq_not_dnsmasq_returns_none() {
        assert!(parse_dnsmasq_cmdline("mitmdump --port 5353").is_none());
    }

    #[test]
    fn parse_dnsmasq_no_port_returns_none() {
        assert!(parse_dnsmasq_cmdline("dnsmasq --no-daemon").is_none());
    }

    // -- CWD workspace parsing --

    #[test]
    fn parse_workspace_cwd_valid() {
        let cwd = Path::new("/data/runner-01/workspaces/550e8400");
        let (run_id, base_dir) = parse_workspace_cwd(cwd).unwrap();
        assert_eq!(run_id, "550e8400");
        assert_eq!(base_dir, Path::new("/data/runner-01"));
    }

    #[test]
    fn parse_workspace_cwd_uuid() {
        let cwd = Path::new("/data/r1/workspaces/550e8400-e29b-41d4-a716-446655440000");
        let (run_id, base_dir) = parse_workspace_cwd(cwd).unwrap();
        assert_eq!(run_id, "550e8400-e29b-41d4-a716-446655440000");
        assert_eq!(base_dir, Path::new("/data/r1"));
    }

    #[test]
    fn parse_workspace_cwd_non_workspace() {
        assert!(parse_workspace_cwd(Path::new("/tmp/something")).is_none());
    }

    // -- PGID parsing --

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
