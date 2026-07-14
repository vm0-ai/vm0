//! Shared CPU and payload resources for session-history materialization.

use tokio_util::sync::CancellationToken;

use super::RunnerResult;
use super::session_history_buffer::{
    SessionHistoryBufferAdmission, SessionHistoryBufferClaim, SessionHistoryBufferPool,
};
use super::session_history_cpu::{
    SessionHistoryCpuJob, SessionHistoryCpuOutcome, SessionHistoryCpuPool,
};

#[derive(Clone)]
pub(crate) struct SessionHistoryMaterializationResources {
    cpu: SessionHistoryCpuPool,
    buffers: SessionHistoryBufferPool,
}

impl SessionHistoryMaterializationResources {
    pub(crate) fn for_host_cpus(host_cpus: usize) -> Self {
        let cpu_capacity = (host_cpus / 2).clamp(1, 4);
        Self {
            cpu: SessionHistoryCpuPool::with_capacity(cpu_capacity),
            buffers: SessionHistoryBufferPool::for_cpu_capacity(cpu_capacity),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_test_capacities(cpu_capacity: usize, buffer_capacity_bytes: u32) -> Self {
        Self {
            cpu: SessionHistoryCpuPool::with_capacity(cpu_capacity),
            buffers: SessionHistoryBufferPool::with_test_capacity(buffer_capacity_bytes),
        }
    }

    #[cfg(test)]
    pub(crate) async fn wait_for_buffer_submissions(&self, expected: usize) {
        self.buffers.wait_for_submissions(expected).await;
    }

    pub(super) async fn acquire_buffer(
        &self,
        claim: SessionHistoryBufferClaim,
        cancel: &CancellationToken,
    ) -> SessionHistoryBufferAdmission {
        self.buffers.acquire(claim, cancel).await
    }

    pub(super) async fn materialize(
        &self,
        job: SessionHistoryCpuJob,
        cancel: &CancellationToken,
    ) -> RunnerResult<SessionHistoryCpuOutcome> {
        self.cpu.materialize(job, cancel).await
    }
}
