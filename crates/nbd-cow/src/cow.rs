use std::collections::BTreeMap;
use std::fs::File;
use std::os::unix::fs::FileExt;
use std::path::Path;

use bitvec::prelude::*;

use crate::error::{NbdCowError, Result};

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
    /// `base_path`: read-only base image file
    /// `cow_path`: path for the sparse COW file (created on first flush)
    /// `size`: total device size in bytes
    /// `block_size`: block size (typically 4096)
    /// `flush_threshold`: flush write buffer when it exceeds this size in bytes
    pub fn new(
        base_path: &Path,
        cow_path: &Path,
        size: u64,
        block_size: usize,
        flush_threshold: usize,
    ) -> Result<Self> {
        let base_fd = File::open(base_path)?;
        let num_blocks = (size as usize).div_ceil(block_size);

        Ok(Self {
            base_fd,
            cow_path: cow_path.to_path_buf(),
            cow_fd: None,
            dirty: bitvec![0; num_blocks],
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
                    cow_fd.read_at(dest, current_offset)?;
                } else {
                    return Err(NbdCowError::Io(std::io::Error::other(
                        "dirty bit set but COW file not open",
                    )));
                }
            } else {
                // Read from base image
                self.base_fd.read_at(dest, current_offset)?;
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
                let full_block = self.read_full_block(block_idx)?;
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

        // Take ownership; on failure we put unwritten blocks back.
        let blocks: Vec<(u64, Vec<u8>)> =
            std::mem::take(&mut self.write_buffer).into_iter().collect();

        let block_size = self.block_size;
        for (i, entry) in blocks.iter().enumerate() {
            let offset = entry.0 * block_size as u64;
            if let Some(ref cow_fd) = self.cow_fd
                && let Err(e) = cow_fd.write_at(&entry.1, offset)
            {
                // Restore unwritten blocks back to the buffer
                for (idx, buf) in blocks.into_iter().skip(i) {
                    self.write_buffer.insert(idx, buf);
                }
                self.buffer_bytes = self.write_buffer.len() * self.block_size;
                return Err(e.into());
            }
            self.set_dirty(entry.0);
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
        self.dirty
            .get(block_idx as usize)
            .as_deref()
            .copied()
            .unwrap_or(false)
    }

    fn set_dirty(&mut self, block_idx: u64) {
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
                cow_fd.read_at(&mut buf, offset)?;
                return Ok(buf);
            }
            return Err(NbdCowError::Io(std::io::Error::other(
                "dirty bit set but COW file not open",
            )));
        }

        self.base_fd.read_at(&mut buf, offset)?;
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
}
