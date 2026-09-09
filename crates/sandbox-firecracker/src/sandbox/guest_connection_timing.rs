use std::time::Instant;

use guest_control_client::GuestConnectionTiming;
use sandbox::{SandboxGuestConnectionPhase, SandboxStartObserver};

/// Convert one completed task's monotonic timeline without changing ownership.
pub(super) fn record_guest_connection_timing(
    observer: &mut dyn SandboxStartObserver,
    timing: GuestConnectionTiming,
    submitted: Instant,
    remaining_started: Instant,
    observed: Instant,
) {
    let mut started = submitted;
    let phases = [
        (
            SandboxGuestConnectionPhase::TaskSchedule,
            Some(timing.started),
        ),
        (
            SandboxGuestConnectionPhase::ListenerSetup,
            timing.listener_bound,
        ),
        (SandboxGuestConnectionPhase::Accept, timing.accepted),
        (SandboxGuestConnectionPhase::Ready, timing.ready),
        (SandboxGuestConnectionPhase::Ping, timing.ping_written),
        (SandboxGuestConnectionPhase::Pong, timing.pong_received),
        (
            SandboxGuestConnectionPhase::ClientSetup,
            Some(timing.completed),
        ),
    ];
    for (phase, completed) in phases {
        let ended = completed.unwrap_or(timing.completed);
        observer.record_guest_connection_phase(
            phase,
            ended.duration_since(started),
            ended.saturating_duration_since(started.max(remaining_started)),
            completed.is_some(),
        );
        started = ended;
        if completed.is_none() {
            break;
        }
    }
    observer.record_guest_connection_phase(
        SandboxGuestConnectionPhase::TaskHandoff,
        observed.duration_since(timing.completed),
        observed.saturating_duration_since(timing.completed.max(remaining_started)),
        true,
    );
}
