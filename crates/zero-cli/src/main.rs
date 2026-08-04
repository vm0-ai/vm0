use std::env;
use std::os::unix::process::CommandExt;
use std::process::{Command, ExitCode};

fn main() -> ExitCode {
    let error = Command::new("npx")
        .args(["-p", "@vm0/cli", "zero"])
        .args(env::args_os().skip(1))
        .exec();

    eprintln!("failed to execute Zero CLI: {error}");
    ExitCode::FAILURE
}
