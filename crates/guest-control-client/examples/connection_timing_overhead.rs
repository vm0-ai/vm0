//! Alternating observed/unobserved real-socket samples; not a performance test.
//! Run an optimized build on the target host and retain stdout for analysis.

use std::io;
use std::time::{Duration, Instant};

use guest_control_client::GuestControlClient;
use guest_control_proto::{MSG_PING, MSG_PONG, MSG_READY};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

const TIMEOUT: Duration = Duration::from_secs(5);

async fn sample(observed: bool) -> io::Result<Duration> {
    let base = std::env::temp_dir()
        .join(format!("gct-{}", uuid::Uuid::new_v4()))
        .display()
        .to_string();
    let socket = format!("{base}_{}", guest_control_proto::VSOCK_PORT);
    let host = async {
        let started = Instant::now();
        let client = if observed {
            let (result, timing) =
                GuestControlClient::wait_for_connection_with_timing(&base, TIMEOUT).await;
            std::hint::black_box(timing);
            result?
        } else {
            GuestControlClient::wait_for_connection(&base, TIMEOUT).await?
        };
        Ok::<_, io::Error>((client, started.elapsed()))
    };
    let guest = async {
        let mut stream = loop {
            match UnixStream::connect(&socket).await {
                Ok(stream) => break stream,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    tokio::task::yield_now().await;
                }
                Err(error) => return Err(error),
            }
        };
        let ready = guest_control_proto::encode(MSG_READY, 0, &[]).map_err(io::Error::other)?;
        stream.write_all(&ready).await?;
        let ping = guest_control_proto::encode(MSG_PING, 1, &[]).map_err(io::Error::other)?;
        let mut received = vec![0; ping.len()];
        stream.read_exact(&mut received).await?;
        if received != ping {
            return Err(io::Error::other("unexpected handshake PING"));
        }
        let pong = guest_control_proto::encode(MSG_PONG, 1, &[]).map_err(io::Error::other)?;
        stream.write_all(&pong).await?;
        Ok(stream)
    };
    let ((client, elapsed), guest) =
        tokio::time::timeout(TIMEOUT, async { tokio::try_join!(host, guest) }).await??;
    drop(client);
    drop(guest);
    Ok(elapsed)
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> io::Result<()> {
    // Warmup is explicit and excluded from emitted samples. ABBA ordering
    // balances slow drift; distributions are not proof of fleet-wide overhead.
    for observed in [false, true].into_iter().cycle().take(40) {
        sample(observed).await?;
    }
    let mut records = Vec::with_capacity(4000);
    for batch in 0..1000 {
        for observed in [false, true, true, false] {
            records.push((batch, observed, sample(observed).await?));
        }
    }
    for (batch, observed, elapsed) in records {
        println!(
            "{{\"batch\":{batch},\"observed\":{observed},\"duration_ns\":{}}}",
            elapsed.as_nanos()
        );
    }
    Ok(())
}
