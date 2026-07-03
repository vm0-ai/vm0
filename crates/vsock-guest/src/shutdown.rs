use std::io;

use vsock_proto::{self, MSG_SHUTDOWN_ACK};

use crate::error::to_io_error;
use crate::log::log;

/// Handle shutdown message by building the acknowledgement payload.
///
/// The guest rootfs is ext4 on an ephemeral COW device that is destroyed
/// when the VM is killed, so there is nothing to sync. The connection loop
/// treats this response as terminal: after attempting to write the ACK, it
/// exits cleanly instead of reconnecting.
pub(crate) fn handle_shutdown(seq: u32) -> io::Result<Vec<u8>> {
    log("INFO", "Shutdown requested");
    vsock_proto::encode(MSG_SHUTDOWN_ACK, seq, &[]).map_err(to_io_error)
}
