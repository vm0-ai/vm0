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
    pub run_id: String,
    pub base_dir: Option<PathBuf>,
}

/// Info extracted from a mitmdump process cmdline.
pub struct MitmproxyProcessInfo {
    pub pid: u32,
    pub base_dir: PathBuf,
}

// ---------------------------------------------------------------------------
// Parsed cmdline fragments (internal)
// ---------------------------------------------------------------------------

struct FirecrackerCmdline {
    run_id: String,
    base_dir: Option<PathBuf>,
}

// ---------------------------------------------------------------------------
// Pure parsers — unit-testable without a running system
// ---------------------------------------------------------------------------

/// Parse a runner cmdline for `start`/`benchmark` subcommand and `--config` path.
///
/// Returns `(config_path, subcommand)` or `None` if the cmdline doesn't match.
pub fn parse_runner_cmdline(cmdline: &str) -> Option<(PathBuf, String)> {
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

/// Parse a firecracker cmdline for run ID and optional base directory.
///
/// Handles two launch modes:
/// - Snapshot boot: `firecracker --api-sock /run/vm0/sock/{uuid}/api.sock`
/// - Fresh boot:    `firecracker --config-file {base_dir}/workspaces/{id}/config.json`
fn parse_firecracker_cmdline(cmdline: &str) -> Option<FirecrackerCmdline> {
    let tokens: Vec<&str> = cmdline.split_whitespace().collect();

    // Try --api-sock /run/vm0/sock/{uuid}/api.sock
    if let Some(pos) = tokens.iter().position(|&t| t == "--api-sock")
        && let Some(&sock_path) = tokens.get(pos + 1)
    {
        let path = Path::new(sock_path);
        if path.file_name().and_then(|n| n.to_str()) == Some("api.sock")
            && sock_path.starts_with("/run/vm0/sock/")
            && let Some(uuid) = path.parent().and_then(|p| p.file_name())
        {
            return Some(FirecrackerCmdline {
                run_id: uuid.to_string_lossy().into_owned(),
                base_dir: None,
            });
        }
    }

    // Try --config-file {base_dir}/workspaces/{id}/config.json
    if let Some(pos) = tokens.iter().position(|&t| t == "--config-file")
        && let Some(&config_path) = tokens.get(pos + 1)
    {
        let path = Path::new(config_path);
        if path.file_name().and_then(|n| n.to_str()) == Some("config.json") {
            let id_dir = path.parent()?;
            let workspaces_dir = id_dir.parent()?;
            if workspaces_dir.file_name().and_then(|n| n.to_str()) == Some("workspaces") {
                let base_dir = workspaces_dir.parent()?;
                let id = id_dir.file_name()?.to_string_lossy().into_owned();
                return Some(FirecrackerCmdline {
                    run_id: id,
                    base_dir: Some(base_dir.to_path_buf()),
                });
            }
        }
    }

    None
}

/// Parse a mitmdump cmdline for the runner base directory.
///
/// Looks for `vm0_proxy_registry_path={base_dir}/proxy-registry.json`.
pub fn parse_mitmdump_cmdline(cmdline: &str) -> Option<PathBuf> {
    let prefix = "vm0_proxy_registry_path=";
    let token = cmdline.split_whitespace().find(|t| t.starts_with(prefix))?;
    let registry_path = token.strip_prefix(prefix)?;
    let path = Path::new(registry_path);
    if path.file_name().and_then(|n| n.to_str()) == Some("proxy-registry.json") {
        Some(path.parent()?.to_path_buf())
    } else {
        None
    }
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

/// Read `/proc/{pid}/cwd` symlink to get the process working directory.
async fn read_cwd(pid: u32) -> Option<PathBuf> {
    let link = format!("/proc/{pid}/cwd");
    tokio::fs::read_link(&link).await.ok()
}

/// Scan `/proc` for all process cmdlines.
///
/// Returns `(pid, cmdline)` pairs for every readable process.
async fn scan_proc_cmdlines() -> Vec<(u32, String)> {
    let mut result = Vec::new();
    let mut entries = match tokio::fs::read_dir("/proc").await {
        Ok(e) => e,
        Err(_) => return result,
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
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

/// Extract base_dir from a firecracker workspace CWD.
///
/// CWD is `{base_dir}/workspaces/{id}/`, so base_dir is the grandparent
/// of the `workspaces` component.
fn base_dir_from_cwd(cwd: &Path) -> Option<PathBuf> {
    // cwd might be {base_dir}/workspaces/{id} (no trailing slash in readlink)
    let parent = cwd.parent()?;
    if parent.file_name().and_then(|n| n.to_str()) == Some("workspaces") {
        parent.parent().map(Path::to_path_buf)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Finders — scan /proc and return typed process info
// ---------------------------------------------------------------------------

/// Find all running `runner start` / `runner benchmark` processes.
pub async fn find_runners() -> Vec<RunnerProcessInfo> {
    scan_proc_cmdlines()
        .await
        .into_iter()
        .filter_map(|(pid, cmdline)| {
            let (config_path, subcommand) = parse_runner_cmdline(&cmdline)?;
            Some(RunnerProcessInfo {
                pid,
                config_path,
                subcommand,
            })
        })
        .collect()
}

/// Find all running firecracker processes.
pub async fn find_firecrackers() -> Vec<FirecrackerProcessInfo> {
    let procs = scan_proc_cmdlines().await;
    let mut result = Vec::new();
    for (pid, cmdline) in procs {
        if let Some(fc) = parse_firecracker_cmdline(&cmdline) {
            let base_dir = fc.base_dir;
            result.push(FirecrackerProcessInfo {
                pid,
                run_id: fc.run_id,
                base_dir,
            });
        }
    }
    result
}

/// Find all running mitmdump processes with vm0 proxy registry.
pub async fn find_mitmdumps() -> Vec<MitmproxyProcessInfo> {
    scan_proc_cmdlines()
        .await
        .into_iter()
        .filter_map(|(pid, cmdline)| {
            let base_dir = parse_mitmdump_cmdline(&cmdline)?;
            Some(MitmproxyProcessInfo { pid, base_dir })
        })
        .collect()
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
        let cmdline =
            "/home/ubuntu/.vm0-runner/bin/runner start --config /data/runner-01/config.yaml";
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

    // -- Firecracker parser tests --

    #[test]
    fn parse_firecracker_api_sock() {
        let cmdline =
            "firecracker --api-sock /run/vm0/sock/550e8400-e29b-41d4-a716-446655440000/api.sock";
        let fc = parse_firecracker_cmdline(cmdline).unwrap();
        assert_eq!(fc.run_id, "550e8400-e29b-41d4-a716-446655440000");
        assert!(fc.base_dir.is_none());
    }

    #[test]
    fn parse_firecracker_config_file() {
        let cmdline =
            "firecracker --config-file /data/runner-01/workspaces/550e8400/config.json --no-api";
        let fc = parse_firecracker_cmdline(cmdline).unwrap();
        assert_eq!(fc.run_id, "550e8400");
        assert_eq!(fc.base_dir.unwrap(), Path::new("/data/runner-01"));
    }

    #[test]
    fn parse_firecracker_full_path_binary() {
        let cmdline = "/home/ubuntu/.vm0-runner/firecracker/v1.10.1/firecracker --api-sock /run/vm0/sock/abcd1234/api.sock";
        let fc = parse_firecracker_cmdline(cmdline).unwrap();
        assert_eq!(fc.run_id, "abcd1234");
    }

    #[test]
    fn parse_firecracker_no_match_returns_none() {
        assert!(parse_firecracker_cmdline("firecracker --help").is_none());
    }

    #[test]
    fn parse_firecracker_wrong_sock_path_returns_none() {
        let cmdline = "firecracker --api-sock /tmp/some-other/api.sock";
        assert!(parse_firecracker_cmdline(cmdline).is_none());
    }

    // -- Mitmdump parser tests --

    #[test]
    fn parse_mitmdump_registry_path() {
        let cmdline = "mitmdump --mode transparent --set vm0_proxy_registry_path=/data/runner-01/proxy-registry.json --scripts /data/runner-01/mitm-addon.py";
        let base_dir = parse_mitmdump_cmdline(cmdline).unwrap();
        assert_eq!(base_dir, Path::new("/data/runner-01"));
    }

    #[test]
    fn parse_mitmdump_no_registry_returns_none() {
        assert!(parse_mitmdump_cmdline("mitmdump --mode transparent").is_none());
    }

    #[test]
    fn parse_mitmdump_wrong_filename_returns_none() {
        let cmdline = "mitmdump --set vm0_proxy_registry_path=/data/other-file.json";
        assert!(parse_mitmdump_cmdline(cmdline).is_none());
    }

    // -- CWD base_dir extraction --

    #[test]
    fn base_dir_from_workspace_cwd() {
        let cwd = Path::new("/data/runner-01/workspaces/550e8400");
        assert_eq!(
            base_dir_from_cwd(cwd),
            Some(PathBuf::from("/data/runner-01"))
        );
    }

    #[test]
    fn base_dir_from_non_workspace_cwd() {
        let cwd = Path::new("/tmp/something");
        assert!(base_dir_from_cwd(cwd).is_none());
    }
}
