//! Common utilities for VM scripts.
//!
//! This crate provides shared functionality for VM-side tools:
//! - Environment variable accessors
//! - File path constants
//! - Telemetry recording
//! - Logging macros

pub mod env;
pub mod log;
pub mod paths;
pub mod telemetry;
