use std::io::Read;
use std::path::Path;

use tracing::{info, warn};

/// Read a file sequentially to populate the host page cache.
///
/// Firecracker mmaps `memory.bin` on snapshot restore; without the file in
/// page cache, guest memory accesses trigger host-side demand paging.
/// This performs blocking I/O — callers should use `spawn_blocking`.
pub fn prefetch_memory(path: &Path) {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            warn!(error = %e, path = %path.display(), "memory prefetch: open failed");
            return;
        }
    };
    let mut buf = vec![0u8; 1024 * 1024];
    let mut total: u64 = 0;
    loop {
        match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => total += n as u64,
            Err(e) => {
                warn!(error = %e, bytes = total, "memory prefetch: read failed");
                return;
            }
        }
    }
    info!(bytes = total, path = %path.display(), "memory prefetch complete");
}
