use std::io;
use std::sync::atomic::{AtomicBool, Ordering};

use vsock_proto::{self, MSG_SHUTDOWN_ACK};

use crate::error::to_io_error;
use crate::log::log;

/// Flag indicating shutdown was received (don't reconnect after shutdown).
///
/// Process-level static: safe because integration tests use `handle_connection` per-thread
/// (not `run()`), and each test gets its own connection. Only `run()` reads this flag.
static SHUTDOWN_RECEIVED: AtomicBool = AtomicBool::new(false);

pub(crate) fn shutdown_received() -> bool {
    SHUTDOWN_RECEIVED.load(Ordering::SeqCst)
}

/// Handle shutdown message — acknowledge and suppress reconnection.
///
/// The guest rootfs is ext4 on an ephemeral COW device that is destroyed
/// when the VM is killed, so there is nothing to sync. The primary purpose
/// of this handler is to set `SHUTDOWN_RECEIVED` so the reconnection loop
/// in `run()` exits cleanly instead of retrying (which it would otherwise
/// do, since reconnection is the normal path after snapshot restore).
pub(crate) fn handle_shutdown(seq: u32) -> io::Result<Vec<u8>> {
    log("INFO", "Shutdown requested");
    SHUTDOWN_RECEIVED.store(true, Ordering::SeqCst);
    vsock_proto::encode(MSG_SHUTDOWN_ACK, seq, &[]).map_err(to_io_error)
}
