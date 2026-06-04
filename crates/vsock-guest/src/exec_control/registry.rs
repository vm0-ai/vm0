use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use vsock_proto::{ExecControlNonce, ExecControlStatus};

use super::accept::start_control_sink_accept_thread;
use super::sink::ControlSinkState;
use super::{
    EXEC_CONTROL_SINK_NOT_CONFIGURED_MESSAGE, EXEC_OPERATION_ALREADY_ACTIVE_MESSAGE,
    EXEC_OPERATION_INACTIVE_MESSAGE, EXEC_OPERATION_NONCE_MISMATCH_MESSAGE,
    ExecControlRegistration,
};

#[derive(Clone)]
pub(crate) struct ExecControlRegistry {
    inner: Arc<Mutex<HashMap<u32, ExecControlEntry>>>,
}

impl Default for ExecControlRegistry {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

struct ExecControlEntry {
    nonce: ExecControlNonce,
    sink: Option<Arc<ControlSinkState>>,
}

pub(crate) struct ExecControlGuard {
    registry: ExecControlRegistry,
    seq: u32,
    released: AtomicBool,
}

impl ExecControlRegistry {
    pub(crate) fn register(
        &self,
        seq: u32,
        control_nonce: ExecControlNonce,
        control_sink: bool,
    ) -> io::Result<ExecControlRegistration> {
        let (bootstrap_endpoint, accept_sink) = if control_sink {
            let endpoint = process_control_ipc::endpoint_name(seq, &control_nonce);
            let sink = Arc::new(ControlSinkState::new());
            self.insert(
                seq,
                ExecControlEntry {
                    nonce: control_nonce,
                    sink: Some(Arc::clone(&sink)),
                },
            )?;
            (Some(endpoint), Some(sink))
        } else {
            self.insert(
                seq,
                ExecControlEntry {
                    nonce: control_nonce,
                    sink: None,
                },
            )?;
            (None, None)
        };

        let start_result = match (&bootstrap_endpoint, accept_sink) {
            (Some(endpoint), Some(sink)) => start_control_sink_accept_thread(endpoint, sink),
            _ => Ok(()),
        };
        if let Err(error) = start_result {
            self.remove(seq);
            return Err(error);
        }

        Ok(ExecControlRegistration {
            guard: ExecControlGuard {
                registry: self.clone(),
                seq,
                released: AtomicBool::new(false),
            },
            bootstrap_endpoint,
        })
    }

    fn insert(&self, seq: u32, entry: ExecControlEntry) -> io::Result<()> {
        let mut active = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if active.contains_key(&seq) {
            return Err(operation_already_active_error());
        }
        active.insert(seq, entry);
        Ok(())
    }

    fn remove(&self, seq: u32) {
        let entry = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&seq);
        if let Some(entry) = entry {
            entry.close();
        }
    }

    pub(super) fn resolve(
        &self,
        target_seq: u32,
        control_nonce: ExecControlNonce,
    ) -> Result<Arc<ControlSinkState>, (ExecControlStatus, &'static str)> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = guard.get(&target_seq) else {
            return Err((ExecControlStatus::Inactive, EXEC_OPERATION_INACTIVE_MESSAGE));
        };
        if entry.nonce != control_nonce {
            return Err((
                ExecControlStatus::NonceMismatch,
                EXEC_OPERATION_NONCE_MISMATCH_MESSAGE,
            ));
        }
        let Some(sink) = &entry.sink else {
            return Err((
                ExecControlStatus::Unsupported,
                EXEC_CONTROL_SINK_NOT_CONFIGURED_MESSAGE,
            ));
        };
        Ok(Arc::clone(sink))
    }
}

impl ExecControlEntry {
    fn close(self) {
        if let Some(sink) = self.sink {
            sink.close();
        }
    }
}

fn operation_already_active_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::AlreadyExists,
        EXEC_OPERATION_ALREADY_ACTIVE_MESSAGE,
    )
}

impl ExecControlGuard {
    pub(crate) fn release(&self) {
        self.release_once();
    }

    fn release_once(&self) {
        if !self.released.swap(true, Ordering::AcqRel) {
            self.registry.remove(self.seq);
        }
    }
}

impl Drop for ExecControlGuard {
    fn drop(&mut self) {
        self.release_once();
    }
}
