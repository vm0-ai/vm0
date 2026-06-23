//! Process-group signaling for guest-agent CLI children.
//!
//! Callers construct these values only for children spawned with
//! `Command::process_group(0)`, where the child PID is also the process-group
//! ID. This module owns the unsafe `kill(-pgid, signal)` boundary; it does not
//! own child lifecycle, wait, drain, or termination policy.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ChildProcessGroup {
    pgid: i32,
}

impl ChildProcessGroup {
    pub(super) fn from_child_id(child_id: Option<u32>) -> Option<Self> {
        child_id.and_then(Self::from_raw_child_id)
    }

    fn from_raw_child_id(child_id: u32) -> Option<Self> {
        let pgid = i32::try_from(child_id).ok()?;
        Self::from_raw_pgid(pgid)
    }

    fn from_raw_pgid(pgid: i32) -> Option<Self> {
        is_signalable_child_pgid(pgid).then_some(Self { pgid })
    }

    pub(super) fn raw_pgid(self) -> i32 {
        self.pgid
    }

    pub(super) fn sigterm(self) {
        self.signal(libc::SIGTERM);
    }

    pub(super) fn sigkill(self) {
        self.signal(libc::SIGKILL);
    }

    fn signal(self, signal: libc::c_int) {
        // Best-effort by design: ESRCH is expected if the child exits between
        // the caller's state check and this signal, and other failures are not
        // recoverable inside guest-agent.
        unsafe {
            libc::kill(-self.pgid, signal);
        }
    }
}

pub(super) struct ProcessGroupKillGuard {
    process_group: Option<ChildProcessGroup>,
}

impl ProcessGroupKillGuard {
    pub(super) fn new(process_group: Option<ChildProcessGroup>) -> Self {
        Self { process_group }
    }

    pub(super) fn disarm(&mut self) {
        self.process_group = None;
    }
}

impl Drop for ProcessGroupKillGuard {
    fn drop(&mut self) {
        if let Some(process_group) = self.process_group {
            process_group.sigkill();
        }
    }
}

fn is_signalable_child_pgid(pgid: i32) -> bool {
    pgid > 1 && pgid != current_process_group()
}

fn current_process_group() -> i32 {
    unsafe { libc::getpgrp() }
}

#[cfg(test)]
mod tests {
    use super::ChildProcessGroup;

    #[test]
    fn child_process_group_rejects_dangerous_pgids() {
        assert_eq!(ChildProcessGroup::from_raw_pgid(-1), None);
        assert_eq!(ChildProcessGroup::from_raw_pgid(0), None);
        assert_eq!(ChildProcessGroup::from_raw_pgid(1), None);
    }

    #[test]
    fn child_process_group_rejects_current_process_group() {
        let current_pgid = super::current_process_group();

        assert_eq!(ChildProcessGroup::from_raw_pgid(current_pgid), None);
    }

    #[test]
    fn child_process_group_preserves_signalable_child_id() {
        let current_pgid = super::current_process_group();
        let child_id = if current_pgid == 42 { 43 } else { 42 };

        let process_group =
            ChildProcessGroup::from_raw_pgid(child_id).expect("signalable process group");

        assert_eq!(process_group.raw_pgid(), child_id);
    }

    #[test]
    fn child_process_group_rejects_child_id_overflow() {
        let overflowing_child_id = (i32::MAX as u32).saturating_add(1);

        assert_eq!(
            ChildProcessGroup::from_child_id(Some(overflowing_child_id)),
            None
        );
    }
}
