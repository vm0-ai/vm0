//! Shared plausibility contract for Unix epoch-millisecond timestamps.
//!
//! The minimum distinguishes millisecond-shaped timestamps from contemporary
//! Unix epoch seconds. This contract intentionally does not restrict how far a
//! timestamp may be in the future.

/// Inclusive minimum for a plausible Unix epoch-millisecond timestamp.
pub const MIN_PLAUSIBLE_EPOCH_MILLISECONDS: u64 = 1_000_000_000_000;

/// Return whether a value is a plausible Unix epoch-millisecond timestamp.
pub fn is_plausible_epoch_milliseconds(timestamp: u64) -> bool {
    timestamp >= MIN_PLAUSIBLE_EPOCH_MILLISECONDS
}
