use std::fs::{File, OpenOptions};
use std::io::{BufReader, Read};
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};

use bitvec::prelude::*;

use crate::error::{NbdCowError, Result};

// Bitmap serialization assumes usize == u64 (bitvec stores usize words).
const _: () = assert!(
    std::mem::size_of::<usize>() == 8,
    "nbd-cow requires a 64-bit target"
);

/// Save the dirty bitmap to a file.
///
/// Format: `[u64 num_blocks LE] [u64 words as LE bytes]`.
/// Uses u64 words for portability (not platform-dependent usize).
pub(super) fn save_bitmap(dirty: &BitVec, path: &Path) -> Result<()> {
    let num_blocks = dirty.len() as u64;
    let raw = dirty.as_raw_slice();
    let mut data = Vec::with_capacity(8 + raw.len() * 8);
    data.extend_from_slice(&num_blocks.to_le_bytes());
    for word in raw {
        data.extend_from_slice(&(*word as u64).to_le_bytes());
    }
    // Crash-safe bitmap swap: write tmp → fsync(tmp) → rename → fsync(dir).
    // Two fsyncs, each covering a different guarantee:
    //   - fsync(tmp): makes the bitmap bytes durable on the inode.
    //   - fsync(dir): makes the rename's dir-entry update durable. Without
    //     this, rename(2) returns after journaling the entry but the update
    //     may not hit disk until the FS's next commit (~5s on ext4
    //     data=ordered). A crash in that window can leave the bitmap path
    //     pointing at the old file (or absent), while the COW data file —
    //     already fsynced by CowLayer::sync — is durable. The resulting
    //     bitmap/COW divergence silently corrupts reads on the next restore:
    //     dirty bits disagree with actual COW content, reads fall through
    //     to stale base-image bytes.
    //
    // Open the parent dir fd up front so a malformed path (no parent) fails
    // before any FS mutation, and hold it across the rename so the final
    // fsync targets a stable inode.
    let parent = path.parent().ok_or_else(|| {
        NbdCowError::Io(std::io::Error::other(format!(
            "bitmap path has no parent directory: {}",
            path.display()
        )))
    })?;
    let dir_fd = File::open(parent)?;
    let tmp_path = bitmap_tmp_path_for(path);
    match std::fs::remove_file(&tmp_path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    if let Err(e) = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)
        .and_then(|f| {
            f.write_all_at(&data, 0)?;
            f.sync_all()
        })
    {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e.into());
    }
    if let Err(e) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e.into());
    }
    dir_fd.sync_all()?;
    Ok(())
}

/// Load a dirty bitmap from a file.
///
/// Returns an error if the block count doesn't match `expected_blocks`
/// or if the file is truncated.
pub(super) fn load_bitmap(path: &Path, expected_blocks: usize) -> Result<BitVec> {
    let file = File::open(path)?;
    let file_len = file.metadata()?.len();
    if file_len < 8 {
        return Err(NbdCowError::Io(std::io::Error::other(
            "bitmap file too short for header",
        )));
    }
    let mut reader = BufReader::new(file);
    let mut header = [0u8; 8];
    reader.read_exact(&mut header)?;
    let num_blocks = u64::from_le_bytes(header) as usize;
    if num_blocks != expected_blocks {
        return Err(NbdCowError::Io(std::io::Error::other(format!(
            "bitmap block count mismatch: file has {num_blocks}, expected {expected_blocks}"
        ))));
    }
    let expected_words = num_blocks.div_ceil(64);
    let expected_data_len = expected_words * 8;
    let bitmap_data_len = file_len.saturating_sub(8);
    if bitmap_data_len < expected_data_len as u64 {
        return Err(NbdCowError::Io(std::io::Error::other(format!(
            "bitmap data truncated: got {bitmap_data_len} bytes, expected {expected_data_len}",
        ))));
    }
    let mut words: Vec<usize> = Vec::new();
    words.try_reserve_exact(expected_words).map_err(|e| {
        NbdCowError::Io(std::io::Error::other(format!(
            "bitmap word allocation failed: {e}"
        )))
    })?;
    for _ in 0..expected_words {
        let mut word_bytes = [0u8; 8];
        reader.read_exact(&mut word_bytes)?;
        words.push(u64::from_le_bytes(word_bytes) as usize);
    }
    let mut bv = BitVec::from_vec(words);
    bv.truncate(num_blocks);
    Ok(bv)
}

/// Compute the bitmap sidecar path for a given COW file path.
///
/// Convention: `{cow_path}.bitmap` (e.g., `cow.img.bitmap`).
pub fn bitmap_path_for(cow_path: &Path) -> PathBuf {
    let mut name = cow_path.as_os_str().to_os_string();
    name.push(".bitmap");
    PathBuf::from(name)
}

pub(crate) fn bitmap_tmp_path_for(bitmap_path: &Path) -> PathBuf {
    let mut name = bitmap_path.as_os_str().to_os_string();
    name.push(".tmp");
    PathBuf::from(name)
}

/// Validate that a dirty-bitmap sidecar matches the expected block count.
pub fn validate_bitmap(path: &Path, expected_blocks: usize) -> Result<()> {
    load_bitmap(path, expected_blocks).map(drop)
}

/// Validate that a dirty-bitmap sidecar does not reference COW data beyond the
/// current COW file length.
pub fn validate_bitmap_cow_coverage(
    bitmap_path: &Path,
    cow_file_len: u64,
    block_size: usize,
    expected_blocks: usize,
) -> Result<()> {
    if block_size == 0 {
        return Err(NbdCowError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "block_size must be positive",
        )));
    }

    let dirty = load_bitmap(bitmap_path, expected_blocks)?;
    validate_dirty_cow_coverage(&dirty, cow_file_len, block_size)
}

pub(super) fn validate_dirty_cow_coverage(
    dirty: &BitVec,
    cow_file_len: u64,
    block_size: usize,
) -> Result<()> {
    debug_assert!(block_size > 0);

    let Some(last_dirty_block) = dirty.last_one() else {
        return Ok(());
    };
    let dirty_blocks = last_dirty_block.checked_add(1).ok_or_else(|| {
        NbdCowError::Io(std::io::Error::other(
            "dirty bitmap block index overflowed file length check",
        ))
    })?;
    let required_len = u64::try_from(dirty_blocks)
        .ok()
        .and_then(|blocks| {
            u64::try_from(block_size)
                .ok()
                .and_then(|size| blocks.checked_mul(size))
        })
        .ok_or_else(|| {
            NbdCowError::Io(std::io::Error::other(
                "dirty bitmap required COW length overflowed",
            ))
        })?;

    if cow_file_len < required_len {
        return Err(NbdCowError::Io(std::io::Error::other(format!(
            "dirty bitmap references COW data requiring at least {required_len} bytes, but COW file is {cow_file_len} bytes"
        ))));
    }

    Ok(())
}
