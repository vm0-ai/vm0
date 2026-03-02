use crate::command::CommandError;

/// Kill the entire process group of `child` via `killpg(SIGKILL)`.
///
/// Requires the child to have been spawned with `process_group(0)` so that its
/// PGID equals its PID. No-op if the child has already exited or the PID cannot
/// be represented as `i32`.
pub(crate) fn kill_process_group(child: &tokio::process::Child) {
    if let Some(pid) = child.id()
        && let Ok(pid) = i32::try_from(pid)
    {
        let pgid = nix::unistd::Pid::from_raw(pid);
        let _ = nix::sys::signal::killpg(pgid, nix::sys::signal::Signal::SIGKILL);
    }
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
