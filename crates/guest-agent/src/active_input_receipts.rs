//! Durable active-input acceptance persistence and direct receipt delivery.

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use api_contracts::generated::types::runners::runs::active_inputs::receipt::Response;
use guest_common::{log_info, log_warn};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::constants;
use crate::http::HttpClient;

const LOG_TAG: &str = "sandbox:guest-agent";

#[derive(Debug)]
struct ReceiptJournalState {
    outstanding: Vec<String>,
}

#[derive(Debug)]
struct ReceiptJournal {
    run_id: String,
    path: PathBuf,
    state: Mutex<ReceiptJournalState>,
}

impl ReceiptJournal {
    fn load(run_id: &str, path: PathBuf) -> io::Result<Self> {
        let outstanding =
            guest_contracts::active_input_receipts::read_active_input_receipt_journal(
                &path, run_id,
            )?;
        Ok(Self {
            run_id: run_id.to_owned(),
            path,
            state: Mutex::new(ReceiptJournalState { outstanding }),
        })
    }

    fn outstanding(&self) -> Vec<String> {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .outstanding
            .clone()
    }

    fn persist_acceptance(&self, delivery_id: &str) -> io::Result<()> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.outstanding.iter().any(|id| id == delivery_id) {
            return Ok(());
        }
        let mut next = state.outstanding.clone();
        next.push(delivery_id.to_owned());
        guest_contracts::active_input_receipts::write_active_input_receipt_journal(
            &self.path,
            &self.run_id,
            &next,
        )?;
        state.outstanding = next;
        Ok(())
    }

    fn acknowledge(&self, delivery_id: &str) -> io::Result<()> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if !state.outstanding.iter().any(|id| id == delivery_id) {
            return Ok(());
        }
        let next = state
            .outstanding
            .iter()
            .filter(|id| id.as_str() != delivery_id)
            .cloned()
            .collect::<Vec<_>>();
        guest_contracts::active_input_receipts::write_active_input_receipt_journal(
            &self.path,
            &self.run_id,
            &next,
        )?;
        state.outstanding = next;
        Ok(())
    }
}

/// Run-scoped receipt persistence and its single serial HTTP worker.
pub(crate) struct ActiveInputReceiptRuntime {
    journal: Arc<ReceiptJournal>,
    upload_tx: mpsc::UnboundedSender<String>,
    finalize_tx: watch::Sender<bool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl std::fmt::Debug for ActiveInputReceiptRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ActiveInputReceiptRuntime")
            .field("run_id", &self.journal.run_id)
            .field("path", &self.journal.path)
            .finish_non_exhaustive()
    }
}

impl ActiveInputReceiptRuntime {
    pub(crate) fn start(
        run_id: &str,
        path: impl AsRef<Path>,
        http: HttpClient,
    ) -> io::Result<(Self, Vec<String>)> {
        let journal = Arc::new(ReceiptJournal::load(run_id, path.as_ref().to_path_buf())?);
        let recovered = journal.outstanding();
        let (upload_tx, upload_rx) = mpsc::unbounded_channel();
        let (finalize_tx, finalize_rx) = watch::channel(false);
        let worker = tokio::runtime::Handle::try_current()
            .map_err(|error| io::Error::other(format!("active-input receipt runtime: {error}")))?
            .spawn(receipt_worker(
                run_id.to_owned(),
                http,
                journal.clone(),
                upload_rx,
                finalize_rx,
            ));
        for delivery_id in &recovered {
            let _ = upload_tx.send(delivery_id.clone());
        }
        Ok((
            Self {
                journal,
                upload_tx,
                finalize_tx,
                worker: Mutex::new(Some(worker)),
            },
            recovered,
        ))
    }

    pub(crate) fn persist_acceptance(&self, delivery_id: &str) -> io::Result<()> {
        self.journal.persist_acceptance(delivery_id)?;
        let _ = self.upload_tx.send(delivery_id.to_owned());
        Ok(())
    }

    pub(crate) async fn finalize(&self) {
        let _ = self.finalize_tx.send(true);
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        let Some(mut worker) = worker else {
            return;
        };
        let timeout = Duration::from_secs(
            constants::ACTIVE_INPUT_RECEIPT_TIMEOUT_SECS
                + constants::ACTIVE_INPUT_RECEIPT_FINALIZE_TIMEOUT_SECS
                + 1,
        );
        if tokio::time::timeout(timeout, &mut worker).await.is_err() {
            worker.abort();
            let _ = worker.await;
            log_warn!(
                LOG_TAG,
                "Active-input receipt worker exceeded its finalization budget"
            );
        }
    }
}

async fn deliver_receipt(
    run_id: &str,
    delivery_id: &str,
    http: &HttpClient,
    journal: &ReceiptJournal,
    rejected: &mut HashSet<String>,
) {
    if !http.has_api() {
        return;
    }
    match http.post_active_input_receipt(run_id, delivery_id).await {
        Ok(Response::Delivered) => match journal.acknowledge(delivery_id) {
            Ok(()) => log_info!(
                LOG_TAG,
                "Active-input receipt acknowledged: delivery_id={delivery_id}"
            ),
            Err(error) => log_warn!(
                LOG_TAG,
                "Active-input receipt journal compaction failed: delivery_id={delivery_id} error={error}"
            ),
        },
        Ok(Response::Rejected) => {
            rejected.insert(delivery_id.to_owned());
            log_warn!(
                LOG_TAG,
                "Active-input receipt rejected: delivery_id={delivery_id}"
            );
        }
        Err(error) => log_warn!(
            LOG_TAG,
            "Active-input receipt attempt failed: delivery_id={delivery_id} error={error}"
        ),
    }
}

async fn finalize_outstanding(
    run_id: &str,
    http: &HttpClient,
    journal: &ReceiptJournal,
    rejected: &mut HashSet<String>,
) {
    let deadline = tokio::time::Instant::now()
        + Duration::from_secs(constants::ACTIVE_INPUT_RECEIPT_FINALIZE_TIMEOUT_SECS);
    for delivery_id in journal.outstanding() {
        if rejected.contains(&delivery_id) {
            continue;
        }
        if tokio::time::timeout_at(
            deadline,
            deliver_receipt(run_id, &delivery_id, http, journal, rejected),
        )
        .await
        .is_err()
        {
            log_warn!(
                LOG_TAG,
                "Active-input receipt finalization deadline reached"
            );
            break;
        }
    }
}

async fn receipt_worker(
    run_id: String,
    http: HttpClient,
    journal: Arc<ReceiptJournal>,
    mut upload_rx: mpsc::UnboundedReceiver<String>,
    mut finalize_rx: watch::Receiver<bool>,
) {
    let mut rejected = HashSet::new();
    loop {
        tokio::select! {
            biased;
            changed = finalize_rx.changed() => {
                if changed.is_err() || *finalize_rx.borrow() {
                    break;
                }
            }
            delivery_id = upload_rx.recv() => {
                let Some(delivery_id) = delivery_id else {
                    break;
                };
                if !rejected.contains(&delivery_id) {
                    deliver_receipt(&run_id, &delivery_id, &http, &journal, &mut rejected).await;
                }
            }
        }
    }
    finalize_outstanding(&run_id, &http, &journal, &mut rejected).await;
}
