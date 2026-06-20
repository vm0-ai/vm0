#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

mod basic;
mod exec_basic;
mod exec_cancel_cleanup;
mod exec_control;
mod exec_helpers;
mod exec_output;
mod exec_stdin;
mod exec_validation;
mod quiesce;
mod reconnect;
mod shutdown;
mod write_file;
