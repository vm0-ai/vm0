//! In-process NBD copy-on-write block devices.
//!
//! This crate exposes a Linux NBD device backed by a read-only base image and a
//! sparse copy-on-write (COW) file. [`pool::DevicePoolHandle::create_cow_device`]
//! connects the device,
//! starts the request dispatch tasks, and serves reads from pending writes, the
//! COW file, then the base image. Writes are buffered in memory and flushed to
//! the sparse COW file according to [`DEFAULT_FLUSH_THRESHOLD`].
//!
//! Important defaults are exposed as [`BLOCK_SIZE`], [`NUM_CONNECTIONS`], and
//! [`DEFAULT_FLUSH_THRESHOLD`].
//!
//! The layered implementation is split across:
//! - [`cow`] for COW storage and dirty bitmap persistence.
//! - [`pool`] for host-locked `/dev/nbdN` device claim allocation.
//! - [`netlink`] for Linux NBD generic netlink setup and disconnect.
//! - [`server`] for the in-process NBD dispatch loop.
//! - [`protocol`] for NBD transmission protocol parsing and serialization.
//! - [`error`] for crate error and result types.
//!
//! Call pooled-device finalizers when the device should be shut down cleanly.
//! Dropping a device only performs best-effort cleanup and may discard buffered
//! writes that were not flushed.

pub mod cow;
mod device;
pub mod device_lock;
pub mod error;
pub mod netlink;
pub mod pool;
pub mod protocol;
pub mod server;

pub use device::{
    DestroyRetryPolicy, KeptCow, NbdCowDevice, PooledDestroyError, PooledNbdCowDevice,
    is_our_thread,
};

/// Default block size: 4KB (matches typical filesystem block size and kernel page size).
pub const BLOCK_SIZE: usize = 4096;

/// Default number of connections per NBD device.
pub const NUM_CONNECTIONS: usize = 4;

/// Default write buffer flush threshold: 4MB.
pub const DEFAULT_FLUSH_THRESHOLD: usize = 4 * 1024 * 1024;
