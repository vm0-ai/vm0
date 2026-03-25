use std::process::Command;

use crate::error::{BlockCowError, Result};

/// Run a command via sudo and return stdout on success, or a descriptive error
/// on failure.
///
/// All block-cow operations (`losetup`, `dmsetup`, `blockdev`) require root
/// privileges. The runner process runs as a regular user and delegates
/// privilege escalation to sudo.
pub fn sudo(program: &str, args: &[&str]) -> Result<String> {
    let mut sudo_args = vec![program];
    sudo_args.extend_from_slice(args);

    let output = Command::new("sudo")
        .args(&sudo_args)
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
