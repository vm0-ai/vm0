//! Shared contracts between the runner and guest binaries.
//!
//! Keep guest-only runtime helpers in `guest-common`. This crate is for names
//! and values both sides must keep in lockstep.

pub mod env;
