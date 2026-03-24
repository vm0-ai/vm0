use std::process::Command;

use crate::error::{BlockCowError, Result};

/// Run a command and return stdout on success, or a descriptive error on failure.
pub fn run(program: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| BlockCowError::Command {
            program: program.to_owned(),
            source: e,
        })?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let args_str = args.join(" ");
        Err(BlockCowError::CommandFailed {
            program: format!("{program} {args_str}"),
            stderr,
        })
    }
}
