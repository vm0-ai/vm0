//! Fixed workspace-drive mount contract shared by Runner and guest ownership.

/// Fixed shell helper used by the typed fresh mount and idle reuse preparation.
pub const WORKSPACE_MOUNT_SCRIPT: &str = include_str!("../scripts/mount-workspace-drive.sh");
