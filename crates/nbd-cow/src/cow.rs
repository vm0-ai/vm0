//! Copy-on-write storage layer for `nbd-cow`.
//!
//! [`CowLayer`] serves reads from pending writes, then dirty blocks in the COW
//! file, then the read-only base image. Writes are collected in memory and
//! flushed to a sparse COW file; a bitmap sidecar records which blocks have been
//! materialized when snapshots are kept.

use std::collections::BTreeMap;
use std::fs::File;
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};

use bitvec::prelude::*;

use crate::error::{NbdCowError, Result};

// Bitmap serialization assumes usize == u64 (bitvec stores usize words).
const _: () = assert!(
    std::mem::size_of::<usize>() == 8,
    "nbd-cow requires a 64-bit target"
);

/// COW (Copy-on-Write) layer with write buffering.
///
/// Reads check: write buffer -> dirty COW file -> base image.
/// Writes accumulate in an in-memory buffer that is flushed to the COW file
/// when the buffer exceeds the flush threshold.
pub struct CowLayer {
    /// Read-only base image file.
    base_fd: File,
    /// Path for the sparse COW file (created on first flush).
    cow_path: std::path::PathBuf,
    /// Open file handle for the COW file (lazily opened on first flush).
    cow_fd: Option<File>,
    /// 1 bit per block: set if the block has been written (and flushed to COW file).
    dirty: BitVec,
    /// Pending writes: block index -> block data.
    write_buffer: BTreeMap<u64, Vec<u8>>,
    /// Current buffer usage in bytes.
    buffer_bytes: usize,
    /// Flush when buffer_bytes exceeds this threshold.
    flush_threshold: usize,
    /// Block size in bytes.
    block_size: usize,
    /// Total device size in bytes.
    size: u64,
}

impl CowLayer {
    /// Create a new COW layer.
    ///
    /// If a bitmap sidecar file (`{cow_path}.bitmap`) exists, the dirty bitmap
    /// is restored from it and the COW file is opened eagerly. This enables
    /// snapshot restore: a previous `save_bitmap()` + `destroy_keep_cow()` cycle
    /// preserves the COW state, and a subsequent `new()` with the same paths
    /// picks it up automatically.
    ///
    /// `base_path`: read-only base image file
    /// `cow_path`: path for the sparse COW file (created on first flush)
    /// `size`: total device size in bytes
    /// `block_size`: block size (typically 4096)
    /// `flush_threshold`: flush write buffer when it exceeds this size in bytes
    ///
    /// # Errors
    ///
    /// Returns an invalid-input error if `block_size` is zero or if `size` is
    /// not an exact multiple of `block_size`. The COW layer stores and restores
    /// full blocks internally, so partial final blocks are not supported.
    ///
    /// Returns an I/O error if the base image cannot be opened, or if an
    /// existing bitmap sidecar or its associated COW file cannot be restored.
    pub fn new(
        base_path: &Path,
        cow_path: &Path,
        size: u64,
        block_size: usize,
        flush_threshold: usize,
    ) -> Result<Self> {
        if block_size == 0 {
            return Err(NbdCowError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "block_size must be positive",
            )));
        }
        if !size.is_multiple_of(block_size as u64) {
            return Err(NbdCowError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("device size ({size}) must be a multiple of block_size ({block_size})"),
            )));
        }
        let base_fd = File::open(base_path)?;
        let num_blocks = (size as usize).div_ceil(block_size);

        // Auto-detect restore mode: load bitmap if sidecar file exists.
        let bitmap_path = bitmap_path_for(cow_path);
        let dirty = if bitmap_path.exists() {
            let bv = Self::load_bitmap(&bitmap_path, num_blocks)?;
            tracing::info!(dirty_blocks = bv.count_ones(), "restored dirty bitmap");
            bv
        } else {
            bitvec![0; num_blocks]
        };

        // If bitmap has dirty bits, COW file must already exist — open it eagerly.
        let cow_fd = if dirty.count_ones() > 0 {
            Some(
                File::options()
                    .read(true)
                    .write(true)
                    .open(cow_path)
                    .map_err(|e| {
                        NbdCowError::Io(std::io::Error::other(format!(
                            "dirty bitmap present but COW file cannot be opened: {e}"
                        )))
                    })?,
            )
        } else {
            None
        };

        Ok(Self {
            base_fd,
            cow_path: cow_path.to_path_buf(),
            cow_fd,
            dirty,
            write_buffer: BTreeMap::new(),
            buffer_bytes: 0,
            flush_threshold,
            block_size,
            size,
        })
    }

    /// Read `buf.len()` bytes starting at `offset`.
    ///
    /// Read path: write buffer -> COW file (if dirty) -> base image.
    pub fn read(&self, offset: u64, buf: &mut [u8]) -> Result<()> {
        self.check_bounds(offset, buf.len() as u64)?;

        let mut pos = 0usize;
        while pos < buf.len() {
            let current_offset = offset + pos as u64;
            let block_idx = current_offset / self.block_size as u64;
            let block_offset = (current_offset % self.block_size as u64) as usize;
            let remaining_in_block = self.block_size - block_offset;
            let to_read = remaining_in_block.min(buf.len() - pos);

            let dest = buf.get_mut(pos..pos + to_read).ok_or_else(|| {
                NbdCowError::Io(std::io::Error::other("slice out of bounds in read"))
            })?;

            // Check write buffer first
            if let Some(block_data) = self.write_buffer.get(&block_idx) {
                let src = block_data
                    .get(block_offset..block_offset + to_read)
                    .ok_or_else(|| {
                        NbdCowError::Io(std::io::Error::other("block_data slice out of bounds"))
                    })?;
                dest.copy_from_slice(src);
            } else if self.is_dirty(block_idx) {
                // Read from COW file
                if let Some(ref cow_fd) = self.cow_fd {
                    cow_fd.read_exact_at(dest, current_offset)?;
                } else {
                    return Err(NbdCowError::Io(std::io::Error::other(
                        "dirty bit set but COW file not open",
                    )));
                }
            } else {
                // Read from base image
                self.base_fd.read_exact_at(dest, current_offset)?;
            }

            pos += to_read;
        }

        Ok(())
    }

    /// Write `data` at `offset`. Returns `true` if the buffer needs flushing.
    pub fn write(&mut self, offset: u64, data: &[u8]) -> Result<bool> {
        self.check_bounds(offset, data.len() as u64)?;

        let mut pos = 0usize;
        while pos < data.len() {
            let current_offset = offset + pos as u64;
            let block_idx = current_offset / self.block_size as u64;
            let block_offset = (current_offset % self.block_size as u64) as usize;
            let remaining_in_block = self.block_size - block_offset;
            let to_write = remaining_in_block.min(data.len() - pos);

            if !self.write_buffer.contains_key(&block_idx) {
                let full_block = if block_offset == 0 && to_write == self.block_size {
                    vec![0u8; self.block_size]
                } else {
                    self.read_full_block(block_idx)?
                };
                self.write_buffer.insert(block_idx, full_block);
            }
            let block_data = self
                .write_buffer
                .get_mut(&block_idx)
                .ok_or_else(|| NbdCowError::Io(std::io::Error::other("missing buffer entry")))?;

            let dest_slice = block_data
                .get_mut(block_offset..block_offset + to_write)
                .ok_or_else(|| {
                    NbdCowError::Io(std::io::Error::other("block_data dest slice out of bounds"))
                })?;
            let src_slice = data.get(pos..pos + to_write).ok_or_else(|| {
                NbdCowError::Io(std::io::Error::other("data src slice out of bounds"))
            })?;
            dest_slice.copy_from_slice(src_slice);

            pos += to_write;
        }

        // Recalculate buffer bytes
        self.buffer_bytes = self.write_buffer.len() * self.block_size;

        Ok(self.buffer_bytes >= self.flush_threshold)
    }

    /// Flush the write buffer to the COW file.
    ///
    /// BTreeMap iterates in key order, giving sequential I/O for free.
    /// On I/O failure, unwritten blocks are restored to the buffer so no data is lost.
    pub fn flush(&mut self) -> Result<()> {
        if self.write_buffer.is_empty() {
            return Ok(());
        }

        self.ensure_cow_fd()?;
        let cow_fd = self
            .cow_fd
            .take()
            .ok_or_else(|| NbdCowError::Io(std::io::Error::other("cow_fd missing after ensure")))?;
        let result = self.flush_buffered(|offset, data| cow_fd.write_all_at(data, offset));
        self.cow_fd = Some(cow_fd);
        result
    }

    /// Drain `write_buffer` through `write_fn`. On failure, restores the failed
    /// block and all unprocessed blocks to `write_buffer`, recomputes
    /// `buffer_bytes`, and returns the error. Dirty bits are set only for blocks
    /// the writer accepted.
    ///
    /// The writer boundary is a closure so tests can cover partial-success-then-fail
    /// at arbitrary index, which real-I/O injection (/dev/full, file seals,
    /// RLIMIT_FSIZE) cannot reproduce.
    fn flush_buffered<W>(&mut self, mut write_fn: W) -> Result<()>
    where
        W: FnMut(u64, &[u8]) -> std::io::Result<()>,
    {
        let block_size = self.block_size;
        let mut blocks = std::mem::take(&mut self.write_buffer).into_iter();

        while let Some((block_idx, block_data)) = blocks.next() {
            let offset = block_idx * block_size as u64;
            if let Err(e) = write_fn(offset, &block_data) {
                self.write_buffer.insert(block_idx, block_data);
                self.write_buffer.extend(blocks);
                self.buffer_bytes = self.write_buffer.len() * block_size;
                return Err(e.into());
            }
            self.set_dirty(block_idx);
        }

        self.buffer_bytes = 0;
        Ok(())
    }

    /// Flush and fsync the COW file.
    pub fn sync(&mut self) -> Result<()> {
        self.flush()?;
        if let Some(ref cow_fd) = self.cow_fd {
            cow_fd.sync_all()?;
        }
        Ok(())
    }

    /// Number of dirty blocks (flushed to COW file).
    pub fn dirty_block_count(&self) -> usize {
        self.dirty.count_ones()
    }

    /// Number of blocks in the write buffer (not yet flushed).
    pub fn buffered_block_count(&self) -> usize {
        self.write_buffer.len()
    }

    /// Current write buffer size in bytes.
    pub fn buffer_bytes(&self) -> usize {
        self.buffer_bytes
    }

    fn check_bounds(&self, offset: u64, length: u64) -> Result<()> {
        if offset.saturating_add(length) > self.size {
            return Err(NbdCowError::OutOfBounds {
                offset,
                length,
                device_size: self.size,
            });
        }
        Ok(())
    }

    fn is_dirty(&self, block_idx: u64) -> bool {
        debug_assert!(
            (block_idx as usize) < self.dirty.len(),
            "block_idx {block_idx} out of range (max {})",
            self.dirty.len()
        );
        self.dirty
            .get(block_idx as usize)
            .as_deref()
            .copied()
            .unwrap_or(false)
    }

    fn set_dirty(&mut self, block_idx: u64) {
        debug_assert!(
            (block_idx as usize) < self.dirty.len(),
            "block_idx {block_idx} out of range (max {})",
            self.dirty.len()
        );
        if let Some(mut bit) = self.dirty.get_mut(block_idx as usize) {
            *bit = true;
        }
    }

    /// Read a full block, preferring COW file if dirty, otherwise base image.
    fn read_full_block(&self, block_idx: u64) -> Result<Vec<u8>> {
        let mut buf = vec![0u8; self.block_size];
        let offset = block_idx * self.block_size as u64;

        if self.is_dirty(block_idx) {
            if let Some(ref cow_fd) = self.cow_fd {
                cow_fd.read_exact_at(&mut buf, offset)?;
                return Ok(buf);
            }
            return Err(NbdCowError::Io(std::io::Error::other(
                "dirty bit set but COW file not open",
            )));
        }

        self.base_fd.read_exact_at(&mut buf, offset)?;
        Ok(buf)
    }

    fn ensure_cow_fd(&mut self) -> Result<()> {
        if self.cow_fd.is_none() {
            let fd = File::options()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(&self.cow_path)?;
            self.cow_fd = Some(fd);
        }
        Ok(())
    }

    /// Save the dirty bitmap to a file.
    ///
    /// Format: `[u64 num_blocks LE] [u64 words as LE bytes]`.
    /// Uses u64 words for portability (not platform-dependent usize).
    pub(crate) fn save_bitmap(&self, path: &Path) -> Result<()> {
        let num_blocks = self.dirty.len() as u64;
        let raw = self.dirty.as_raw_slice();
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
        let tmp_path = PathBuf::from(format!("{}.tmp", path.display()));
        if let Err(e) = File::create(&tmp_path).and_then(|f| {
            f.write_all_at(&data, 0)?;
            f.sync_all()
        }) {
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
    fn load_bitmap(path: &Path, expected_blocks: usize) -> Result<BitVec> {
        let data = std::fs::read(path)?;
        if data.len() < 8 {
            return Err(NbdCowError::Io(std::io::Error::other(
                "bitmap file too short for header",
            )));
        }
        let header: [u8; 8] = data
            .get(..8)
            .ok_or_else(|| NbdCowError::Io(std::io::Error::other("bitmap header too short")))?
            .try_into()
            .map_err(|_| NbdCowError::Io(std::io::Error::other("bitmap header parse error")))?;
        let num_blocks = u64::from_le_bytes(header) as usize;
        if num_blocks != expected_blocks {
            return Err(NbdCowError::Io(std::io::Error::other(format!(
                "bitmap block count mismatch: file has {num_blocks}, expected {expected_blocks}"
            ))));
        }
        let bitmap_bytes = data
            .get(8..)
            .ok_or_else(|| NbdCowError::Io(std::io::Error::other("bitmap data missing")))?;
        let expected_words = num_blocks.div_ceil(64);
        let expected_data_len = expected_words * 8;
        if bitmap_bytes.len() < expected_data_len {
            return Err(NbdCowError::Io(std::io::Error::other(format!(
                "bitmap data truncated: got {} bytes, expected {expected_data_len}",
                bitmap_bytes.len()
            ))));
        }
        let mut words: Vec<usize> = Vec::with_capacity(expected_words);
        for i in 0..expected_words {
            let offset = i * 8;
            let word_bytes: [u8; 8] = bitmap_bytes
                .get(offset..offset + 8)
                .ok_or_else(|| NbdCowError::Io(std::io::Error::other("bitmap word out of bounds")))?
                .try_into()
                .map_err(|_| NbdCowError::Io(std::io::Error::other("bitmap word parse error")))?;
            words.push(u64::from_le_bytes(word_bytes) as usize);
        }
        let mut bv = BitVec::from_vec(words);
        bv.truncate(num_blocks);
        Ok(bv)
    }
}

/// Compute the bitmap sidecar path for a given COW file path.
///
/// Convention: `{cow_path}.bitmap` (e.g., `cow.img.bitmap`).
pub fn bitmap_path_for(cow_path: &Path) -> PathBuf {
    let mut name = cow_path.as_os_str().to_os_string();
    name.push(".bitmap");
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as IoWrite;
    use tempfile::NamedTempFile;

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
        let loaded = CowLayer::load_bitmap(bitmap_file.path(), 2).unwrap();
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
        let result = CowLayer::load_bitmap(bitmap_file.path(), 999);
        assert!(result.is_err());
    }

    #[test]
    fn bitmap_load_truncated_data_errors() {
        let bitmap_file = NamedTempFile::new().unwrap();

        // Write header claiming 128 blocks but no bitmap data
        let num_blocks: u64 = 128;
        std::fs::write(bitmap_file.path(), num_blocks.to_le_bytes()).unwrap();

        let result = CowLayer::load_bitmap(bitmap_file.path(), 128);
        assert!(result.is_err());

        // Write header + partial data (less than needed)
        let mut data = num_blocks.to_le_bytes().to_vec();
        data.extend_from_slice(&[0u8; 4]); // only 4 bytes, need 128/64*8 = 16
        std::fs::write(bitmap_file.path(), &data).unwrap();

        let result = CowLayer::load_bitmap(bitmap_file.path(), 128);
        assert!(result.is_err());
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
    fn bitmap_empty_round_trip() {
        let base = create_base_image(&vec![0x00; 4096]);
        let cow_file = NamedTempFile::new().unwrap();
        let cow = make_cow(&base, &cow_file, 4096, 1024 * 1024);

        let bitmap_file = NamedTempFile::new().unwrap();
        cow.save_bitmap(bitmap_file.path()).unwrap();

        let loaded = CowLayer::load_bitmap(bitmap_file.path(), 1).unwrap();
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
            .flush_buffered(|_off, _data| {
                Err(std::io::Error::from(std::io::ErrorKind::StorageFull))
            })
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
        let mut cow =
            CowLayer::new(base.path(), &bad_cow_path, 8 * 4096, 4096, 1024 * 1024).unwrap();

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
}
