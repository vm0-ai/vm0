use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// Identity of a Firecracker VM sandbox — the workspace directory basename
/// and socket directory name. Survives sandbox reuse: the first job creates
/// the sandbox with this ID, and subsequent reuse jobs inherit it.
///
/// Distinct from `RunId` (a per-job server identifier defined in the
/// `runner` crate). The two are equal on the first run but diverge on
/// sandbox reuse.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SandboxId(uuid::Uuid);

impl SandboxId {
    pub fn new_v4() -> Self {
        Self(uuid::Uuid::new_v4())
    }

    /// Extract the inner `Uuid` for interop with APIs that require a raw
    /// UUID (snapshot hashing, format strings, etc.).
    pub fn as_uuid(self) -> uuid::Uuid {
        self.0
    }
}

impl fmt::Display for SandboxId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl FromStr for SandboxId {
    type Err = uuid::Error;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        uuid::Uuid::parse_str(s).map(Self)
    }
}

impl From<uuid::Uuid> for SandboxId {
    fn from(u: uuid::Uuid) -> Self {
        Self(u)
    }
}

pub struct ResourceLimits {
    pub cpu_count: u32,
    pub memory_mb: u32,
}

pub struct SandboxConfig {
    pub id: SandboxId,
    pub resources: ResourceLimits,
}

/// Reference to a pre-built snapshot for fast VM boot.
/// The backend resolves individual artifact paths from the output directory.
pub struct SnapshotRef {
    /// Directory containing snapshot artifacts (snapshot.bin, memory.bin, cow.img).
    pub output_dir: PathBuf,
    /// Content hash of the snapshot, used as an identifier for path derivation.
    pub hash: String,
}

/// Configuration for creating a sandbox factory for a specific profile.
pub struct FactoryConfig {
    /// Profile name (e.g., "vm0/default").
    pub profile: String,
    /// Path to the sandbox backend binary (e.g., firecracker).
    pub binary_path: PathBuf,
    /// Path to the guest kernel image.
    pub kernel_path: PathBuf,
    /// Path to the root filesystem image.
    pub rootfs_path: PathBuf,
    /// Base directory for runtime data (workspaces, COW devices, etc.).
    pub base_dir: PathBuf,
    /// Snapshot to restore from. When set, VMs boot via snapshot restore.
    pub snapshot: Option<SnapshotRef>,
}

/// Runtime-wide configuration used to initialize shared backend resources.
///
/// These values are discovered before a runtime is created and apply to every
/// factory produced by that runtime. Per-profile and per-sandbox settings
/// belong in [`FactoryConfig`] and [`SandboxConfig`].
pub struct RuntimeConfig {
    /// Proxy port for network traffic interception. Shared across all factories.
    pub proxy_port: Option<u16>,
    /// DNS proxy port for DNS query interception. Shared across all factories.
    pub dns_port: Option<u16>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_id_serde_transparent_roundtrip() {
        let id = SandboxId::new_v4();
        let json = serde_json::to_string(&id).unwrap();
        assert!(json.starts_with('"'), "expected bare UUID string: {json}");
        let parsed: SandboxId = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, id);
    }

    #[test]
    fn sandbox_id_as_uuid_roundtrip() {
        let id = SandboxId::new_v4();
        let uuid = id.as_uuid();
        let back = SandboxId::from(uuid);
        assert_eq!(back, id);
    }

    #[test]
    fn sandbox_id_from_str() {
        let id = SandboxId::new_v4();
        let parsed: SandboxId = id.to_string().parse().unwrap();
        assert_eq!(parsed, id);
    }
}
