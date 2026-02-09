use crate::command::{CommandError, Privilege, exec};

/// Recursively kill a process and all its descendants (depth-first).
pub(crate) async fn kill_process_tree(pid: u32) {
    let pid_str = pid.to_string();
    if let Ok(stdout) = exec("pgrep", &["-P", &pid_str], Privilege::User).await {
        for line in stdout.lines() {
            if let Ok(child_pid) = line.trim().parse::<u32>() {
                Box::pin(kill_process_tree(child_pid)).await;
            }
        }
    }

    let _ = exec("kill", &["-9", &pid_str], Privilege::Sudo).await;
}

/// Get the current username via `getuid()`.
pub(crate) fn current_username() -> Result<String, CommandError> {
    let uid = nix::unistd::getuid();
    let user = nix::unistd::User::from_uid(uid)
        .map_err(|e| CommandError {
            command: "getuid".into(),
            detail: format!("lookup uid {uid}: {e}"),
        })?
        .ok_or_else(|| CommandError {
            command: "getuid".into(),
            detail: format!("no user for uid {uid}"),
        })?;
    Ok(user.name)
}
