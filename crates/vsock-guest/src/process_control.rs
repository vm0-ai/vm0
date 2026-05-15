use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use vsock_proto::{MSG_PROCESS_CONTROL_RESULT, ProcessControlNonce, ProcessControlStatus};

use crate::error::to_io_error;
use crate::writer::GuestWriter;

#[derive(Clone, Default)]
pub(crate) struct ProcessControlRegistry {
    inner: Arc<Mutex<HashMap<u32, ProcessControlNonce>>>,
}

pub(crate) struct ProcessControlGuard {
    registry: ProcessControlRegistry,
    seq: u32,
    released: AtomicBool,
}

impl ProcessControlRegistry {
    pub(crate) fn register(
        &self,
        seq: u32,
        control_nonce: ProcessControlNonce,
    ) -> ProcessControlGuard {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(seq, control_nonce);
        ProcessControlGuard {
            registry: self.clone(),
            seq,
            released: AtomicBool::new(false),
        }
    }

    fn remove(&self, seq: u32) {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&seq);
    }

    #[cfg(test)]
    pub(crate) fn contains(&self, seq: u32) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&seq)
    }

    fn status_for(
        &self,
        target_seq: u32,
        control_nonce: ProcessControlNonce,
    ) -> (ProcessControlStatus, &'static str) {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(expected_nonce) = guard.get(&target_seq) else {
            return (
                ProcessControlStatus::Inactive,
                "process operation is not active",
            );
        };
        if *expected_nonce != control_nonce {
            return (
                ProcessControlStatus::NonceMismatch,
                "process operation nonce mismatch",
            );
        }
        (
            ProcessControlStatus::Unsupported,
            "process control sink is not configured",
        )
    }
}

impl ProcessControlGuard {
    pub(crate) fn release(&self) {
        if !self.released.swap(true, Ordering::AcqRel) {
            self.registry.remove(self.seq);
        }
    }
}

impl Drop for ProcessControlGuard {
    fn drop(&mut self) {
        if !self.released.swap(true, Ordering::AcqRel) {
            self.registry.remove(self.seq);
        }
    }
}

pub(crate) fn handle_process_control(
    seq: u32,
    payload: &[u8],
    registry: &ProcessControlRegistry,
    writer: &GuestWriter,
) -> io::Result<()> {
    let request = vsock_proto::decode_process_control(payload).map_err(to_io_error)?;
    writer.write_generated_frame_after_lock(|| {
        let (status, diagnostic) = registry.status_for(request.target_seq, request.control_nonce);
        let result_payload = vsock_proto::encode_process_control_result(
            request.target_seq,
            request.control_nonce,
            request.message_id,
            status,
            diagnostic,
        )
        .map_err(to_io_error)?;
        vsock_proto::encode(MSG_PROCESS_CONTROL_RESULT, seq, &result_payload).map_err(to_io_error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: ProcessControlNonce = *b"0123456789abcdef";

    #[test]
    fn registered_operation_rejects_nonce_mismatch() {
        let registry = ProcessControlRegistry::default();
        let _guard = registry.register(7, NONCE);
        let wrong_nonce = *b"fedcba9876543210";

        let (status, diagnostic) = registry.status_for(7, wrong_nonce);

        assert_eq!(status, ProcessControlStatus::NonceMismatch);
        assert_eq!(diagnostic, "process operation nonce mismatch");
    }

    #[test]
    fn released_operation_is_inactive() {
        let registry = ProcessControlRegistry::default();
        let guard = registry.register(7, NONCE);

        guard.release();
        let (status, diagnostic) = registry.status_for(7, NONCE);

        assert_eq!(status, ProcessControlStatus::Inactive);
        assert_eq!(diagnostic, "process operation is not active");
    }

    #[test]
    fn valid_operation_is_currently_unsupported_until_sink_is_wired() {
        let registry = ProcessControlRegistry::default();
        let _guard = registry.register(7, NONCE);

        let (status, diagnostic) = registry.status_for(7, NONCE);

        assert_eq!(status, ProcessControlStatus::Unsupported);
        assert_eq!(diagnostic, "process control sink is not configured");
    }
}
