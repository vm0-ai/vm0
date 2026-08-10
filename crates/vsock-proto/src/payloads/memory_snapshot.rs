use crate::ProtocolError;

const COUNTER_SIZE: usize = size_of::<u64>();
const COUNTER_COUNT: usize = 18;

/// Exact encoded size of a [`MemorySnapshot`] response payload.
pub const MEMORY_SNAPSHOT_PAYLOAD_SIZE: usize = COUNTER_COUNT * COUNTER_SIZE;

/// Aggregate guest memory counters captured at a quiesced lifecycle boundary.
///
/// Every field is encoded as an unsigned byte count in declaration order using
/// a fixed-width big-endian `u64`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MemorySnapshot {
    /// Total memory visible to the guest.
    pub mem_total_bytes: u64,
    /// Completely unused memory.
    pub mem_free_bytes: u64,
    /// Estimated memory available for starting new applications.
    pub mem_available_bytes: u64,
    /// Block-device buffer memory.
    pub buffers_bytes: u64,
    /// Filesystem page-cache memory.
    pub cached_bytes: u64,
    /// Anonymous userspace pages.
    pub anon_pages_bytes: u64,
    /// File-backed pages mapped into processes.
    pub mapped_bytes: u64,
    /// Dirty pages waiting to be written.
    pub dirty_bytes: u64,
    /// Pages actively being written back.
    pub writeback_bytes: u64,
    /// Shared-memory pages.
    pub shmem_bytes: u64,
    /// Total kernel slab memory.
    pub slab_bytes: u64,
    /// Reclaimable kernel slab memory.
    pub slab_reclaimable_bytes: u64,
    /// Unreclaimable kernel slab memory.
    pub slab_unreclaimable_bytes: u64,
    /// Memory that cannot be reclaimed or swapped.
    pub unevictable_bytes: u64,
    /// Kernel stack memory.
    pub kernel_stack_bytes: u64,
    /// Page-table memory.
    pub page_tables_bytes: u64,
    /// Total configured swap.
    pub swap_total_bytes: u64,
    /// Unused configured swap.
    pub swap_free_bytes: u64,
}

impl MemorySnapshot {
    /// Encode the fixed-width memory-snapshot response payload.
    pub fn encode_payload(self) -> [u8; MEMORY_SNAPSHOT_PAYLOAD_SIZE] {
        let counters = [
            self.mem_total_bytes,
            self.mem_free_bytes,
            self.mem_available_bytes,
            self.buffers_bytes,
            self.cached_bytes,
            self.anon_pages_bytes,
            self.mapped_bytes,
            self.dirty_bytes,
            self.writeback_bytes,
            self.shmem_bytes,
            self.slab_bytes,
            self.slab_reclaimable_bytes,
            self.slab_unreclaimable_bytes,
            self.unevictable_bytes,
            self.kernel_stack_bytes,
            self.page_tables_bytes,
            self.swap_total_bytes,
            self.swap_free_bytes,
        ];
        let mut payload = [0; MEMORY_SNAPSHOT_PAYLOAD_SIZE];
        for (chunk, counter) in payload.chunks_exact_mut(COUNTER_SIZE).zip(counters) {
            chunk.copy_from_slice(&counter.to_be_bytes());
        }
        payload
    }
}

/// Decode an exact-width memory-snapshot response payload.
pub fn decode_memory_snapshot(payload: &[u8]) -> Result<MemorySnapshot, ProtocolError> {
    if payload.len() != MEMORY_SNAPSHOT_PAYLOAD_SIZE {
        return Err(ProtocolError::InvalidPayload(
            "memory snapshot payload must be exactly 144 bytes",
        ));
    }
    let mut counters = [0_u64; COUNTER_COUNT];
    for (counter, chunk) in counters.iter_mut().zip(payload.chunks_exact(COUNTER_SIZE)) {
        let bytes: [u8; COUNTER_SIZE] = chunk.try_into().map_err(|_| {
            ProtocolError::InvalidPayload("memory snapshot counter has invalid width")
        })?;
        *counter = u64::from_be_bytes(bytes);
    }
    Ok(MemorySnapshot {
        mem_total_bytes: counters[0],
        mem_free_bytes: counters[1],
        mem_available_bytes: counters[2],
        buffers_bytes: counters[3],
        cached_bytes: counters[4],
        anon_pages_bytes: counters[5],
        mapped_bytes: counters[6],
        dirty_bytes: counters[7],
        writeback_bytes: counters[8],
        shmem_bytes: counters[9],
        slab_bytes: counters[10],
        slab_reclaimable_bytes: counters[11],
        slab_unreclaimable_bytes: counters[12],
        unevictable_bytes: counters[13],
        kernel_stack_bytes: counters[14],
        page_tables_bytes: counters[15],
        swap_total_bytes: counters[16],
        swap_free_bytes: counters[17],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> MemorySnapshot {
        MemorySnapshot {
            mem_total_bytes: 1,
            mem_free_bytes: 2,
            mem_available_bytes: 3,
            buffers_bytes: 4,
            cached_bytes: 5,
            anon_pages_bytes: 6,
            mapped_bytes: 7,
            dirty_bytes: 8,
            writeback_bytes: 9,
            shmem_bytes: 10,
            slab_bytes: 11,
            slab_reclaimable_bytes: 12,
            slab_unreclaimable_bytes: 13,
            unevictable_bytes: 14,
            kernel_stack_bytes: 15,
            page_tables_bytes: 16,
            swap_total_bytes: 17,
            swap_free_bytes: 18,
        }
    }

    #[test]
    fn memory_snapshot_roundtrips_fixed_big_endian_payload() {
        let snapshot = snapshot();
        let payload = snapshot.encode_payload();

        assert_eq!(payload.len(), 144);
        assert_eq!(&payload[..8], &1_u64.to_be_bytes());
        assert_eq!(&payload[136..], &18_u64.to_be_bytes());
        assert_eq!(decode_memory_snapshot(&payload).unwrap(), snapshot);
    }

    #[test]
    fn memory_snapshot_rejects_truncated_and_trailing_payloads() {
        let payload = snapshot().encode_payload();
        for malformed in [payload[..143].to_vec(), [&payload[..], &[0]].concat()] {
            let error = decode_memory_snapshot(&malformed).unwrap_err();
            assert_eq!(
                error.to_string(),
                "invalid payload: memory snapshot payload must be exactly 144 bytes"
            );
        }
    }
}
