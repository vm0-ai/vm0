use crate::error::{RunnerError, RunnerResult};

use super::systemctl::get_service_pid;
use super::target::RunnerServiceUnit;

/// Outcome of attempting to signal a systemd unit's main process.
///
/// The `AlreadyGone` variant collapses two distinct races into a single
/// state so callers can encode one policy instead of two:
///
/// 1. `systemctl show` read `MainPID=0` — the runner either exited, systemd
///    is mid-transition and has cleared MainPID, or the unit was explicitly
///    reported as not found after a prior active-state check.
/// 2. MainPID resolved to a live value but `kill(2)` returned `ESRCH`
///    because the process exited in the ~µs window before signal delivery.
///
/// Failed or malformed MainPID lookups are not `AlreadyGone`; they propagate
/// as errors because the signal may still be needed.
///
/// Either way the signal was not delivered, and the cause is the same:
/// the runner is no longer around to receive it. `Sent` carries the PID
/// so callers can keep the pre-refactor `info!(…, pid, …)` structured
/// field in their journald logs.
pub(super) enum ServiceSignalOutcome {
    Sent { pid: u32 },
    AlreadyGone,
}

/// Send `sig` to the main process of `unit`, tolerating the race between
/// MainPID lookup and signal delivery.
///
/// Callers decide the policy for `AlreadyGone`: `drain` continues to
/// `systemctl disable` (the unit file must still be rewritten so the
/// service does not restart on reboot), while `resume` surfaces an error
/// matching its preflight "not active" branch — a runner that has exited
/// cannot be resumed.
pub(super) async fn signal_service_main(
    unit: &RunnerServiceUnit,
    sig: nix::sys::signal::Signal,
) -> RunnerResult<ServiceSignalOutcome> {
    let Some(pid) = get_service_pid(unit).await? else {
        return Ok(ServiceSignalOutcome::AlreadyGone);
    };
    let raw_pid =
        i32::try_from(pid).map_err(|_| RunnerError::Internal(format!("PID {pid} out of range")))?;
    match nix::sys::signal::kill(nix::unistd::Pid::from_raw(raw_pid), sig) {
        Ok(()) => Ok(ServiceSignalOutcome::Sent { pid }),
        Err(nix::errno::Errno::ESRCH) => Ok(ServiceSignalOutcome::AlreadyGone),
        Err(e) => Err(RunnerError::Internal(format!("{sig:?} to PID {pid}: {e}"))),
    }
}
