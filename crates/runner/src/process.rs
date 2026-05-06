//! Process discovery via `/proc` scanning and status.json helpers.
//!
//! Shared between `doctor`, `kill`, and `exec` commands. All cmdline
//! parsers are pure functions testable without a running system.

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
    /// The sandbox identity, derived from the workspace dir basename
    /// (`/proc/{pid}/cwd` = `{base_dir}/workspaces/{sandbox_id}/`). After
    /// sandbox reuse this is stable across successive run_ids.
    pub sandbox_id: String,
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

/// Parse a runner argv for `start`/`benchmark` subcommand and `--config` path.
///
/// Returns `(config_path, subcommand)` or `None` if the argv doesn't match.
fn parse_runner_cmdline(argv: &[String]) -> Option<(PathBuf, String)> {
    let subcmd = argv
        .iter()
        .find(|t| *t == "start" || *t == "benchmark")?
        .clone();

    let config_pos = argv.iter().position(|t| t == "--config" || t == "-c")?;
    let config_path = argv.get(config_pos + 1)?;

    Some((PathBuf::from(config_path), subcmd))
}

/// Check if an argv belongs to a firecracker process.
///
/// Looks at the binary name (`argv[0]`) — the run ID and base directory
/// are resolved from `/proc/{pid}/cwd` instead of argument parsing,
/// since our sandbox always sets `current_dir` to the workspace.
fn is_firecracker_cmdline(argv: &[String]) -> bool {
    let Some(binary) = argv.first() else {
        return false;
    };
    Path::new(binary).file_name().and_then(|n| n.to_str()) == Some("firecracker")
}

/// Parse a mitmdump argv for the listen port.
///
/// Identifies our mitmdump by `vm0_proxy_registry_path=` and extracts
/// the `--listen-port` value.
fn parse_mitmdump_cmdline(argv: &[String]) -> Option<u16> {
    if !argv
        .iter()
        .any(|t| t.starts_with("vm0_proxy_registry_path="))
    {
        return None;
    }
    let pos = argv.iter().position(|t| t == "--listen-port")?;
    argv.get(pos + 1)?.parse().ok()
}

/// Parse a dnsmasq argv for the listen port.
///
/// Identifies dnsmasq by binary name and extracts the `--port` value.
fn parse_dnsmasq_cmdline(argv: &[String]) -> Option<u16> {
    let binary = argv.first()?;
    if !binary.ends_with("dnsmasq") {
        return None;
    }
    let pos = argv.iter().position(|t| t == "--port")?;
    argv.get(pos + 1)?.parse().ok()
}

// ---------------------------------------------------------------------------
// /proc helpers
// ---------------------------------------------------------------------------

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

/// Scan `/proc` for all process argvs.
///
/// Returns `(pid, argv)` pairs for every readable process.
async fn scan_proc_cmdlines() -> Vec<(u32, Vec<String>)> {
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

/// Extract sandbox_id and base_dir from a firecracker workspace CWD.
///
/// CWD is `{base_dir}/workspaces/{sandbox_id}/`, so:
/// - `sandbox_id` is the last component
/// - `base_dir` is the grandparent of `workspaces`
fn parse_workspace_cwd(cwd: &Path) -> Option<(String, PathBuf)> {
    let sandbox_id = cwd.file_name()?.to_string_lossy().into_owned();
    let workspaces_dir = cwd.parent()?;
    if workspaces_dir.file_name().and_then(|n| n.to_str()) == Some("workspaces") {
        let base_dir = workspaces_dir.parent()?.to_path_buf();
        Some((sandbox_id, base_dir))
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

    for (pid, argv) in &procs {
        if let Some((config_path, subcommand)) = parse_runner_cmdline(argv) {
            runners.push(RunnerProcessInfo {
                pid: *pid,
                config_path,
                subcommand,
            });
        }
        if is_firecracker_cmdline(argv) {
            firecrackers.push(*pid);
        }
        if let Some(port) = parse_mitmdump_cmdline(argv) {
            mitmdumps.push((*pid, port));
        }
        if let Some(port) = parse_dnsmasq_cmdline(argv) {
            dnsmasqs.push(DnsmasqProcessInfo { pid: *pid, port });
        }
    }

    // Resolve sandbox_id + base_dir + ppid from CWD for firecracker processes
    let mut fc_infos = Vec::with_capacity(firecrackers.len());
    for pid in firecrackers {
        let cwd_info = read_cwd(pid)
            .await
            .and_then(|cwd| parse_workspace_cwd(&cwd));
        let ppid = read_ppid(pid).await;
        let (sandbox_id, base_dir) = match cwd_info {
            Some((id, bd)) => (id, Some(bd)),
            None => (format!("pid-{pid}"), None),
        };
        fc_infos.push(FirecrackerProcessInfo {
            pid,
            ppid,
            sandbox_id,
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

/// Return true when the discovered Firecracker list contains `sandbox_id`.
pub fn firecracker_process_exists_for_sandbox_id(
    firecrackers: &[FirecrackerProcessInfo],
    sandbox_id: &str,
) -> bool {
    firecrackers
        .iter()
        .any(|process| process.sandbox_id == sandbox_id)
}

const PPID_CHAIN_MAX_DEPTH: usize = 16;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PpidChainWalk {
    FoundTarget,
    ReachedBoundary,
    Unreadable,
    MaxDepth,
}

async fn walk_ppid_chain<F, Fut>(
    pid: u32,
    target_pids: &[u32],
    mut read_parent_pid: F,
) -> PpidChainWalk
where
    F: FnMut(u32) -> Fut,
    Fut: std::future::Future<Output = Option<u32>>,
{
    let mut current = pid;
    for _ in 0..PPID_CHAIN_MAX_DEPTH {
        let Some(ppid) = read_parent_pid(current).await else {
            return PpidChainWalk::Unreadable;
        };
        if target_pids.contains(&ppid) {
            return PpidChainWalk::FoundTarget;
        }
        if ppid <= 1 {
            return PpidChainWalk::ReachedBoundary;
        }
        current = ppid;
    }
    PpidChainWalk::MaxDepth
}

fn process_has_ancestor_from_walk(walk: PpidChainWalk) -> Option<bool> {
    match walk {
        PpidChainWalk::FoundTarget => Some(true),
        PpidChainWalk::ReachedBoundary | PpidChainWalk::MaxDepth => Some(false),
        PpidChainWalk::Unreadable => None,
    }
}

/// Walk the ppid chain from `pid` upward to determine whether it descends from
/// one of `ancestor_pids`.
///
/// Returns `None` when the chain cannot be read, so callers can choose whether
/// to treat an unreadable process tree as conservative or absent.
pub async fn process_has_ancestor(pid: u32, ancestor_pids: &[u32]) -> Option<bool> {
    process_has_ancestor_from_walk(walk_ppid_chain(pid, ancestor_pids, read_ppid).await)
}

// ---------------------------------------------------------------------------
// Orphan detection
// ---------------------------------------------------------------------------

fn is_orphan_from_walk(walk: PpidChainWalk) -> bool {
    match walk {
        PpidChainWalk::FoundTarget | PpidChainWalk::Unreadable | PpidChainWalk::MaxDepth => false,
        PpidChainWalk::ReachedBoundary => true,
    }
}

/// Walk the ppid chain from `pid` upward to determine if it's an orphan.
///
/// Firecracker is not a direct child of the runner — the spawn chain is
/// `runner → sudo → ip netns exec → sudo -u → firecracker`, so checking
/// only the immediate ppid is insufficient. This function walks up the
/// process tree until it either finds a runner PID (not orphan) or reaches
/// PID 1 / init or the PPid 0 boundary (orphan).
///
/// Returns `false` (not orphan) when the ppid chain cannot be read, to
/// avoid false positives.
pub async fn is_orphan(pid: u32, runner_pids: &[u32]) -> bool {
    is_orphan_from_walk(walk_ppid_chain(pid, runner_pids, read_ppid).await)
}

// ---------------------------------------------------------------------------
// status.json helpers (shared by kill, exec, and potentially others)
// ---------------------------------------------------------------------------

/// Load only the `base_dir` field from a runner config YAML (best-effort).
///
/// Read / parse failures log at `warn` level and return `None` so a single
/// broken runner config doesn't stop resolution for the rest.
pub(crate) async fn load_base_dir(config_path: &Path) -> Option<PathBuf> {
    #[derive(serde::Deserialize)]
    struct ConfigShape {
        base_dir: PathBuf,
    }
    let content = match tokio::fs::read_to_string(config_path).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(path = %config_path.display(), error = %e, "skipping runner: cannot read config");
            return None;
        }
    };
    let shape: ConfigShape = match serde_yaml_ng::from_str(&content) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(path = %config_path.display(), error = %e, "skipping runner: cannot parse config");
            return None;
        }
    };
    if shape.base_dir.is_absolute() {
        Some(shape.base_dir)
    } else {
        config_path.parent().map(|p| p.join(&shape.base_dir))
    }
}

/// Read `{base_dir}/status.json` and extract `(run_id, sandbox_id)` for
/// every active run. Returns `None` if the file is missing or unparseable
/// (logs at `warn` level so the operator sees the miss immediately).
pub(crate) async fn read_active_runs(base_dir: &Path) -> Option<Vec<(String, String)>> {
    #[derive(serde::Deserialize)]
    struct StatusShape {
        #[serde(default)]
        active_runs: Vec<ActiveRunShape>,
    }
    #[derive(serde::Deserialize)]
    struct ActiveRunShape {
        run_id: String,
        sandbox_id: String,
    }
    let path = base_dir.join("status.json");
    let content = match tokio::fs::read_to_string(&path).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "skipping runner: cannot read status.json");
            return None;
        }
    };
    let shape: StatusShape = match serde_json::from_str(&content) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "skipping runner: cannot parse status.json");
            return None;
        }
    };
    Some(
        shape
            .active_runs
            .into_iter()
            .map(|r| (r.run_id, r.sandbox_id))
            .collect(),
    )
}

/// Result of collecting `(run_id, sandbox_id)` pairs from runners.
pub(crate) struct ActiveRunMappings {
    pub entries: Vec<(String, String)>,
    /// How many runners were discovered on the host.
    pub runners_total: usize,
    /// How many runners had unreadable configs or status files.
    pub runners_failed: usize,
}

/// Collect all `(run_id, sandbox_id)` pairs from every reachable runner's
/// `status.json`. Used by `kill --run` and `exec --run` to translate a
/// user-supplied run_id into the sandbox_id that identifies the FC.
pub(crate) async fn collect_active_run_mappings(
    runners: &[RunnerProcessInfo],
) -> ActiveRunMappings {
    let mut entries = Vec::new();
    let mut failed = 0usize;
    for runner in runners {
        let Some(base_dir) = load_base_dir(&runner.config_path).await else {
            failed += 1;
            continue;
        };
        match read_active_runs(&base_dir).await {
            Some(runs) => entries.extend(runs),
            None => failed += 1,
        }
    }
    ActiveRunMappings {
        entries,
        runners_total: runners.len(),
        runners_failed: failed,
    }
}

/// Given a `run_id` prefix, find the unique matching `sandbox_id` from
/// collected status entries.
///
/// Returns the `sandbox_id` on unique match. Errors on empty or ambiguous.
/// When no match is found and some runners were unreadable, the error
/// message includes a diagnostic hint so the operator knows why.
pub(crate) fn resolve_run_to_sandbox(
    input: &str,
    mappings: &ActiveRunMappings,
) -> crate::error::RunnerResult<String> {
    use crate::error::RunnerError;

    if input.is_empty() {
        return Err(RunnerError::Config("run id must not be empty".into()));
    }

    let mut matching: Vec<&(String, String)> = mappings
        .entries
        .iter()
        .filter(|(rid, _)| rid.starts_with(input))
        .collect();
    matching.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    matching.dedup();

    match matching.as_slice() {
        [(_, sandbox_id)] => Ok(sandbox_id.clone()),
        [] => {
            let mut msg = format!("no active run matches '{input}'");
            if mappings.runners_failed > 0 {
                msg.push_str(&format!(
                    " ({} of {} runner(s) had unreadable config/status — \
                     check warnings above)",
                    mappings.runners_failed, mappings.runners_total,
                ));
            } else if mappings.runners_total == 0 {
                msg.push_str(" (no runner processes found on this host)");
            }
            Err(RunnerError::Config(msg))
        }
        _ => {
            let lines: Vec<String> = matching
                .iter()
                .map(|(rid, sid)| format!("run={rid} sandbox={sid}"))
                .collect();
            Err(RunnerError::Config(format!(
                "ambiguous run prefix '{input}', matches: [{}]",
                lines.join(", ")
            )))
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| (*s).to_string()).collect()
    }

    // -- Runner parser tests --

    #[test]
    fn parse_runner_start_cmdline() {
        let a = argv(&[
            "/var/lib/vm0-runner/bin/runner",
            "start",
            "--config",
            "/data/runner-01/config.yaml",
        ]);
        let (config, subcmd) = parse_runner_cmdline(&a).unwrap();
        assert_eq!(config, Path::new("/data/runner-01/config.yaml"));
        assert_eq!(subcmd, "start");
    }

    #[test]
    fn parse_runner_benchmark_cmdline() {
        let a = argv(&[
            "/usr/local/bin/runner",
            "benchmark",
            "--config",
            "/etc/runner/bench.yaml",
        ]);
        let (config, subcmd) = parse_runner_cmdline(&a).unwrap();
        assert_eq!(config, Path::new("/etc/runner/bench.yaml"));
        assert_eq!(subcmd, "benchmark");
    }

    #[test]
    fn parse_runner_short_config_flag() {
        let a = argv(&["runner", "start", "-c", "/data/runner.yaml"]);
        let (config, subcmd) = parse_runner_cmdline(&a).unwrap();
        assert_eq!(config, Path::new("/data/runner.yaml"));
        assert_eq!(subcmd, "start");
    }

    #[test]
    fn parse_runner_config_path_with_spaces() {
        // Regression for #10479: a path argument containing spaces must stay
        // as a single argv element, not be split into multiple tokens.
        let a = argv(&["runner", "start", "--config", "/data/my config/config.yaml"]);
        let (config, subcmd) = parse_runner_cmdline(&a).unwrap();
        assert_eq!(config, Path::new("/data/my config/config.yaml"));
        assert_eq!(subcmd, "start");
    }

    #[test]
    fn parse_runner_no_config_returns_none() {
        assert!(parse_runner_cmdline(&argv(&["runner", "start"])).is_none());
    }

    #[test]
    fn parse_runner_no_subcommand_returns_none() {
        assert!(
            parse_runner_cmdline(&argv(&["runner", "--config", "/data/config.yaml"])).is_none()
        );
    }

    #[test]
    fn parse_runner_empty_cmdline() {
        assert!(parse_runner_cmdline(&[]).is_none());
    }

    // -- Firecracker identification tests --

    #[test]
    fn is_firecracker_bare_name() {
        assert!(is_firecracker_cmdline(&argv(&[
            "firecracker",
            "--api-sock",
            "/run/vm0/sock/abc/api.sock",
        ])));
    }

    #[test]
    fn is_firecracker_full_path() {
        assert!(is_firecracker_cmdline(&argv(&[
            "/var/lib/vm0-runner/firecracker/v1.10.1/firecracker",
            "--no-api",
        ])));
    }

    #[test]
    fn is_firecracker_not_runner() {
        assert!(!is_firecracker_cmdline(&argv(&[
            "runner",
            "start",
            "--config",
            "/data/config.yaml",
        ])));
    }

    #[test]
    fn is_firecracker_empty() {
        assert!(!is_firecracker_cmdline(&[]));
    }

    #[test]
    fn firecracker_process_exists_for_sandbox_id_matches_exact_id() {
        let processes = vec![FirecrackerProcessInfo {
            pid: 42,
            ppid: Some(1),
            sandbox_id: "sandbox-a".to_string(),
            base_dir: None,
        }];

        assert!(firecracker_process_exists_for_sandbox_id(
            &processes,
            "sandbox-a"
        ));
        assert!(!firecracker_process_exists_for_sandbox_id(
            &processes, "sandbox"
        ));
    }

    // -- PPid chain walking --

    async fn walk_test_ppid_chain(
        pid: u32,
        target_pids: &[u32],
        ppid_chain: &[(u32, Option<u32>)],
    ) -> PpidChainWalk {
        walk_ppid_chain(pid, target_pids, |current| {
            std::future::ready(
                ppid_chain
                    .iter()
                    .find(|(candidate, _)| *candidate == current)
                    .and_then(|(_, ppid)| *ppid),
            )
        })
        .await
    }

    #[tokio::test]
    async fn ppid_chain_empty_targets_reaches_init() {
        let walk = walk_test_ppid_chain(10, &[], &[(10, Some(9)), (9, Some(1))]).await;

        assert_eq!(walk, PpidChainWalk::ReachedBoundary);
        assert_eq!(process_has_ancestor_from_walk(walk), Some(false));
        assert!(is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_empty_targets_unreadable_first_hop() {
        let walk = walk_test_ppid_chain(10, &[], &[]).await;

        assert_eq!(walk, PpidChainWalk::Unreadable);
        assert_eq!(process_has_ancestor_from_walk(walk), None);
        assert!(!is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_finds_immediate_target() {
        let walk = walk_test_ppid_chain(10, &[9], &[(10, Some(9))]).await;

        assert_eq!(walk, PpidChainWalk::FoundTarget);
        assert_eq!(process_has_ancestor_from_walk(walk), Some(true));
        assert!(!is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_finds_multi_hop_target() {
        let walk =
            walk_test_ppid_chain(10, &[7], &[(10, Some(9)), (9, Some(8)), (8, Some(7))]).await;

        assert_eq!(walk, PpidChainWalk::FoundTarget);
        assert_eq!(process_has_ancestor_from_walk(walk), Some(true));
        assert!(!is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_finds_target_at_max_depth_boundary() {
        let chain = [
            (100, Some(101)),
            (101, Some(102)),
            (102, Some(103)),
            (103, Some(104)),
            (104, Some(105)),
            (105, Some(106)),
            (106, Some(107)),
            (107, Some(108)),
            (108, Some(109)),
            (109, Some(110)),
            (110, Some(111)),
            (111, Some(112)),
            (112, Some(113)),
            (113, Some(114)),
            (114, Some(115)),
            (115, Some(116)),
        ];
        let walk = walk_test_ppid_chain(100, &[116], &chain).await;

        assert_eq!(walk, PpidChainWalk::FoundTarget);
        assert_eq!(process_has_ancestor_from_walk(walk), Some(true));
        assert!(!is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_reaches_pid_one_boundary() {
        let walk = walk_test_ppid_chain(10, &[99], &[(10, Some(9)), (9, Some(1))]).await;

        assert_eq!(walk, PpidChainWalk::ReachedBoundary);
        assert_eq!(process_has_ancestor_from_walk(walk), Some(false));
        assert!(is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_reaches_pid_zero_boundary() {
        let walk = walk_test_ppid_chain(10, &[99], &[(10, Some(9)), (9, Some(0))]).await;

        assert_eq!(walk, PpidChainWalk::ReachedBoundary);
        assert_eq!(process_has_ancestor_from_walk(walk), Some(false));
        assert!(is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_unreadable_mid_chain() {
        let walk = walk_test_ppid_chain(10, &[99], &[(10, Some(9))]).await;

        assert_eq!(walk, PpidChainWalk::Unreadable);
        assert_eq!(process_has_ancestor_from_walk(walk), None);
        assert!(!is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_circular_reference_hits_max_depth() {
        let walk = walk_test_ppid_chain(10, &[99], &[(10, Some(11)), (11, Some(10))]).await;

        assert_eq!(walk, PpidChainWalk::MaxDepth);
        assert_eq!(process_has_ancestor_from_walk(walk), Some(false));
        assert!(!is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_target_after_max_depth_is_false_negative() {
        let chain = [
            (100, Some(101)),
            (101, Some(102)),
            (102, Some(103)),
            (103, Some(104)),
            (104, Some(105)),
            (105, Some(106)),
            (106, Some(107)),
            (107, Some(108)),
            (108, Some(109)),
            (109, Some(110)),
            (110, Some(111)),
            (111, Some(112)),
            (112, Some(113)),
            (113, Some(114)),
            (114, Some(115)),
            (115, Some(116)),
            (116, Some(117)),
        ];
        let walk = walk_test_ppid_chain(100, &[117], &chain).await;

        assert_eq!(walk, PpidChainWalk::MaxDepth);
        assert_eq!(process_has_ancestor_from_walk(walk), Some(false));
        assert!(!is_orphan_from_walk(walk));
    }

    #[tokio::test]
    async fn ppid_chain_target_match_precedes_boundary_check() {
        let pid_one_walk = walk_test_ppid_chain(10, &[1], &[(10, Some(1))]).await;
        let pid_zero_walk = walk_test_ppid_chain(20, &[0], &[(20, Some(0))]).await;

        assert_eq!(pid_one_walk, PpidChainWalk::FoundTarget);
        assert_eq!(pid_zero_walk, PpidChainWalk::FoundTarget);
        assert_eq!(process_has_ancestor_from_walk(pid_one_walk), Some(true));
        assert_eq!(process_has_ancestor_from_walk(pid_zero_walk), Some(true));
        assert!(!is_orphan_from_walk(pid_one_walk));
        assert!(!is_orphan_from_walk(pid_zero_walk));
    }

    // -- Mitmdump parser tests --

    #[test]
    fn parse_mitmdump_listen_port() {
        let a = argv(&[
            "mitmdump",
            "--mode",
            "transparent",
            "--listen-port",
            "8080",
            "--set",
            "vm0_proxy_registry_path=/data/runner-01/proxy-registry.json",
        ]);
        assert_eq!(parse_mitmdump_cmdline(&a), Some(8080));
    }

    #[test]
    fn parse_mitmdump_registry_path_with_spaces() {
        // Regression for #10479.
        let a = argv(&[
            "mitmdump",
            "--listen-port",
            "8080",
            "--set",
            "vm0_proxy_registry_path=/data/my runner/proxy-registry.json",
        ]);
        assert_eq!(parse_mitmdump_cmdline(&a), Some(8080));
    }

    #[test]
    fn parse_mitmdump_no_registry_returns_none() {
        let a = argv(&["mitmdump", "--mode", "transparent", "--listen-port", "8080"]);
        assert!(parse_mitmdump_cmdline(&a).is_none());
    }

    #[test]
    fn parse_mitmdump_no_listen_port_returns_none() {
        let a = argv(&[
            "mitmdump",
            "--set",
            "vm0_proxy_registry_path=/data/proxy-registry.json",
        ]);
        assert!(parse_mitmdump_cmdline(&a).is_none());
    }

    // -- Dnsmasq parser tests --

    #[test]
    fn parse_dnsmasq_port() {
        let a = argv(&[
            "dnsmasq",
            "--no-daemon",
            "--no-resolv",
            "--port",
            "5353",
            "--server",
            "8.8.8.8",
        ]);
        assert_eq!(parse_dnsmasq_cmdline(&a), Some(5353));
    }

    #[test]
    fn parse_dnsmasq_not_dnsmasq_returns_none() {
        assert!(parse_dnsmasq_cmdline(&argv(&["mitmdump", "--port", "5353"])).is_none());
    }

    #[test]
    fn parse_dnsmasq_no_port_returns_none() {
        assert!(parse_dnsmasq_cmdline(&argv(&["dnsmasq", "--no-daemon"])).is_none());
    }

    // -- CWD workspace parsing --

    #[test]
    fn parse_workspace_cwd_valid() {
        let cwd = Path::new("/data/runner-01/workspaces/550e8400");
        let (sandbox_id, base_dir) = parse_workspace_cwd(cwd).unwrap();
        assert_eq!(sandbox_id, "550e8400");
        assert_eq!(base_dir, Path::new("/data/runner-01"));
    }

    #[test]
    fn parse_workspace_cwd_uuid() {
        let cwd = Path::new("/data/r1/workspaces/550e8400-e29b-41d4-a716-446655440000");
        let (sandbox_id, base_dir) = parse_workspace_cwd(cwd).unwrap();
        assert_eq!(sandbox_id, "550e8400-e29b-41d4-a716-446655440000");
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

    // -- load_base_dir / read_active_runs / resolve_run_to_sandbox ----------

    #[tokio::test]
    async fn load_base_dir_absolute() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("runner.yaml");
        std::fs::write(&config, "base_dir: /data/runner-01\nname: test\n").unwrap();
        let bd = load_base_dir(&config).await.unwrap();
        assert_eq!(bd, Path::new("/data/runner-01"));
    }

    #[tokio::test]
    async fn load_base_dir_relative() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("runner.yaml");
        std::fs::write(&config, "base_dir: ./data\nname: test\n").unwrap();
        let bd = load_base_dir(&config).await.unwrap();
        assert_eq!(bd, dir.path().join("./data"));
    }

    #[tokio::test]
    async fn load_base_dir_missing_file() {
        let result = load_base_dir(Path::new("/no/such/config.yaml")).await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn load_base_dir_malformed_yaml() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("runner.yaml");
        std::fs::write(&config, "not: valid: yaml: [[[").unwrap();
        assert!(load_base_dir(&config).await.is_none());
    }

    #[tokio::test]
    async fn read_active_runs_normal() {
        let dir = tempfile::tempdir().unwrap();
        let status = r#"{
            "mode": "running",
            "active_runs": [
                {"run_id": "R1", "sandbox_id": "S1"},
                {"run_id": "R2", "sandbox_id": "S2"}
            ],
            "started_at": "2026-01-01T00:00:00.000Z"
        }"#;
        std::fs::write(dir.path().join("status.json"), status).unwrap();
        let runs = read_active_runs(dir.path()).await.unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0], ("R1".into(), "S1".into()));
    }

    #[tokio::test]
    async fn read_active_runs_missing_field_defaults_empty() {
        let dir = tempfile::tempdir().unwrap();
        // status.json without active_runs field — serde(default) kicks in
        std::fs::write(dir.path().join("status.json"), r#"{"mode":"running"}"#).unwrap();
        let runs = read_active_runs(dir.path()).await.unwrap();
        assert!(runs.is_empty());
    }

    #[tokio::test]
    async fn read_active_runs_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_active_runs(dir.path()).await.is_none());
    }

    #[tokio::test]
    async fn read_active_runs_malformed_json() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("status.json"), "not json").unwrap();
        assert!(read_active_runs(dir.path()).await.is_none());
    }
}
