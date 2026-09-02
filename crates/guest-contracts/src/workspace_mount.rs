//! Fixed workspace-drive mount contract shared by Runner and guest ownership.

use std::time::Duration;

use crate::exec_terminal::EXEC_OUTPUT_DRAIN_DEADLINE;
use crate::file_write::GUEST_FRAME_WRITE_DEADLINE;

/// Fixed shell helper used by the typed fresh mount and idle reuse preparation.
pub const WORKSPACE_MOUNT_SCRIPT: &str = include_str!("../scripts/mount-workspace-drive.sh");

/// Maximum time the guest waits for the fixed workspace-mount helper process.
pub const WORKSPACE_DRIVE_MOUNT_TIMEOUT_MS: u32 = 30_000;

const WORKSPACE_DRIVE_MOUNT_HELPER_TIMEOUT: Duration = Duration::from_secs(30);
const WORKSPACE_DRIVE_MOUNT_TRANSPORT_HEADROOM: Duration = Duration::from_secs(5);

/// End-to-end host deadline for one workspace-drive mount request and result.
pub const WORKSPACE_DRIVE_MOUNT_REQUEST_DEADLINE: Duration = WORKSPACE_DRIVE_MOUNT_HELPER_TIMEOUT
    .saturating_add(EXEC_OUTPUT_DRAIN_DEADLINE)
    .saturating_add(GUEST_FRAME_WRITE_DEADLINE)
    .saturating_add(WORKSPACE_DRIVE_MOUNT_TRANSPORT_HEADROOM);

const _: () = assert!(
    WORKSPACE_DRIVE_MOUNT_HELPER_TIMEOUT.as_millis() == WORKSPACE_DRIVE_MOUNT_TIMEOUT_MS as u128,
    "workspace-mount helper duration and millisecond arguments must stay aligned"
);

const _: () = assert!(
    WORKSPACE_DRIVE_MOUNT_REQUEST_DEADLINE.as_secs() == 50,
    "workspace-mount request deadline changed; review the complete guest lifecycle budget"
);
