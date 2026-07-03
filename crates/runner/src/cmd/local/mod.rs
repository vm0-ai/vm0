//! `runner local` — subcommands for the local file-queue provider.

pub(crate) mod cancel;
pub(crate) mod submit;

use std::process::ExitCode;

use clap::{Args, Subcommand};

use crate::error::RunnerResult;

/// Arguments for the `runner local` subcommand group.
#[derive(Args)]
pub struct LocalArgs {
    #[command(subcommand)]
    command: LocalCommand,
}

#[derive(Subcommand)]
enum LocalCommand {
    /// Submit a job to a locally running runner
    Submit(submit::SubmitArgs),
    /// Cancel a running job
    Cancel(cancel::CancelArgs),
}

/// Dispatch `runner local` to the selected local file-queue subcommand.
pub async fn run_local(args: LocalArgs) -> RunnerResult<ExitCode> {
    match args.command {
        LocalCommand::Submit(args) => submit::run_submit(args).await,
        LocalCommand::Cancel(args) => cancel::run_cancel(args).await,
    }
}
