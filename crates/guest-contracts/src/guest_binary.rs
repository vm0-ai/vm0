//! Canonical executable destinations for binaries delivered in the guest rootfs.
//!
//! The runner's `guest-binaries.json` inventory remains authoritative for
//! delivery metadata. Its integration test requires every inventory entry to
//! match these paths so runner and guest runtime consumers stay in lockstep.

/// Production path of the Guest Agent executable.
pub const AGENT_PATH: &str = "/usr/local/bin/guest-agent";

/// Production path of the guest storage-download executable.
pub const DOWNLOAD_PATH: &str = "/usr/local/bin/guest-download";

/// Production path of the guest init executable.
pub const INIT_PATH: &str = "/sbin/guest-init";

/// Production path of the guest state-reseed executable.
pub const RESEED_PATH: &str = "/sbin/guest-reseed";

/// Production path of the privileged guest file-writer executable.
pub const WRITE_FILE_PATH: &str = "/sbin/guest-write-file";

/// Production path of the managed guest tool executor.
pub const TOOL_EXEC_PATH: &str = "/usr/local/bin/guest-tool-exec";

/// Production path of the shipped Claude mock executable.
pub const MOCK_CLAUDE_PATH: &str = "/usr/local/bin/guest-mock-claude";

/// Production path of the shipped Codex mock executable.
pub const MOCK_CODEX_PATH: &str = "/usr/local/bin/guest-mock-codex";
