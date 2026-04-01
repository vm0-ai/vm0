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
