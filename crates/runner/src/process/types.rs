use std::path::PathBuf;

/// Process facts read from `/proc/{pid}/stat`.
///
/// Only `pgid` and `starttime` are used as stable process identity; `ppid`
/// is the parent relationship observed at read time.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessStat {
    pub state: char,
    pub ppid: u32,
    pub pgid: u32,
    pub starttime: u64,
}

/// Return true when the process stat state still represents a live process.
///
/// `/proc/<pid>/stat` can briefly expose terminal states before the proc entry
/// disappears. Treat those as already exited so callers do not resolve or
/// signal a stale process identity.
pub(crate) fn process_stat_is_live(stat: &ProcessStat) -> bool {
    !matches!(stat.state, 'Z' | 'X' | 'x')
}

/// Firecracker process identity captured during discovery.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FirecrackerProcessIdentity {
    pub pid: u32,
    pub pgid: u32,
    pub starttime: u64,
    pub sandbox_id: String,
    pub base_dir: Option<PathBuf>,
}

/// Info extracted from a firecracker process cmdline.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FirecrackerProcessInfo {
    pub pid: u32,
    pub ppid: Option<u32>,
    /// The sandbox identity, derived from the workspace dir basename
    /// (`/proc/{pid}/cwd` = `{base_dir}/workspaces/{sandbox_id}/`). After
    /// sandbox reuse this is stable across successive run_ids.
    pub sandbox_id: String,
    pub base_dir: Option<PathBuf>,
    pub identity: Option<FirecrackerProcessIdentity>,
}

impl FirecrackerProcessInfo {
    pub(crate) fn workspace_identity_incomplete(&self) -> bool {
        self.base_dir.is_none()
    }
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
    pub firecrackers: Vec<FirecrackerProcessInfo>,
    pub mitmdumps: Vec<MitmproxyProcessInfo>,
    pub dnsmasqs: Vec<DnsmasqProcessInfo>,
}

/// Process discovery plus whether the top-level `/proc` scan completed.
pub struct ProcessDiscovery {
    pub processes: DiscoveredProcesses,
    pub proc_scan_complete: bool,
}
