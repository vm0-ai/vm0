use vsock_proto::{MEMORY_SNAPSHOT_PAYLOAD_SIZE, MemorySnapshot, decode_memory_snapshot};

const EXPECTED_SNAPSHOT: MemorySnapshot = MemorySnapshot {
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
};

const GOLDEN_PAYLOAD: [u8; MEMORY_SNAPSHOT_PAYLOAD_SIZE] = [
    0, 0, 0, 0, 0, 0, 0, 1, // mem_total_bytes
    0, 0, 0, 0, 0, 0, 0, 2, // mem_free_bytes
    0, 0, 0, 0, 0, 0, 0, 3, // mem_available_bytes
    0, 0, 0, 0, 0, 0, 0, 4, // buffers_bytes
    0, 0, 0, 0, 0, 0, 0, 5, // cached_bytes
    0, 0, 0, 0, 0, 0, 0, 6, // anon_pages_bytes
    0, 0, 0, 0, 0, 0, 0, 7, // mapped_bytes
    0, 0, 0, 0, 0, 0, 0, 8, // dirty_bytes
    0, 0, 0, 0, 0, 0, 0, 9, // writeback_bytes
    0, 0, 0, 0, 0, 0, 0, 10, // shmem_bytes
    0, 0, 0, 0, 0, 0, 0, 11, // slab_bytes
    0, 0, 0, 0, 0, 0, 0, 12, // slab_reclaimable_bytes
    0, 0, 0, 0, 0, 0, 0, 13, // slab_unreclaimable_bytes
    0, 0, 0, 0, 0, 0, 0, 14, // unevictable_bytes
    0, 0, 0, 0, 0, 0, 0, 15, // kernel_stack_bytes
    0, 0, 0, 0, 0, 0, 0, 16, // page_tables_bytes
    0, 0, 0, 0, 0, 0, 0, 17, // swap_total_bytes
    0, 0, 0, 0, 0, 0, 0, 18, // swap_free_bytes
];

#[test]
fn memory_snapshot_encoding_pins_every_wire_offset() {
    assert_eq!(EXPECTED_SNAPSHOT.encode_payload(), GOLDEN_PAYLOAD);
}

#[test]
fn memory_snapshot_decoding_pins_every_named_field() {
    assert_eq!(
        decode_memory_snapshot(&GOLDEN_PAYLOAD).unwrap(),
        EXPECTED_SNAPSHOT
    );
}

#[test]
fn memory_snapshot_rejects_truncated_and_trailing_payloads() {
    for malformed in [
        GOLDEN_PAYLOAD[..MEMORY_SNAPSHOT_PAYLOAD_SIZE - 1].to_vec(),
        [&GOLDEN_PAYLOAD[..], &[0]].concat(),
    ] {
        let error = decode_memory_snapshot(&malformed).unwrap_err();
        assert_eq!(
            error.to_string(),
            "invalid payload: memory snapshot payload must be exactly 144 bytes"
        );
    }
}
