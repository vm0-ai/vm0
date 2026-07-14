//! Bounded payload residency for resume-session history materialization.

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

use api_contracts::generated::constants::runners::RESUME_SESSION_HISTORY_MAX_BYTES;
#[cfg(test)]
use tokio::sync::Notify;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

use super::{RunnerError, RunnerResult};

const BUFFER_ADMISSION_CANCELLED: &str = "session history buffer admission cancelled";

#[derive(Clone)]
pub(super) struct SessionHistoryBufferPool {
    permits: Arc<Semaphore>,
    capacity_bytes: u32,
    #[cfg(test)]
    probe: Option<SessionHistoryBufferTestProbe>,
}

#[cfg(test)]
#[derive(Clone, Default)]
struct SessionHistoryBufferTestProbe {
    submissions: Arc<AtomicUsize>,
    changed: Arc<Notify>,
}

#[derive(Clone, Copy)]
pub(super) struct SessionHistoryBufferClaim {
    peak_bytes: u32,
    retained_bytes: u32,
}

pub(super) struct SessionHistoryBufferAdmission {
    pub(super) elapsed: Duration,
    pub(super) result: RunnerResult<SessionHistoryBufferReservation>,
}

pub(super) struct SessionHistoryBufferReservation {
    permit: OwnedSemaphorePermit,
    retained_bytes: u32,
}

pub(super) struct SessionHistoryBufferLease {
    permit: OwnedSemaphorePermit,
}

impl SessionHistoryBufferPool {
    pub(super) fn for_cpu_capacity(cpu_capacity: usize) -> Self {
        let capacity_bytes = RESUME_SESSION_HISTORY_MAX_BYTES
            .saturating_mul(cpu_capacity.max(1).saturating_add(1) as u64);
        Self::with_capacity_bytes(capacity_bytes)
    }

    fn with_capacity_bytes(capacity_bytes: u64) -> Self {
        let capacity_bytes = capacity_bytes.clamp(1, u32::MAX as u64) as u32;
        Self {
            permits: Arc::new(Semaphore::new(capacity_bytes as usize)),
            capacity_bytes,
            #[cfg(test)]
            probe: None,
        }
    }

    #[cfg(test)]
    pub(super) fn with_test_capacity(capacity_bytes: u32) -> Self {
        let mut pool = Self::with_capacity_bytes(capacity_bytes as u64);
        pool.probe = Some(SessionHistoryBufferTestProbe::default());
        pool
    }

    #[cfg(test)]
    pub(super) async fn wait_for_submissions(&self, expected: usize) {
        let probe = self
            .probe
            .as_ref()
            .expect("session history buffer test probe should be configured");
        loop {
            if probe.submissions.load(Ordering::Acquire) >= expected {
                return;
            }
            let changed = probe.changed.notified();
            if probe.submissions.load(Ordering::Acquire) >= expected {
                return;
            }
            changed.await;
        }
    }

    pub(super) async fn acquire(
        &self,
        claim: SessionHistoryBufferClaim,
        cancel: &CancellationToken,
    ) -> SessionHistoryBufferAdmission {
        let started_at = Instant::now();
        #[cfg(test)]
        if let Some(probe) = &self.probe {
            probe.submissions.fetch_add(1, Ordering::Release);
            probe.changed.notify_waiters();
        }
        if claim.peak_bytes > self.capacity_bytes {
            return SessionHistoryBufferAdmission {
                elapsed: started_at.elapsed(),
                result: Err(RunnerError::Internal(format!(
                    "session history buffer claim is too large: {} bytes exceeds {} bytes",
                    claim.peak_bytes, self.capacity_bytes
                ))),
            };
        }
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(buffer_admission_cancelled_error()),
            permit = Arc::clone(&self.permits).acquire_many_owned(claim.peak_bytes) => {
                permit
                    .map(|permit| SessionHistoryBufferReservation {
                        permit,
                        retained_bytes: claim.retained_bytes,
                    })
                    .map_err(|error| RunnerError::Internal(format!(
                        "acquire session history buffer capacity: {error}"
                    )))
            }
        };
        SessionHistoryBufferAdmission {
            elapsed: started_at.elapsed(),
            result,
        }
    }
}

impl SessionHistoryBufferClaim {
    /// Account for a reqwest chunk copied into the destination and the later
    /// representation-specific CPU peak. The incoming chunk can be as large
    /// as the valid encoded body, so the larger of encoded and raw is charged
    /// in addition to the encoded destination.
    pub(super) fn remote_decoded(encoded_bytes: u64, raw_bytes: u64) -> RunnerResult<Self> {
        Self::remote(encoded_bytes, raw_bytes, raw_bytes)
    }

    pub(super) fn remote_preserved(encoded_bytes: u64, raw_bytes: u64) -> RunnerResult<Self> {
        Self::remote(encoded_bytes, raw_bytes, encoded_bytes)
    }

    pub(super) fn sidecar_raw(raw_bytes: u64) -> RunnerResult<Self> {
        Self::new(raw_bytes, raw_bytes)
    }

    pub(super) fn sidecar_preserved(encoded_bytes: u64, raw_bytes: u64) -> RunnerResult<Self> {
        let peak_bytes = encoded_bytes.checked_add(raw_bytes).ok_or_else(|| {
            RunnerError::Internal("session history sidecar buffer claim overflow".into())
        })?;
        Self::new(peak_bytes, encoded_bytes)
    }

    fn remote(encoded_bytes: u64, raw_bytes: u64, retained_bytes: u64) -> RunnerResult<Self> {
        let peak_bytes = encoded_bytes
            .checked_add(encoded_bytes.max(raw_bytes))
            .ok_or_else(|| {
                RunnerError::Internal("session history remote buffer claim overflow".into())
            })?;
        Self::new(peak_bytes, retained_bytes)
    }

    fn new(peak_bytes: u64, retained_bytes: u64) -> RunnerResult<Self> {
        if peak_bytes == 0 || retained_bytes == 0 {
            return Err(RunnerError::Internal(
                "session history buffer claim must be positive".into(),
            ));
        }
        let peak_bytes = u32::try_from(peak_bytes).map_err(|_| {
            RunnerError::Internal("session history buffer peak exceeds semaphore range".into())
        })?;
        let retained_bytes = u32::try_from(retained_bytes).map_err(|_| {
            RunnerError::Internal("session history retained buffer exceeds semaphore range".into())
        })?;
        if retained_bytes > peak_bytes {
            return Err(RunnerError::Internal(
                "session history retained buffer exceeds peak claim".into(),
            ));
        }
        Ok(Self {
            peak_bytes,
            retained_bytes,
        })
    }
}

impl SessionHistoryBufferReservation {
    pub(super) fn into_retained_lease(mut self) -> RunnerResult<SessionHistoryBufferLease> {
        let reserved_bytes = self.permit.num_permits();
        let retained_bytes = self.retained_bytes as usize;
        let release_bytes = reserved_bytes.checked_sub(retained_bytes).ok_or_else(|| {
            RunnerError::Internal(
                "session history retained buffer exceeds acquired capacity".into(),
            )
        })?;
        if release_bytes > 0 {
            let released = self.permit.split(release_bytes).ok_or_else(|| {
                RunnerError::Internal("split session history buffer reservation".into())
            })?;
            drop(released);
        }
        Ok(SessionHistoryBufferLease {
            permit: self.permit,
        })
    }
}

impl fmt::Debug for SessionHistoryBufferLease {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionHistoryBufferLease")
            .field("bytes", &self.permit.num_permits())
            .finish()
    }
}

fn buffer_admission_cancelled_error() -> RunnerError {
    RunnerError::Internal(BUFFER_ADMISSION_CANCELLED.into())
}
