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
pub use self::procfs::{read_pgid, read_service_unit};
pub use self::types::{
    DiscoveredProcesses, DnsmasqProcessInfo, FirecrackerProcessInfo, MitmproxyProcessInfo,
    RunnerProcessInfo,
};
