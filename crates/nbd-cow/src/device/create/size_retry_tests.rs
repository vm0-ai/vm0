use std::future::{Future, poll_fn};
use std::io::Read;
use std::os::unix::net::UnixStream as StdUnixStream;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::Poll;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};

use super::*;
use crate::device::connection::DeviceOwnership;
use crate::device::create_timing::NbdCowCreateOutcome;
use crate::device_lock::try_acquire_device_claim_in;
use crate::protocol_impl::{self as protocol, Command, NbdReply, NbdRequest};

const DEVICE_SIZE: u64 = 4096;

#[derive(Clone, Copy)]
enum Cleanup {
    Clean,
    Foreign,
    Unknown,
    DisconnectError,
}

struct Attempt {
    index: u32,
    connection_id: Uuid,
    peers: Vec<StdUnixStream>,
    dispatch_closed_before_cleanup: bool,
    disconnect_calls: usize,
}

struct Verification {
    index: u32,
    respond: oneshot::Sender<bool>,
}

#[derive(Clone)]
struct ControlledKernel {
    attempts: Arc<Mutex<Vec<Attempt>>>,
    verifications: mpsc::UnboundedSender<Verification>,
    cleanup: Cleanup,
}

impl CreateKernel for ControlledKernel {
    fn connect(
        &self,
        device_index: u32,
        client_fds: &[OwnedFd],
        size: u64,
        block_size: u64,
    ) -> (
        std::result::Result<netlink::ConnectDeviceSuccess, netlink::ConnectDeviceError>,
        NbdNetlinkConnectTiming,
    ) {
        assert_eq!(size, DEVICE_SIZE);
        assert_eq!(block_size, BLOCK_SIZE as u64);
        let connection_id = Uuid::new_v4();
        let peers = client_fds
            .iter()
            .map(|fd| {
                let peer = StdUnixStream::from(fd.try_clone().unwrap());
                peer.set_nonblocking(true).unwrap();
                peer
            })
            .collect();
        self.attempts.lock().unwrap().push(Attempt {
            index: device_index,
            connection_id,
            peers,
            dispatch_closed_before_cleanup: false,
            disconnect_calls: 0,
        });
        (
            Ok(netlink::ConnectDeviceSuccess { connection_id }),
            NbdNetlinkConnectTiming::default(),
        )
    }

    async fn verify_size(&self, device_index: u32, size: u64) -> bool {
        assert_eq!(size, DEVICE_SIZE);
        let (respond, response) = oneshot::channel();
        self.verifications
            .send(Verification {
                index: device_index,
                respond,
            })
            .unwrap();
        response.await.unwrap()
    }

    fn ownership(&self, device_index: u32, connection_id: Uuid) -> DeviceOwnership {
        let mut attempts = self.attempts.lock().unwrap();
        let attempt = attempts
            .iter_mut()
            .find(|a| a.index == device_index)
            .unwrap();
        if attempt.connection_id != connection_id {
            return DeviceOwnership::Foreign;
        }
        // Nonblocking EOF proves the real dispatch sockets were dropped before
        // production cleanup reached the kernel boundary. Do not wait for EOF:
        // doing so would hide a missing abort/join in the caller.
        attempt.dispatch_closed_before_cleanup = attempt
            .peers
            .iter_mut()
            .all(|peer| matches!(peer.read(&mut [0]), Ok(0)));
        match self.cleanup {
            Cleanup::Clean | Cleanup::DisconnectError => DeviceOwnership::Ours,
            Cleanup::Foreign => DeviceOwnership::Foreign,
            Cleanup::Unknown => {
                DeviceOwnership::Unknown(std::io::Error::other("ownership unknown"))
            }
        }
    }

    fn disconnect(&self, device_index: u32) -> Result<()> {
        self.attempts
            .lock()
            .unwrap()
            .iter_mut()
            .find(|a| a.index == device_index)
            .unwrap()
            .disconnect_calls += 1;
        match self.cleanup {
            Cleanup::DisconnectError => Err(error::NbdCowError::Io(std::io::Error::other(
                "disconnect failed",
            ))),
            Cleanup::Clean | Cleanup::Foreign | Cleanup::Unknown => Ok(()),
        }
    }
}

#[derive(Default)]
struct Observer {
    outcomes: Vec<NbdCowCreateOutcome>,
    stages: Vec<(NbdCowCreateStage, bool)>,
}

impl NbdCowCreateObserver for Observer {
    fn record_stage(&mut self, stage: NbdCowCreateStage, _: Duration, success: bool) {
        self.stages.push((stage, success));
    }

    fn record_outcome(&mut self, outcome: NbdCowCreateOutcome) {
        self.outcomes.push(outcome);
    }
}

struct Harness {
    dir: tempfile::TempDir,
    pool: pool::DevicePoolHandle,
    kernel: ControlledKernel,
    verifications: mpsc::UnboundedReceiver<Verification>,
}

impl Harness {
    fn new(cleanup: Cleanup) -> Self {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("base.img"),
            vec![0x5a; DEVICE_SIZE as usize],
        )
        .unwrap();
        let pool = pool::DevicePoolHandle::new_devices_for_test(
            pool::DevicePoolConfig {
                cooldown: Duration::MAX,
            },
            dir.path(),
            6,
        );
        let (verifications, receiver) = mpsc::unbounded_channel();
        Self {
            dir,
            pool,
            kernel: ControlledKernel {
                attempts: Arc::default(),
                verifications,
                cleanup,
            },
            verifications: receiver,
        }
    }

    async fn assert_pool(&self, failed: &[u32], live: Option<u32>) {
        let snapshot = self.pool.snapshot().await;
        let mut cooldown = snapshot.cooldown;
        cooldown.sort_unstable();
        let mut expected = failed.to_vec();
        expected.sort_unstable();
        assert_eq!(cooldown, expected);
        assert_eq!(snapshot.in_flight, live.into_iter().collect());
        assert_eq!(snapshot.waiting_acquires, 0);
        for index in failed.iter().copied().chain(live) {
            assert!(
                try_acquire_device_claim_in(index, self.dir.path())
                    .unwrap()
                    .is_none(),
                "claim for nbd{index} must remain locked"
            );
        }
    }

    async fn finish(&self, indices: &[u32]) {
        self.pool.cleanup().await;
        for &index in indices {
            assert!(
                try_acquire_device_claim_in(index, self.dir.path())
                    .unwrap()
                    .is_some()
            );
        }
    }
}

// Poll explicitly so waiting for external I/O never auto-advances a retry
// timer. The wall-clock bound detects missing handshakes without changing time.
async fn poll_once<F: Future>(mut future: Pin<&mut F>) -> Poll<F::Output> {
    poll_fn(|cx| Poll::Ready(future.as_mut().poll(cx))).await
}

async fn next_verification<F: Future>(
    mut create: Pin<&mut F>,
    verifications: &mut mpsc::UnboundedReceiver<Verification>,
) -> Verification {
    let started = Instant::now();
    loop {
        assert!(poll_once(create.as_mut()).await.is_pending());
        if let Ok(verification) = verifications.try_recv() {
            return verification;
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "verification did not start"
        );
        tokio::task::yield_now().await;
    }
}

async fn read_from_dispatch(kernel: &ControlledKernel, index: u32) {
    let mut read = std::pin::pin!(async {
        let peers: Vec<_> = kernel
            .attempts
            .lock()
            .unwrap()
            .iter()
            .find(|a| a.index == index)
            .unwrap()
            .peers
            .iter()
            .map(|peer| peer.try_clone().unwrap())
            .collect();
        assert_eq!(peers.len(), NUM_CONNECTIONS);
        for peer in peers {
            let mut peer = UnixStream::from_std(peer).unwrap();
            let request = NbdRequest {
                command: Command::Read,
                handle: 42,
                offset: 0,
                length: 1,
            };
            peer.write_all(&protocol::serialize_request(&request))
                .await
                .unwrap();
            let mut reply = [0; protocol::REPLY_HEADER_SIZE];
            peer.read_exact(&mut reply).await.unwrap();
            assert_eq!(
                reply,
                protocol::serialize_reply(&NbdReply {
                    error: 0,
                    handle: 42
                })
            );
            assert_eq!(peer.read_u8().await.unwrap(), 0x5a);
        }
    });
    complete(read.as_mut()).await;
}

async fn complete<F: Future>(mut future: Pin<&mut F>) -> F::Output {
    let started = Instant::now();
    loop {
        if let Poll::Ready(result) = poll_once(future.as_mut()).await {
            return result;
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "operation did not finish"
        );
        tokio::task::yield_now().await;
    }
}

async fn assert_retry_delay<F: Future>(mut create: Pin<&mut F>, harness: &Harness, failed: &[u32]) {
    let started = Instant::now();
    loop {
        assert!(poll_once(create.as_mut()).await.is_pending());
        if harness.pool.snapshot().await.cooldown.len() == failed.len() {
            // Consume the acknowledged lease return and enter the retry sleep.
            assert!(poll_once(create.as_mut()).await.is_pending());
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "cleanup did not finish"
        );
        tokio::task::yield_now().await;
    }
    harness.assert_pool(failed, None).await;
    {
        let attempts = harness.kernel.attempts.lock().unwrap();
        assert_eq!(attempts.len(), failed.len());
        assert!(attempts.iter().all(|a| a.dispatch_closed_before_cleanup));
    }
    tokio::time::advance(Duration::from_millis(199)).await;
    assert!(poll_once(create.as_mut()).await.is_pending());
    // The actor processes its snapshot after any acquire submitted by this
    // poll. Check queued requests too: a blocking connect may not have run yet.
    harness.assert_pool(failed, None).await;
    assert_eq!(harness.kernel.attempts.lock().unwrap().len(), failed.len());
    tokio::time::advance(Duration::from_millis(1)).await;
}

// Successful devices normally use the real kernel for their later lifecycle.
// Keep test-owned resources from ever reaching that boundary, including panic.
struct TestDevice(NbdCowDevice);

impl Drop for TestDevice {
    fn drop(&mut self) {
        self.0.abandon();
    }
}

#[tokio::test(start_paused = true)]
async fn size_retry_transfers_only_the_successful_attempt() {
    let mut harness = Harness::new(Cleanup::Clean);
    let mut observer = Observer::default();
    let base = harness.dir.path().join("base.img");
    let cow = harness.dir.path().join("cow.img");
    let pool = harness.pool.clone();
    let mut create = std::pin::pin!(NbdCowDevice::create_with_kernel(
        &base,
        &cow,
        DEVICE_SIZE,
        &pool,
        Some(&mut observer),
        harness.kernel.clone(),
    ));
    let first = next_verification(create.as_mut(), &mut harness.verifications).await;
    read_from_dispatch(&harness.kernel, first.index).await;
    let started = tokio::time::Instant::now();
    first.respond.send(false).unwrap();
    assert_retry_delay(create.as_mut(), &harness, &[first.index]).await;

    let second = next_verification(create.as_mut(), &mut harness.verifications).await;
    assert_ne!(first.index, second.index);
    assert_eq!(started.elapsed(), Duration::from_millis(200));
    harness
        .assert_pool(&[first.index], Some(second.index))
        .await;
    read_from_dispatch(&harness.kernel, second.index).await;
    second.respond.send(true).unwrap();
    let (device, lease) = complete(create.as_mut()).await.unwrap();
    let mut device = TestDevice(device);
    assert_eq!(lease.index(), second.index);
    assert_eq!(device.0.device_index(), second.index);
    assert_eq!(device.0.cow_file(), cow);
    assert!(!device.0.shutdown.is_cancelled());
    assert!(!device.0.disconnected);
    assert_eq!(device.0.server_handles.len(), NUM_CONNECTIONS);
    assert!(
        device
            .0
            .server_handles
            .iter()
            .all(|handle| !handle.is_finished())
    );
    {
        let attempts = harness.kernel.attempts.lock().unwrap();
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0].disconnect_calls, 1);
        assert_eq!(attempts[1].disconnect_calls, 0);
        assert_eq!(device.0.connection_id, attempts[1].connection_id);
    }
    read_from_dispatch(&harness.kernel, second.index).await;
    device.0.prepare_shutdown(false).await.unwrap();
    pool.release_clean(lease).await;
    harness
        .assert_pool(&[first.index, second.index], None)
        .await;
    harness.finish(&[first.index, second.index]).await;
}

#[tokio::test(start_paused = true)]
async fn size_retry_exhaustion_cleans_all_attempts_without_a_final_delay() {
    for cleanup in [
        Cleanup::Clean,
        Cleanup::Foreign,
        Cleanup::Unknown,
        Cleanup::DisconnectError,
    ] {
        let mut harness = Harness::new(cleanup);
        let mut observer = Observer::default();
        let base = harness.dir.path().join("base.img");
        let cow = harness.dir.path().join("cow.img");
        let pool = harness.pool.clone();
        let mut failed = Vec::new();
        {
            let mut create = std::pin::pin!(NbdCowDevice::create_with_kernel(
                &base,
                &cow,
                DEVICE_SIZE,
                &pool,
                Some(&mut observer),
                harness.kernel.clone(),
            ));
            let started = tokio::time::Instant::now();
            for attempt in 0..6 {
                let verification =
                    next_verification(create.as_mut(), &mut harness.verifications).await;
                harness.assert_pool(&failed, Some(verification.index)).await;
                read_from_dispatch(&harness.kernel, verification.index).await;
                failed.push(verification.index);
                verification.respond.send(false).unwrap();
                if attempt < 5 {
                    assert_retry_delay(create.as_mut(), &harness, &failed).await;
                }
            }
            let result = complete(create.as_mut()).await;
            let Err(error::NbdCowError::Io(error)) = result else {
                panic!("expected terminal size verification error");
            };
            assert!(
                error
                    .to_string()
                    .contains("device size stuck at 0 after 5 connect retries")
            );
            assert!(error.to_string().contains(&format!("on nbd{}", failed[5])));
            assert_eq!(started.elapsed(), Duration::from_millis(1000));
        }
        harness.assert_pool(&failed, None).await;
        {
            let attempts = harness.kernel.attempts.lock().unwrap();
            assert_eq!(attempts.len(), 6);
            assert!(attempts.iter().all(|a| a.dispatch_closed_before_cleanup));
            let expected_disconnects = match cleanup {
                Cleanup::Clean | Cleanup::DisconnectError => 1,
                Cleanup::Foreign | Cleanup::Unknown => 0,
            };
            assert!(
                attempts
                    .iter()
                    .all(|a| a.disconnect_calls == expected_disconnects)
            );
        }
        assert!(
            observer
                .outcomes
                .contains(&NbdCowCreateOutcome::SizeZeroRetriesMultiple)
        );
        assert!(
            observer
                .outcomes
                .contains(&NbdCowCreateOutcome::EbusyRetriesNone)
        );
        assert!(
            observer
                .stages
                .contains(&(NbdCowCreateStage::SizeVerify, false))
        );
        harness.finish(&failed).await;
    }
}
