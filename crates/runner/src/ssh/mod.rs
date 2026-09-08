//! Official Runner-owned, one-shot SSH dispatch. No guest-supplied authority.

mod authority;
mod engine;
mod io;
mod keys;
mod network;
mod output;
#[cfg(test)]
mod tests;

use runner_rpc_proto::{Delivery, ErrorCode, Response, ResponseWriter};
use sandbox::{AcceptedGuestRpc, GuestRpcAcceptor, Sandbox};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
use tokio::{
    sync::Semaphore,
    task::{JoinHandle, JoinSet},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

use crate::{http::HttpClient, ids::RunId, runner_process_identity::RunnerProcessIdentity};
use authority::Authority;
use io::{GuestIo, Lease};
use network::{Network, PublicNetwork};

const SANDBOX_CAPACITY: usize = 2;
const RUNNER_CAPACITY: usize = 16;
const TERMINAL_RESERVE: Duration = Duration::from_secs(1);

/// Only allow-listed business codes cross the guest/log boundary.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum FailureReason {
    Unavailable,
    AuthorityFailure,
    InvalidCredential,
    UnsupportedCredential,
    CredentialResourceLimit,
    UnsafeDestination,
    NetworkFailure,
    HostKeyMismatch,
    UnsupportedHostKey,
    ConfigurationChanged,
    AuthenticationFailed,
    Protocol,
    ExecRejected,
    Disconnected,
    TimedOut,
    Cancelled,
    ResourceExhausted,
    Transport,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Params {
    ssh_connection_id: String,
    command: String,
}

struct ExecRequest {
    run: RunId,
    connection: uuid::Uuid,
    command: String,
}

pub(crate) struct SshRuntime {
    authority: Arc<Authority>,
    network: Arc<dyn Network>,
    permits: Arc<Semaphore>,
    cpu: Arc<Semaphore>,
}

impl SshRuntime {
    pub(crate) fn official(
        http: HttpClient,
        token: &str,
        identity: RunnerProcessIdentity,
    ) -> Result<Option<Arc<Self>>, crate::error::RunnerError> {
        use api_contracts::generated::constants::runners::OFFICIAL_RUNNER_TOKEN_PREFIX;
        if !token.starts_with(OFFICIAL_RUNNER_TOKEN_PREFIX) {
            return Ok(None);
        }
        // The prefix only selects transport. Every API call authenticates the
        // actual fleet secret and exact current winning claim independently.
        let authority = Authority::new(http, token.to_owned(), identity).map_err(|_| {
            crate::error::RunnerError::Internal("SSH authority client initialization failed".into())
        })?;
        Ok(Some(Arc::new(Self {
            authority: Arc::new(authority),
            network: Arc::new(PublicNetwork),
            permits: Arc::new(Semaphore::new(RUNNER_CAPACITY)),
            cpu: Arc::new(Semaphore::new(2)),
        })))
    }

    pub(crate) fn install(
        self: &Arc<Self>,
        sandbox: &dyn Sandbox,
        run: RunId,
        cancel: &CancellationToken,
    ) -> Option<SshRun> {
        let acceptor = sandbox.guest_rpc(&run.to_string())?;
        Some(self.start(acceptor, sandbox.id().to_string(), run, cancel))
    }

    fn start(
        self: &Arc<Self>,
        acceptor: Arc<dyn GuestRpcAcceptor>,
        sandbox: String,
        run: RunId,
        cancel: &CancellationToken,
    ) -> SshRun {
        let cancel = cancel.child_token();
        let runtime = Arc::clone(self);
        let task_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            runtime.serve(acceptor, sandbox, run, task_cancel).await;
        });
        SshRun {
            cancel,
            task: Some(task),
        }
    }

    async fn serve(
        self: Arc<Self>,
        acceptor: Arc<dyn GuestRpcAcceptor>,
        sandbox: String,
        run: RunId,
        cancel: CancellationToken,
    ) {
        let permits = Arc::new(Semaphore::new(SANDBOX_CAPACITY));
        let mut tasks = JoinSet::new();
        loop {
            let accepted = tokio::select! {
                biased;
                () = cancel.cancelled() => break,
                result = tasks.join_next(), if !tasks.is_empty() => {
                    if result.is_some_and(|result| result.is_err()) { tracing::warn!(run_id = %run, "SSH request task failed"); }
                    continue;
                }
                result = acceptor.accept() => match result { Ok(accepted) => accepted, Err(_) => break },
            };
            if accepted.sandbox_id != sandbox {
                continue;
            }
            let (Ok(local), Ok(global)) = (
                Arc::clone(&permits).try_acquire_owned(),
                Arc::clone(&self.permits).try_acquire_owned(),
            ) else {
                tracing::info!(run_id = %run, sandbox_id = %sandbox, outcome = "resource_exhausted", "SSH admission rejected");
                reject(accepted, ErrorCode::ResourceExhausted, &cancel).await;
                continue;
            };
            let runtime = Arc::clone(&self);
            let scope = Scope {
                cancelled: cancel.child_token(),
                sandbox_cancelled: accepted.cancelled,
                deadline: Instant::now() + Duration::from_secs(60),
            };
            let lease = Arc::new(Lease::new(accepted.stream, local, global));
            tasks.spawn(async move {
                runtime.dispatch(lease, run, scope).await;
            });
        }
        cancel.cancel();
        while tasks.join_next().await.is_some() {}
    }

    async fn dispatch(self: Arc<Self>, lease: Arc<Lease>, run: RunId, mut scope: Scope) {
        let _cancel_on_drop = scope.cancelled.clone().drop_guard();
        let started = Instant::now();
        let mut input = GuestIo(Arc::clone(&lease));
        let request = scope.wait(runner_rpc_proto::read_request(&mut input)).await;
        let mut writer = ResponseWriter::new(input);
        let request = match request {
            Ok(Ok(request)) => request,
            _ => {
                send_generic(&scope, &mut writer, ErrorCode::InvalidRequest).await;
                return;
            }
        };
        if request.method != "ssh.exec" {
            send_generic(&scope, &mut writer, ErrorCode::UnknownMethod).await;
            return;
        }
        let Some(remaining) = request.remaining_ms.filter(|ms| *ms > 1000) else {
            send_generic(&scope, &mut writer, ErrorCode::InvalidRequest).await;
            return;
        };
        scope.deadline = scope
            .deadline
            .min(started + Duration::from_millis(remaining.min(60_000)));
        let work = Scope {
            deadline: scope.deadline - TERMINAL_RESERVE,
            ..scope.clone()
        };
        let params: Params = match serde_json::from_str(request.params.get()) {
            Ok(params) => params,
            Err(_) => {
                send_generic(&scope, &mut writer, ErrorCode::InvalidRequest).await;
                return;
            }
        };
        let connection = match uuid::Uuid::parse_str(&params.ssh_connection_id) {
            Ok(id) if params.ssh_connection_id.len() == 36 && params.command.len() <= 64 * 1024 => {
                id
            }
            _ => {
                send_generic(&scope, &mut writer, ErrorCode::InvalidRequest).await;
                return;
            }
        };
        let mut output = output::Output::default();
        let result = self
            .execute(
                Arc::clone(&lease),
                ExecRequest {
                    run,
                    connection,
                    command: params.command,
                },
                &work,
                &mut writer,
                &mut output,
            )
            .await;
        let outcome = output.terminal(result);
        // A poisoned writer cannot emit a replacement terminal after partial I/O.
        let terminal_scope = Scope {
            cancelled: CancellationToken::new(),
            deadline: scope.deadline.min(Instant::now() + TERMINAL_RESERVE),
            ..scope
        };
        let delivered = terminal_scope
            .wait(output.finish(&mut writer, outcome))
            .await
            .is_ok_and(|result| result.is_ok());
        tracing::info!(run_id = %run, connection_id = %connection, outcome = output.outcome(), failure_reason = ?output.failure(), elapsed_ms = started.elapsed().as_millis() as u64,
            stdout_bytes = output.stdout_bytes(), stderr_bytes = output.stderr_bytes(), stdout_truncated = output.stdout_truncated(), stderr_truncated = output.stderr_truncated(), terminal_delivered = delivered, "SSH execution finished");
    }

    async fn execute(
        &self,
        lease: Arc<Lease>,
        request: ExecRequest,
        scope: &Scope,
        writer: &mut ResponseWriter<GuestIo>,
        output: &mut output::Output,
    ) -> Result<output::RemoteExit, FailureReason> {
        let ExecRequest {
            run,
            connection,
            command,
        } = request;
        let credential = scope
            .wait(self.authority.resolve(run, connection))
            .await??;
        let cpu = Arc::clone(&self.cpu)
            .try_acquire_owned()
            .map_err(|_| FailureReason::ResourceExhausted)?;
        let worker_scope = scope.clone();
        let worker_lease = Arc::clone(&lease);
        let worker = tokio::task::spawn_blocking(move || {
            let _permit = cpu;
            let _lease = worker_lease;
            worker_scope.check()?;
            let key = keys::decode(
                credential.private_key.expose(),
                credential.passphrase.as_ref().map(|value| value.expose()),
            )?;
            worker_scope.check()?;
            Ok::<_, FailureReason>((credential, key))
        });
        let (credential, key) = scope
            .wait(worker)
            .await?
            .map_err(|_| FailureReason::InvalidCredential)??;
        // System DNS can own blocking resolver work after its waiter is dropped.
        // This task retains the real stream/permits until resolution completes.
        let network = Arc::clone(&self.network);
        let host = credential.host.clone();
        let port = credential.port;
        let resolver_lease = Arc::clone(&lease);
        let resolver = tokio::spawn(async move {
            let _lease = resolver_lease;
            network::destination(network, &host, port).await
        });
        let address = scope
            .wait(resolver)
            .await?
            .map_err(|_| FailureReason::NetworkFailure)??;
        let stream = scope
            .wait(self.network.connect(address))
            .await?
            .map_err(|_| FailureReason::NetworkFailure)?;
        engine::Execution {
            authority: Arc::clone(&self.authority),
            run,
            connection,
            lease,
            credential,
            key,
        }
        .execute(stream, command, scope, writer, output)
        .await
    }
}

#[derive(Clone)]
struct Scope {
    cancelled: CancellationToken,
    sandbox_cancelled: CancellationToken,
    deadline: Instant,
}

impl Scope {
    fn check(&self) -> Result<(), FailureReason> {
        if self.cancelled.is_cancelled() || self.sandbox_cancelled.is_cancelled() {
            Err(FailureReason::Cancelled)
        } else if Instant::now() >= self.deadline {
            Err(FailureReason::TimedOut)
        } else {
            Ok(())
        }
    }
    async fn wait<T>(
        &self,
        future: impl std::future::Future<Output = T>,
    ) -> Result<T, FailureReason> {
        use futures_util::FutureExt;
        self.check()?;
        let mut future = std::pin::pin!(future);
        // Most tiny output fragments are already buffered. Avoid registering
        // timers and cancellation waiters for every immediately-ready fragment.
        // Keep the same pinned future if I/O blocks; partial writes never restart.
        if let Some(result) = future.as_mut().now_or_never() {
            return Ok(result);
        }
        tokio::select! { biased;
            () = self.cancelled.cancelled() => Err(FailureReason::Cancelled),
            () = self.sandbox_cancelled.cancelled() => Err(FailureReason::Cancelled),
            () = tokio::time::sleep_until(self.deadline) => Err(FailureReason::TimedOut),
            result = future => Ok(result),
        }
    }
}

pub(crate) struct SshRun {
    cancel: CancellationToken,
    task: Option<JoinHandle<()>>,
}
impl SshRun {
    pub(crate) async fn shutdown(mut self) {
        self.cancel.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}
impl Drop for SshRun {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

async fn send_generic(scope: &Scope, writer: &mut ResponseWriter<GuestIo>, code: ErrorCode) {
    let _ = scope
        .wait(writer.send(&Response::error(code, Delivery::NotDispatched)))
        .await;
}
async fn reject(accepted: AcceptedGuestRpc, code: ErrorCode, cancel: &CancellationToken) {
    let scope = Scope {
        cancelled: cancel.clone(),
        sandbox_cancelled: accepted.cancelled,
        deadline: Instant::now() + Duration::from_millis(100),
    };
    let mut writer = ResponseWriter::new(accepted.stream);
    let _ = scope
        .wait(writer.send(&Response::error(code, Delivery::NotDispatched)))
        .await;
}

pub(crate) fn safe_log_metadata(metadata: &tracing::Metadata<'_>) -> bool {
    !["russh", "ssh_key", "ssh_cipher"].iter().any(|prefix| {
        metadata.target() == *prefix
            || metadata
                .target()
                .strip_prefix(prefix)
                .is_some_and(|suffix| suffix.starts_with("::"))
    })
}
