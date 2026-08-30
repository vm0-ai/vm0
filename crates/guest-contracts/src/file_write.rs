//! Shared guest file-write timing budgets.

use std::time::Duration;

use crate::exec_terminal::EXEC_OUTPUT_DRAIN_DEADLINE;

/// Maximum time the guest waits for its file-write helper process.
pub const WRITE_FILE_HELPER_TIMEOUT_MS: u32 = 30_000;

// Duration form of `WRITE_FILE_HELPER_TIMEOUT_MS` for budget composition.
const WRITE_FILE_HELPER_TIMEOUT: Duration = Duration::from_secs(30);

/// Maximum time the guest spends writing one terminal protocol frame.
///
/// File-write results share the connection writer with every other guest
/// response, so this remains a connection-wide frame deadline.
pub const GUEST_FRAME_WRITE_DEADLINE: Duration = Duration::from_secs(10);

// Host-side allowance for request-frame construction, transmission, guest
// dispatch, and scheduling beyond the guest's configured processing budgets.
const WRITE_FILE_TRANSPORT_HEADROOM: Duration = Duration::from_secs(15);

/// End-to-end host deadline for one file-write request frame and its terminal
/// response.
pub const WRITE_FILE_REQUEST_DEADLINE: Duration = Duration::from_secs(60);

const WRITE_FILE_CONFIGURED_GUEST_BUDGET: Duration = WRITE_FILE_HELPER_TIMEOUT
    .saturating_add(EXEC_OUTPUT_DRAIN_DEADLINE)
    .saturating_add(GUEST_FRAME_WRITE_DEADLINE);

const _: () = assert!(
    WRITE_FILE_HELPER_TIMEOUT.as_millis() == WRITE_FILE_HELPER_TIMEOUT_MS as u128,
    "file-write helper duration and millisecond arguments must stay aligned"
);

const _: () = assert!(
    WRITE_FILE_REQUEST_DEADLINE.as_nanos()
        == WRITE_FILE_CONFIGURED_GUEST_BUDGET
            .saturating_add(WRITE_FILE_TRANSPORT_HEADROOM)
            .as_nanos(),
    "file-write request deadline must cover guest work plus transport headroom"
);
