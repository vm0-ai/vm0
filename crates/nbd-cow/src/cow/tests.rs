use super::*;
use std::ffi::OsString;
use std::io::Write as IoWrite;
use std::os::unix::ffi::OsStringExt;
use std::path::PathBuf;
use tempfile::NamedTempFile;

fn write_bitmap_file(path: &Path, blocks: u64, word: u64) {
    let mut data = blocks.to_le_bytes().to_vec();
    data.extend_from_slice(&word.to_le_bytes());
    std::fs::write(path, data).unwrap();
}

fn create_base_image(data: &[u8]) -> NamedTempFile {
    let mut f = NamedTempFile::new().unwrap();
    f.write_all(data).unwrap();
    f.flush().unwrap();
    f
}

fn make_cow(
    base: &NamedTempFile,
    cow_file: &NamedTempFile,
    size: u64,
    flush_threshold: usize,
) -> CowLayer {
    CowLayer::new(base.path(), cow_file.path(), size, 4096, flush_threshold).unwrap()
}

fn assert_invalid_input(result: Result<CowLayer>) {
    let err = match result {
        Ok(_) => panic!("expected invalid input error"),
        Err(err) => err,
    };
    assert!(
        matches!(&err, NbdCowError::Io(e) if e.kind() == std::io::ErrorKind::InvalidInput),
        "expected invalid input error, got {err:?}"
    );
}

#[test]
fn constructor_rejects_zero_block_size() {
    let base = create_base_image(&vec![0x00; 4096]);
    let cow_file = NamedTempFile::new().unwrap();

    let result = CowLayer::new(base.path(), cow_file.path(), 4096, 0, 1024 * 1024);

    assert_invalid_input(result);
}

#[test]
fn constructor_rejects_zero_size() {
    let base = create_base_image(&[]);
    let cow_file = NamedTempFile::new().unwrap();

    let result = CowLayer::new(base.path(), cow_file.path(), 0, 4096, 1024 * 1024);

    assert_invalid_input(result);
}

#[test]
fn constructor_rejects_non_block_aligned_size() {
    let base = create_base_image(&vec![0x00; 4097]);
    let cow_file = NamedTempFile::new().unwrap();

    let result = CowLayer::new(base.path(), cow_file.path(), 4097, 4096, 1024 * 1024);

    assert_invalid_input(result);
}

#[test]
fn read_from_base_when_no_writes() {
    let base = create_base_image(&vec![0xAA; 8192]);
    let cow_file = NamedTempFile::new().unwrap();
    let cow = make_cow(&base, &cow_file, 8192, 1024 * 1024);

    let mut buf = vec![0u8; 4096];
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xAA));

    cow.read(4096, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xAA));
}

#[test]
fn write_then_read_returns_written_data() {
    let base = create_base_image(&vec![0x00; 8192]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 8192, 1024 * 1024);

    cow.write(0, &vec![0xBB; 4096]).unwrap();

    let mut buf = vec![0u8; 4096];
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xBB));

    // Second block still reads from base
    cow.read(4096, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0x00));
}

#[test]
fn partial_block_write() {
    let base = create_base_image(&vec![0xAA; 4096]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 4096, 1024 * 1024);

    cow.write(100, &[0xFF; 10]).unwrap();

    let mut buf = vec![0u8; 4096];
    cow.read(0, &mut buf).unwrap();
    assert!(buf[..100].iter().all(|&b| b == 0xAA));
    assert!(buf[100..110].iter().all(|&b| b == 0xFF));
    assert!(buf[110..].iter().all(|&b| b == 0xAA));
}

#[test]
fn flush_writes_to_cow_file() {
    let base = create_base_image(&vec![0x00; 8192]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 8192, 1024 * 1024);

    cow.write(0, &vec![0xCC; 4096]).unwrap();
    assert_eq!(cow.buffered_block_count(), 1);

    cow.flush().unwrap();
    assert_eq!(cow.buffered_block_count(), 0);
    assert_eq!(cow.dirty_block_count(), 1);

    // Data should still be readable (now from COW file)
    let mut buf = vec![0u8; 4096];
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xCC));
}

#[test]
fn buffer_threshold_triggers_flush_signal() {
    let base = create_base_image(&vec![0x00; 8192]);
    let cow_file = NamedTempFile::new().unwrap();
    // Threshold: 1 block (4096 bytes)
    let mut cow = make_cow(&base, &cow_file, 8192, 4096);

    let needs_flush = cow.write(0, &vec![0xDD; 4096]).unwrap();
    assert!(needs_flush, "should signal flush when threshold reached");
}

#[test]
fn out_of_bounds_error() {
    let base = create_base_image(&vec![0x00; 4096]);
    let cow_file = NamedTempFile::new().unwrap();
    let cow = make_cow(&base, &cow_file, 4096, 1024 * 1024);

    let mut buf = vec![0u8; 4096];
    let err = cow.read(4096, &mut buf);
    assert!(err.is_err());
}

#[test]
fn full_block_write_over_dirty_block_replaces_existing_contents() {
    let base = create_base_image(&vec![0x11; 4096]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 4096, 1024 * 1024);

    cow.write(0, &vec![0xAA; 4096]).unwrap();
    cow.flush().unwrap();
    assert_eq!(cow.dirty_block_count(), 1);

    cow.write(0, &vec![0xBB; 4096]).unwrap();

    let mut buf = vec![0u8; 4096];
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xBB));

    cow.flush().unwrap();
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xBB));
}

#[test]
fn full_block_write_does_not_read_base_block() {
    let base = create_base_image(&[]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 4096, 1024 * 1024);

    cow.write(0, &vec![0xCC; 4096]).unwrap();

    let mut buf = vec![0u8; 4096];
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xCC));
}

#[test]
fn write_after_flush_overwrites_dirty_block() {
    let base = create_base_image(&vec![0x00; 4096]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 4096, 1024 * 1024);

    // Write and flush
    cow.write(0, &vec![0xAA; 4096]).unwrap();
    cow.flush().unwrap();
    assert_eq!(cow.dirty_block_count(), 1);

    // Overwrite the same block (now in COW file, not buffer)
    cow.write(0, &vec![0xBB; 4096]).unwrap();
    assert_eq!(cow.buffered_block_count(), 1);

    // Read should return the latest write (from buffer)
    let mut buf = vec![0u8; 4096];
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xBB));

    // Flush again and read — should still be 0xBB
    cow.flush().unwrap();
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xBB));
}

#[test]
fn zero_length_read_write() {
    let base = create_base_image(&vec![0xAA; 4096]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 4096, 1024 * 1024);

    // Zero-length read and write should succeed as no-ops
    cow.read(0, &mut []).unwrap();
    cow.write(0, &[]).unwrap();
    assert_eq!(cow.buffered_block_count(), 0);

    // Also at end of device
    cow.read(4096, &mut []).unwrap();
    cow.write(4096, &[]).unwrap();
}

#[test]
fn sync_without_writes() {
    let base = create_base_image(&vec![0x00; 4096]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 4096, 1024 * 1024);

    // Sync with no writes should be a no-op (no COW file created)
    cow.sync().unwrap();
    assert_eq!(cow.dirty_block_count(), 0);
    assert_eq!(cow.buffered_block_count(), 0);
}

#[test]
fn cross_block_read_write() {
    let base = create_base_image(&vec![0xAA; 8192]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 8192, 1024 * 1024);

    cow.write(4090, &[0xEE; 100]).unwrap();

    let mut buf = vec![0u8; 100];
    cow.read(4090, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xEE));
    assert_eq!(cow.buffered_block_count(), 2);
}

#[test]
fn cross_block_write_preserves_partial_edges_around_full_middle_block() {
    let mut base_data = vec![0x10; 4096];
    base_data.extend_from_slice(&vec![0x20; 4096]);
    base_data.extend_from_slice(&vec![0x30; 4096]);
    let base = create_base_image(&base_data);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 3 * 4096, 1024 * 1024);

    let first_partial_len = 128;
    let middle_full_len = 4096;
    let last_partial_len = 256;
    let offset = 4096 - first_partial_len;
    let write_data = vec![0xEE; first_partial_len + middle_full_len + last_partial_len];

    cow.write(offset as u64, &write_data).unwrap();

    let mut first_block = vec![0u8; 4096];
    cow.read(0, &mut first_block).unwrap();
    assert!(first_block[..offset].iter().all(|&b| b == 0x10));
    assert!(first_block[offset..].iter().all(|&b| b == 0xEE));

    let mut middle_block = vec![0u8; 4096];
    cow.read(4096, &mut middle_block).unwrap();
    assert!(middle_block.iter().all(|&b| b == 0xEE));

    let mut last_block = vec![0u8; 4096];
    cow.read(8192, &mut last_block).unwrap();
    assert!(last_block[..last_partial_len].iter().all(|&b| b == 0xEE));
    assert!(last_block[last_partial_len..].iter().all(|&b| b == 0x30));

    assert_eq!(cow.buffered_block_count(), 3);
}

#[test]
fn bitmap_save_load_round_trip() {
    let base = create_base_image(&vec![0x00; 8192]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 8192, 1024 * 1024);

    // Write to block 0, flush to set dirty bit
    cow.write(0, &vec![0xAA; 4096]).unwrap();
    cow.flush().unwrap();
    assert_eq!(cow.dirty_block_count(), 1);

    // Save bitmap
    let bitmap_file = NamedTempFile::new().unwrap();
    cow.save_bitmap(bitmap_file.path()).unwrap();

    // Load bitmap and verify
    let loaded = bitmap::load_bitmap(bitmap_file.path(), 2).unwrap();
    assert_eq!(loaded.count_ones(), 1);
    assert!(loaded[0]); // block 0 is dirty
    assert!(!loaded[1]); // block 1 is clean
}

#[test]
fn bitmap_load_wrong_block_count_errors() {
    let base = create_base_image(&vec![0x00; 8192]);
    let cow_file = NamedTempFile::new().unwrap();
    let cow = make_cow(&base, &cow_file, 8192, 1024 * 1024);

    let bitmap_file = NamedTempFile::new().unwrap();
    cow.save_bitmap(bitmap_file.path()).unwrap();

    // Try to load with wrong block count
    let result = bitmap::load_bitmap(bitmap_file.path(), 999);
    assert!(result.is_err());
}

#[test]
fn bitmap_load_truncated_data_errors() {
    let bitmap_file = NamedTempFile::new().unwrap();

    // Write header claiming 128 blocks but no bitmap data
    let num_blocks: u64 = 128;
    std::fs::write(bitmap_file.path(), num_blocks.to_le_bytes()).unwrap();

    let result = bitmap::load_bitmap(bitmap_file.path(), 128);
    assert!(result.is_err());

    // Write header + partial data (less than needed)
    let mut data = num_blocks.to_le_bytes().to_vec();
    data.extend_from_slice(&[0u8; 4]); // only 4 bytes, need 128/64*8 = 16
    std::fs::write(bitmap_file.path(), &data).unwrap();

    let result = bitmap::load_bitmap(bitmap_file.path(), 128);
    assert!(result.is_err());
}

#[test]
fn bitmap_load_ignores_extra_tail_bytes() {
    let bitmap_file = NamedTempFile::new().unwrap();
    let mut data = 1u64.to_le_bytes().to_vec();
    data.extend_from_slice(&0u64.to_le_bytes());
    data.extend_from_slice(&[0xAA; 16]);
    std::fs::write(bitmap_file.path(), data).unwrap();

    let loaded = bitmap::load_bitmap(bitmap_file.path(), 1).unwrap();

    assert_eq!(loaded.count_ones(), 0);
}

#[test]
fn bitmap_cow_coverage_rejects_truncated_dirty_block() {
    let bitmap_file = NamedTempFile::new().unwrap();
    write_bitmap_file(bitmap_file.path(), 2, 0b10);

    let result = validate_bitmap_cow_coverage(bitmap_file.path(), 4096, 4096, 2);

    assert!(result.is_err());
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("dirty bitmap references COW data")
    );
}

#[test]
fn bitmap_cow_coverage_accepts_clean_bitmap_with_short_cow_file() {
    let bitmap_file = NamedTempFile::new().unwrap();
    write_bitmap_file(bitmap_file.path(), 2, 0);

    validate_bitmap_cow_coverage(bitmap_file.path(), 0, 4096, 2).unwrap();
}

#[test]
fn bitmap_cow_coverage_accepts_covering_cow_file() {
    let bitmap_file = NamedTempFile::new().unwrap();
    write_bitmap_file(bitmap_file.path(), 2, 0b10);

    validate_bitmap_cow_coverage(bitmap_file.path(), 8192, 4096, 2).unwrap();
}

#[test]
fn bitmap_save_rejects_path_without_parent() {
    let base = create_base_image(&vec![0x00; 4096]);
    let cow_file = NamedTempFile::new().unwrap();
    let cow = make_cow(&base, &cow_file, 4096, 1024 * 1024);

    // `/` has no parent. The function must reject it before touching the FS
    // so callers can't accidentally skip the parent-dir fsync durability
    // guarantee by passing a degenerate path.
    let err = cow.save_bitmap(Path::new("/")).unwrap_err();
    assert!(matches!(err, NbdCowError::Io(_)), "got {err:?}");
}

#[test]
fn bitmap_save_handles_non_utf8_parent_path() {
    let tmp = tempfile::tempdir().unwrap();
    let non_utf8_dir = tmp.path().join(PathBuf::from(OsString::from_vec(
        b"bitmap-parent-\xff".to_vec(),
    )));
    std::fs::create_dir(&non_utf8_dir).unwrap();
    let base_path = non_utf8_dir.join("base.img");
    std::fs::write(&base_path, vec![0; 4096]).unwrap();
    let cow_path = non_utf8_dir.join("cow.img");
    let cow = CowLayer::new(&base_path, &cow_path, 4096, 4096, 1024 * 1024).unwrap();
    let bitmap_path = bitmap_path_for(&cow_path);
    let tmp_path = bitmap::bitmap_tmp_path_for(&bitmap_path);

    cow.save_bitmap(&bitmap_path).unwrap();

    assert!(bitmap_path.exists());
    assert!(!tmp_path.exists());
    bitmap::load_bitmap(&bitmap_path, 1).unwrap();
}

#[test]
fn bitmap_save_replaces_stale_tmp_symlink_without_following() {
    let tmp = tempfile::tempdir().unwrap();
    let base_path = tmp.path().join("base.img");
    std::fs::write(&base_path, vec![0; 4096]).unwrap();
    let cow_path = tmp.path().join("cow.img");
    let cow = CowLayer::new(&base_path, &cow_path, 4096, 4096, 1024 * 1024).unwrap();
    let bitmap_path = bitmap_path_for(&cow_path);
    let tmp_path = bitmap::bitmap_tmp_path_for(&bitmap_path);
    let symlink_target = tmp.path().join("tmp-symlink-target");
    std::fs::write(&symlink_target, b"keep").unwrap();
    std::os::unix::fs::symlink(&symlink_target, &tmp_path).unwrap();

    cow.save_bitmap(&bitmap_path).unwrap();

    assert!(
        std::fs::symlink_metadata(&bitmap_path)
            .unwrap()
            .file_type()
            .is_file()
    );
    assert!(!tmp_path.exists());
    assert_eq!(std::fs::read(&symlink_target).unwrap(), b"keep");
    bitmap::load_bitmap(&bitmap_path, 1).unwrap();
}

#[test]
fn bitmap_empty_round_trip() {
    let base = create_base_image(&vec![0x00; 4096]);
    let cow_file = NamedTempFile::new().unwrap();
    let cow = make_cow(&base, &cow_file, 4096, 1024 * 1024);

    let bitmap_file = NamedTempFile::new().unwrap();
    cow.save_bitmap(bitmap_file.path()).unwrap();

    let loaded = bitmap::load_bitmap(bitmap_file.path(), 1).unwrap();
    assert_eq!(loaded.count_ones(), 0);
}

#[test]
fn create_with_existing_bitmap_restores_dirty_state() {
    let base_data = vec![0x00; 8192];
    let base = create_base_image(&base_data);
    let cow_file = NamedTempFile::new().unwrap();

    // Phase 1: write, flush, save bitmap
    {
        let mut cow = make_cow(&base, &cow_file, 8192, 1024 * 1024);
        cow.write(0, &vec![0xBB; 4096]).unwrap();
        cow.flush().unwrap();
        let bitmap_path = bitmap_path_for(cow_file.path());
        cow.save_bitmap(&bitmap_path).unwrap();
    }

    // Phase 2: create new CowLayer with same paths — bitmap auto-loaded
    let cow2 = CowLayer::new(base.path(), cow_file.path(), 8192, 4096, 1024 * 1024).unwrap();
    assert_eq!(
        cow2.dirty_block_count(),
        1,
        "dirty bitmap should be restored"
    );

    // Read block 0 — should come from COW file, not base
    let mut buf = vec![0u8; 4096];
    cow2.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xBB), "restored data should match");

    // Read block 1 — should come from base
    cow2.read(4096, &mut buf).unwrap();
    assert!(
        buf.iter().all(|&b| b == 0x00),
        "unmodified block should read from base"
    );

    // Cleanup bitmap file
    let _ = std::fs::remove_file(bitmap_path_for(cow_file.path()));
}

#[test]
fn create_without_bitmap_starts_fresh() {
    let base = create_base_image(&vec![0xAA; 4096]);
    let cow_file = NamedTempFile::new().unwrap();

    // No bitmap file exists — should start with empty dirty set
    let cow = CowLayer::new(base.path(), cow_file.path(), 4096, 4096, 1024 * 1024).unwrap();
    assert_eq!(cow.dirty_block_count(), 0);

    let mut buf = vec![0u8; 4096];
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xAA));
}

#[test]
fn create_with_broken_bitmap_symlink_errors() {
    let base = create_base_image(&vec![0xAA; 4096]);
    let tmp = tempfile::tempdir().unwrap();
    let cow_path = tmp.path().join("cow.img");
    let bitmap_path = bitmap_path_for(&cow_path);
    std::os::unix::fs::symlink(tmp.path().join("missing-bitmap"), &bitmap_path).unwrap();

    let err = match CowLayer::new(base.path(), &cow_path, 4096, 4096, 1024 * 1024) {
        Ok(_) => panic!("expected broken bitmap symlink to fail"),
        Err(err) => err,
    };

    assert!(
        matches!(&err, NbdCowError::Io(e) if e.kind() == std::io::ErrorKind::NotFound),
        "expected missing broken bitmap target error, got {err:?}"
    );
}

#[test]
fn create_with_dirty_bitmap_beyond_cow_file_errors() {
    let base = create_base_image(&vec![0xAA; 8192]);
    let cow_file = NamedTempFile::new().unwrap();
    write_bitmap_file(&bitmap_path_for(cow_file.path()), 2, 0b10);

    let err = match CowLayer::new(base.path(), cow_file.path(), 8192, 4096, 1024 * 1024) {
        Ok(_) => panic!("expected truncated COW file to fail"),
        Err(err) => err,
    };

    assert!(
        err.to_string().contains("dirty bitmap references COW data"),
        "expected dirty bitmap coverage error, got {err:?}"
    );
}

// ---------- flush_buffered recovery tests ----------
//
// flush_buffered is driven directly with a controllable writer closure.
// Real error injection (/dev/full, file seals, RLIMIT_FSIZE) cannot
// reproduce partial-success-then-fail at arbitrary index, which is the
// scenario the recovery logic protects against.

// Returns the two `NamedTempFile` handles alongside the `CowLayer` so the
// caller must bind them (as `_base`, `_cow_file`, etc.) to keep the backing
// files alive for the test's duration. Discarding them with `_` would drop
// the files mid-test and silently break reads.
fn seed_cow_with_writes(blocks: &[(u64, u8)]) -> (NamedTempFile, NamedTempFile, CowLayer) {
    // 8-block device = 32KB. All tests use at most 4 distinct blocks.
    let base = create_base_image(&vec![0x00; 8 * 4096]);
    let cow_file = NamedTempFile::new().unwrap();
    let mut cow = make_cow(&base, &cow_file, 8 * 4096, 1024 * 1024);
    for &(idx, fill) in blocks {
        cow.write(idx * 4096, &vec![fill; 4096]).unwrap();
    }
    (base, cow_file, cow)
}

#[test]
fn flush_buffered_success_path_drains_buffer() {
    let (_b, _c, mut cow) = seed_cow_with_writes(&[(0, 0xAA), (1, 0xBB), (5, 0xCC)]);

    let mut calls: Vec<(u64, u8)> = Vec::new();
    cow.flush_buffered(|offset, data| {
        calls.push((offset, data[0]));
        Ok(())
    })
    .unwrap();

    assert_eq!(cow.buffered_block_count(), 0);
    assert_eq!(cow.buffer_bytes(), 0);
    assert_eq!(cow.dirty_block_count(), 3);
    // BTreeMap iterates in key order: offsets ascend.
    assert_eq!(calls, vec![(0, 0xAA), (4096, 0xBB), (5 * 4096, 0xCC)]);
}

#[test]
fn flush_buffered_fails_on_first_block_preserves_everything() {
    let (_b, _c, mut cow) = seed_cow_with_writes(&[(0, 0xAA), (1, 0xBB), (5, 0xCC)]);

    let err = cow
        .flush_buffered(|_off, _data| Err(std::io::Error::from(std::io::ErrorKind::StorageFull)))
        .unwrap_err();
    assert!(matches!(err, NbdCowError::Io(_)));

    // No block written: buffer intact, no dirty bits set.
    assert_eq!(cow.buffered_block_count(), 3);
    assert_eq!(cow.buffer_bytes(), 3 * 4096);
    assert_eq!(cow.dirty_block_count(), 0);
    // Originals still readable from the buffer (no dirty bit ⇒ fallthrough to buffer).
    let mut buf = vec![0u8; 4096];
    cow.read(0, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xAA));
    cow.read(5 * 4096, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xCC));
}

#[test]
fn flush_buffered_fails_mid_drain_splits_state() {
    let (_b, _c, mut cow) = seed_cow_with_writes(&[(0, 0xA0), (1, 0xA1), (2, 0xA2), (3, 0xA3)]);

    let mut call_count = 0;
    let err = cow
        .flush_buffered(|_off, _data| {
            call_count += 1;
            if call_count <= 2 {
                Ok(())
            } else {
                // Fail on the 3rd call.
                Err(std::io::Error::from(std::io::ErrorKind::StorageFull))
            }
        })
        .unwrap_err();
    assert!(matches!(err, NbdCowError::Io(_)));

    // Written blocks [0,1] stay dirty, gone from buffer. Unwritten [2,3] restored.
    assert_eq!(cow.dirty_block_count(), 2);
    assert_eq!(cow.buffered_block_count(), 2);
    assert_eq!(cow.buffer_bytes(), 2 * 4096);
    // Buffer still holds the unwritten survivors' data.
    let mut buf = vec![0u8; 4096];
    cow.read(2 * 4096, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xA2));
    cow.read(3 * 4096, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xA3));
}

#[test]
fn flush_buffered_recovers_on_retry_after_mid_drain_failure() {
    let (_b, _c, mut cow) = seed_cow_with_writes(&[(0, 0xA0), (1, 0xA1), (2, 0xA2), (3, 0xA3)]);

    // Stage 1: mid-drain failure on the 3rd call.
    let mut call_count = 0;
    let _ = cow.flush_buffered(|_off, _data| {
        call_count += 1;
        if call_count <= 2 {
            Ok(())
        } else {
            Err(std::io::Error::from(std::io::ErrorKind::StorageFull))
        }
    });

    // Stage 2: retry with successful writer.
    let mut retry_calls = Vec::new();
    cow.flush_buffered(|offset, data| {
        retry_calls.push((offset, data[0]));
        Ok(())
    })
    .unwrap();

    assert_eq!(cow.buffered_block_count(), 0);
    assert_eq!(cow.buffer_bytes(), 0);
    assert_eq!(cow.dirty_block_count(), 4);
    // Retry drained exactly the two survivors.
    assert_eq!(retry_calls, vec![(2 * 4096, 0xA2), (3 * 4096, 0xA3)]);
}

#[test]
fn flush_buffered_fails_on_last_block_preserves_only_last() {
    let (_b, _c, mut cow) = seed_cow_with_writes(&[(0, 0xA0), (1, 0xA1), (2, 0xA2), (3, 0xA3)]);

    let mut call_count = 0;
    let err = cow
        .flush_buffered(|_off, _data| {
            call_count += 1;
            if call_count <= 3 {
                Ok(())
            } else {
                // Fail on the 4th call, which is the last block.
                Err(std::io::Error::from(std::io::ErrorKind::StorageFull))
            }
        })
        .unwrap_err();
    assert!(matches!(err, NbdCowError::Io(_)));

    // Guards the tail boundary: only block 3 should be restored; blocks
    // [0..=2] stay written.
    assert_eq!(cow.dirty_block_count(), 3);
    assert_eq!(cow.buffered_block_count(), 1);
    assert_eq!(cow.buffer_bytes(), 4096);

    let mut buf = vec![0u8; 4096];
    cow.read(3 * 4096, &mut buf).unwrap();
    assert!(buf.iter().all(|&b| b == 0xA3));
}

#[test]
fn flush_ensure_cow_fd_failure_preserves_buffer() {
    let base = create_base_image(&vec![0x00; 8 * 4096]);
    // Derive a path under a tempdir whose child subdir we never create —
    // ensure_cow_fd's File::open then fails ENOENT regardless of host FS state.
    let tmp = tempfile::tempdir().unwrap();
    let bad_cow_path = tmp.path().join("missing-subdir").join("cow.bin");
    let mut cow = CowLayer::new(base.path(), &bad_cow_path, 8 * 4096, 4096, 1024 * 1024).unwrap();

    cow.write(0, &vec![0xEE; 4096]).unwrap();
    cow.write(4096, &vec![0xDD; 4096]).unwrap();
    assert_eq!(cow.buffered_block_count(), 2);

    let err = cow.flush().unwrap_err();
    assert!(matches!(err, NbdCowError::Io(_)));

    // ensure_cow_fd early-exit must not have touched buffer state.
    assert_eq!(cow.buffered_block_count(), 2);
    assert_eq!(cow.buffer_bytes(), 2 * 4096);
    assert_eq!(cow.dirty_block_count(), 0);
}

// Sanity check that the full flush() wiring — ensure_cow_fd, try_clone,
// closure routing to write_all_at — survives an end-to-end real I/O failure.
// /dev/full always returns ENOSPC on write, so this covers "fail on first block"
// through the public API. Mid-drain coverage stays on the closure tests above.
#[test]
fn flush_with_dev_full_preserves_buffer() {
    if !std::path::Path::new("/dev/full").exists() {
        eprintln!("skip flush_with_dev_full_preserves_buffer: /dev/full not available");
        return;
    }
    let base = create_base_image(&vec![0x00; 8 * 4096]);
    // Point cow_path at /dev/full so ensure_cow_fd opens it.
    let mut cow = CowLayer::new(
        base.path(),
        std::path::Path::new("/dev/full"),
        8 * 4096,
        4096,
        1024 * 1024,
    )
    .unwrap();

    cow.write(0, &vec![0xEE; 4096]).unwrap();
    cow.write(4096, &vec![0xDD; 4096]).unwrap();

    let err = cow.flush().unwrap_err();
    assert!(matches!(err, NbdCowError::Io(_)));

    assert_eq!(cow.buffered_block_count(), 2);
    assert_eq!(cow.buffer_bytes(), 2 * 4096);
    assert_eq!(cow.dirty_block_count(), 0);
}
