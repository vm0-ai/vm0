use std::path::{Path, PathBuf};

use super::procfs::{read_cwd, read_ppid, scan_proc_cmdlines};
use super::types::{
    DiscoveredProcesses, DnsmasqProcessInfo, FirecrackerProcessInfo, MitmproxyProcessInfo,
    RunnerProcessInfo,
};

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

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| (*s).to_string()).collect()
    }

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
}
