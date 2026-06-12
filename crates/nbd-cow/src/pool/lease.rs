#[cfg(test)]
use std::path::Path;

use crate::device_lock::NbdDeviceClaim;
use tokio::sync::{mpsc, oneshot};

use super::actor::{DevicePoolCommand, LeaseReturnAction};

/// Owned authority for a checked-out NBD device.
///
/// This is intentionally move-only: releasing, discarding, or retiring the
/// device must consume the lease, which owns the underlying `NbdDeviceClaim`.
/// The copied device index is only diagnostic metadata, not pool authority.
pub struct DeviceLease {
    index: u32,
    claim: Option<NbdDeviceClaim>,
    return_to: Option<mpsc::UnboundedSender<DevicePoolCommand>>,
}

impl DeviceLease {
    pub(super) fn new(claim: NbdDeviceClaim) -> Self {
        let index = claim.index();
        Self {
            index,
            claim: Some(claim),
            return_to: None,
        }
    }

    pub(super) fn with_return(
        claim: NbdDeviceClaim,
        return_to: mpsc::UnboundedSender<DevicePoolCommand>,
    ) -> Self {
        let index = claim.index();
        Self {
            index,
            claim: Some(claim),
            return_to: Some(return_to),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(index: u32, lock_dir: &Path) -> Self {
        Self::new(NbdDeviceClaim::new_for_test(index, lock_dir))
    }

    /// NBD device index (N in `/dev/nbdN`).
    pub fn index(&self) -> u32 {
        self.index
    }

    pub(super) fn into_claim(mut self) -> Option<NbdDeviceClaim> {
        self.return_to.take();
        self.claim.take()
    }
}

impl Drop for DeviceLease {
    fn drop(&mut self) {
        let Some(return_to) = self.return_to.take() else {
            return;
        };
        let Some(claim) = self.claim.take() else {
            return;
        };
        let index = claim.index();
        let (done, _done_rx) = oneshot::channel();
        if return_to
            .send(DevicePoolCommand::ReturnLease {
                action: LeaseReturnAction::RetireUncertain,
                claim,
                done,
            })
            .is_err()
        {
            tracing::warn!(
                device_index = index,
                "device pool actor stopped before dropped lease could be retired"
            );
        }
    }
}
