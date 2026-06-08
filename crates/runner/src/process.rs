//! Host process discovery via `/proc` scanning.
//!
//! Shared by runner commands that need live host process facts, including
//! `doctor`, `kill`, `gc`, and orphan reaping.

mod ancestry;
mod discovery;
mod procfs;
mod types;

pub use self::ancestry::{is_orphan, process_has_ancestor};
pub use self::discovery::{discover_all, firecracker_process_exists_for_sandbox_id};
pub(crate) use self::discovery::{is_firecracker_cmdline, parse_workspace_cwd};
pub use self::procfs::read_service_unit;
pub(crate) use self::procfs::{read_cmdline, read_cwd, read_process_stat};
pub(crate) use self::types::process_stat_is_live;
pub use self::types::{
    DiscoveredProcesses, DnsmasqProcessInfo, FirecrackerProcessIdentity, FirecrackerProcessInfo,
    MitmproxyProcessInfo, ProcessStat, RunnerProcessInfo,
};
