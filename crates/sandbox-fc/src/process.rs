/// Kill the entire process group of `child` via `killpg(SIGKILL)`.
///
/// Requires the child to have been spawned with `process_group(0)` so that its
/// PGID equals its PID. No-op if the child has already exited or the PID cannot
/// be represented as `i32`.
pub(crate) fn kill_process_group(child: &tokio::process::Child) {
    if let Some(pid) = child.id() {
        kill_process_group_by_pid(pid);
    }
}

/// Kill the process group whose PGID equals `pid`.
///
/// Callers should prefer [`kill_process_group`] when they still own the child;
/// that avoids signalling from a PID after the child has been reaped.
pub(crate) fn kill_process_group_by_pid(pid: u32) {
    if let Ok(pid) = i32::try_from(pid) {
        let pgid = nix::unistd::Pid::from_raw(pid);
        let _ = nix::sys::signal::killpg(pgid, nix::sys::signal::Signal::SIGKILL);
    }
}

#[cfg(test)]
pub(crate) async fn child_exit_notification_available_for_test() -> bool {
    let mut child = tokio::process::Command::new("sh")
        .args(["-c", "read value"])
        .stdin(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn pidfd availability probe");
    let available = child_exit_notifier::ChildExitNotifier::open(&child).is_ok();
    drop(child.stdin.take());
    child.wait().await.expect("reap pidfd availability probe");
    available
}
