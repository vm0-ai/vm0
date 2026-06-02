use std::path::PathBuf;

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
