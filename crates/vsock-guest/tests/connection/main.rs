#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

mod basic;
mod exec_operation;
mod process_control;
mod quiesce;
mod shutdown;
mod spawn_buffered;
mod spawn_streaming;
mod write_file;
