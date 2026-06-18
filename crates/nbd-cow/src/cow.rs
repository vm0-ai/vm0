//! Copy-on-write storage layer for `nbd-cow`.
//!
//! [`CowLayer`] serves reads from pending writes, then dirty blocks in the COW
//! file, then the read-only base image. Writes are collected in memory and
//! flushed to a sparse COW file; a bitmap sidecar records which blocks have been
//! materialized when snapshots are kept.

use std::collections::BTreeMap;
use std::fs::File;
use std::ops::Range;
use std::os::unix::fs::FileExt;
use std::path::Path;

use bitvec::prelude::*;

use crate::error::{NbdCowError, Result};

mod bitmap;

#[cfg(test)]
pub(crate) use bitmap::bitmap_tmp_path_for;
pub use bitmap::{bitmap_path_for, validate_bitmap, validate_bitmap_cow_coverage};

struct BlockSpan {
    block_idx: u64,
    absolute_offset: u64,
    block_offset: usize,
    buffer_offset: usize,
    len: usize,
}

impl BlockSpan {
    fn buffer_range(&self) -> Range<usize> {
        self.buffer_offset..self.buffer_offset + self.len
    }

    fn block_range(&self) -> Range<usize> {
        self.block_offset..self.block_offset + self.len
    }

    fn is_full_block(&self, block_size: usize) -> bool {
        self.block_offset == 0 && self.len == block_size
    }
}

struct BlockSpans {
    offset: u64,
    len: usize,
    block_size: usize,
    pos: usize,
}

impl BlockSpans {
    fn new(offset: u64, len: usize, block_size: usize) -> Self {
        debug_assert!(block_size > 0);
        Self {
            offset,
            len,
            block_size,
            pos: 0,
        }
    }
}

impl Iterator for BlockSpans {
    type Item = BlockSpan;

    fn next(&mut self) -> Option<Self::Item> {
        if self.pos >= self.len {
            return None;
        }

        let absolute_offset = self.offset + self.pos as u64;
        let block_idx = absolute_offset / self.block_size as u64;
        let block_offset = (absolute_offset % self.block_size as u64) as usize;
        let remaining_in_block = self.block_size - block_offset;
        let len = remaining_in_block.min(self.len - self.pos);
        let span = BlockSpan {
            block_idx,
            absolute_offset,
            block_offset,
            buffer_offset: self.pos,
            len,
        };
        self.pos += len;
        Some(span)
    }
}

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
    /// Returns an invalid-input error if `block_size` is zero, if `size` is
    /// zero, or if `size` is not an exact multiple of `block_size`. The COW
    /// layer stores and restores full blocks internally, so partial final blocks
    /// are not supported.
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
        if size == 0 {
            return Err(NbdCowError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "device size must be positive",
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

        // Auto-detect restore mode: load bitmap if a sidecar directory entry exists.
        let bitmap_path = bitmap_path_for(cow_path);
        let dirty = match std::fs::symlink_metadata(&bitmap_path) {
            Ok(_) => {
                let bv = bitmap::load_bitmap(&bitmap_path, num_blocks)?;
                tracing::info!(dirty_blocks = bv.count_ones(), "restored dirty bitmap");
                bv
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => bitvec![0; num_blocks],
            Err(e) => {
                return Err(NbdCowError::Io(std::io::Error::new(
                    e.kind(),
                    format!("stat dirty bitmap sidecar {}: {e}", bitmap_path.display()),
                )));
            }
        };

        // If bitmap has dirty bits, COW file must already exist — open it eagerly.
        let cow_fd = if dirty.count_ones() > 0 {
            let fd = File::options()
                .read(true)
                .write(true)
                .open(cow_path)
                .map_err(|e| {
                    NbdCowError::Io(std::io::Error::other(format!(
                        "dirty bitmap present but COW file cannot be opened: {e}"
                    )))
                })?;
            bitmap::validate_dirty_cow_coverage(&dirty, fd.metadata()?.len(), block_size)?;
            Some(fd)
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

        for span in BlockSpans::new(offset, buf.len(), self.block_size) {
            let dest = buf.get_mut(span.buffer_range()).ok_or_else(|| {
                NbdCowError::Io(std::io::Error::other("slice out of bounds in read"))
            })?;

            // Check write buffer first
            if let Some(block_data) = self.write_buffer.get(&span.block_idx) {
                let src = block_data.get(span.block_range()).ok_or_else(|| {
                    NbdCowError::Io(std::io::Error::other("block_data slice out of bounds"))
                })?;
                dest.copy_from_slice(src);
            } else if self.is_dirty(span.block_idx) {
                // Read from COW file
                if let Some(ref cow_fd) = self.cow_fd {
                    cow_fd.read_exact_at(dest, span.absolute_offset)?;
                } else {
                    return Err(NbdCowError::Io(std::io::Error::other(
                        "dirty bit set but COW file not open",
                    )));
                }
            } else {
                // Read from base image
                self.base_fd.read_exact_at(dest, span.absolute_offset)?;
            }
        }

        Ok(())
    }

    /// Write `data` at `offset`. Returns `true` if the buffer needs flushing.
    pub fn write(&mut self, offset: u64, data: &[u8]) -> Result<bool> {
        self.check_bounds(offset, data.len() as u64)?;

        for span in BlockSpans::new(offset, data.len(), self.block_size) {
            let src_slice = data.get(span.buffer_range()).ok_or_else(|| {
                NbdCowError::Io(std::io::Error::other("data src slice out of bounds"))
            })?;

            if let Some(block_data) = self.write_buffer.get_mut(&span.block_idx) {
                let dest_slice = block_data.get_mut(span.block_range()).ok_or_else(|| {
                    NbdCowError::Io(std::io::Error::other("block_data dest slice out of bounds"))
                })?;
                dest_slice.copy_from_slice(src_slice);
                continue;
            }

            if span.is_full_block(self.block_size) {
                self.write_buffer.insert(span.block_idx, src_slice.to_vec());
                continue;
            }

            let mut block_data = self.read_full_block(span.block_idx)?;
            let dest_slice = block_data.get_mut(span.block_range()).ok_or_else(|| {
                NbdCowError::Io(std::io::Error::other("block_data dest slice out of bounds"))
            })?;
            dest_slice.copy_from_slice(src_slice);
            self.write_buffer.insert(span.block_idx, block_data);
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
    pub(crate) fn save_bitmap(&self, path: &Path) -> Result<()> {
        bitmap::save_bitmap(&self.dirty, path)
    }
}

#[cfg(test)]
mod tests;
