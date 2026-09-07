#![cfg(test)]

use std::io;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;
use ssh_rpc_proto::{Effect, ErrorCode, ExitStatus, Response, ResponseWriter};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;

fn input(command: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"version":1,"sshConnectionId":"ad729daa-0606-4113-ae6e-a8c553260f9d","command":command})).unwrap()
}

fn frames(output: &[u8]) -> Vec<Response> {
    output
        .split(|b| *b == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).unwrap())
        .collect()
}

fn wire(response: &Response) -> Vec<u8> {
    let bytes = serde_json::to_vec(response).unwrap();
    let mut frame = (bytes.len() as u32).to_be_bytes().to_vec();
    frame.extend(bytes);
    frame
}

#[tokio::test]
async fn one_shot_helper_streams_binary_frames_without_executing_the_command() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("must-not-exist");
    let command = format!("touch {}; echo 'literal $HOME `whoami`'", file.display());
    let bytes = input(&command);
    let (client, mut server) = UnixStream::pair().unwrap();
    let mut output = Vec::new();
    let calls = AtomicUsize::new(0);
    let helper = guest_ssh_rpc::run_with_io(bytes.as_slice(), &mut output, || async {
        calls.fetch_add(1, Ordering::Relaxed);
        Ok(client)
    });
    let host = async {
        assert_eq!(
            ssh_rpc_proto::read_request(&mut server)
                .await
                .unwrap()
                .command,
            command
        );
        let mut writer = ResponseWriter::new(server);
        writer.send(&Response::Accepted).await.unwrap();
        writer
            .send(&Response::Stdout {
                data: ssh_rpc_proto::encode_output(&[0, 255, 10, 128]).unwrap(),
            })
            .await
            .unwrap();
        writer
            .send(&Response::Stderr {
                data: ssh_rpc_proto::encode_output(b"warning").unwrap(),
            })
            .await
            .unwrap();
        writer
            .send(&Response::Finished {
                status: ExitStatus::Exit { code: 7 },
                stdout_truncated: false,
                stderr_truncated: true,
            })
            .await
            .unwrap();
    };
    let (result, ()) = tokio::join!(helper, host);
    assert!(result.unwrap());
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    assert!(!file.exists());
    let responses = frames(&output);
    assert_eq!(responses.len(), 4);
    assert_eq!(responses.iter().filter(|r| r.is_terminal()).count(), 1);
    let Some(Response::Stdout { data }) = responses.get(1) else {
        panic!("missing binary output")
    };
    assert_eq!(
        ssh_rpc_proto::decode_output(data).unwrap(),
        [0, 255, 10, 128]
    );
    assert!(!String::from_utf8(output).unwrap().contains(&command));
}

#[tokio::test]
async fn invalid_input_never_connects_and_never_echoes_untrusted_content() {
    let calls = AtomicUsize::new(0);
    for bytes in [
        b"invalid secret input".to_vec(),
        input(""),
        vec![b'x'; ssh_rpc_proto::MAX_REQUEST_BYTES + 1],
    ] {
        let mut output = Vec::new();
        let result = guest_ssh_rpc::run_with_io(bytes.as_slice(), &mut output, || async {
            calls.fetch_add(1, Ordering::Relaxed);
            Err::<UnixStream, _>(io::Error::other("secret endpoint"))
        })
        .await
        .unwrap();
        assert!(!result);
        assert_eq!(
            frames(&output),
            [Response::error(
                ErrorCode::InvalidRequest,
                Effect::NotStarted
            )]
        );
    }
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn connection_failure_is_not_started_but_lost_response_is_unknown_without_replay() {
    let bytes = input("true");
    let mut output = Vec::new();
    assert!(
        !guest_ssh_rpc::run_with_io(bytes.as_slice(), &mut output, || async {
            Err::<UnixStream, _>(io::Error::other("secret endpoint"))
        })
        .await
        .unwrap()
    );
    assert_eq!(
        frames(&output),
        [Response::error(ErrorCode::Unavailable, Effect::NotStarted)]
    );

    for sent in [vec![], wire(&Response::Accepted), vec![0, 0, 0, 10, b'{']] {
        let (client, mut server) = UnixStream::pair().unwrap();
        let mut output = Vec::new();
        let calls = AtomicUsize::new(0);
        let helper = guest_ssh_rpc::run_with_io(bytes.as_slice(), &mut output, || async {
            calls.fetch_add(1, Ordering::Relaxed);
            Ok(client)
        });
        let host = async {
            ssh_rpc_proto::read_request(&mut server).await.unwrap();
            server.write_all(&sent).await.unwrap();
            server.shutdown().await.unwrap();
        };
        let (result, ()) = tokio::join!(helper, host);
        assert!(!result.unwrap());
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        let responses = frames(&output);
        assert_eq!(responses.iter().filter(|r| r.is_terminal()).count(), 1);
        assert!(matches!(
            responses.last(),
            Some(Response::Error {
                effect: Effect::Unknown,
                ..
            })
        ));
    }
}

#[tokio::test]
async fn duplicate_terminal_or_trailing_garbage_never_exposes_finished() {
    let bytes = input("true");
    let finished = Response::Finished {
        status: ExitStatus::Exit { code: 0 },
        stdout_truncated: false,
        stderr_truncated: false,
    };
    for trailing in [wire(&finished), vec![1]] {
        let (client, mut server) = UnixStream::pair().unwrap();
        let mut output = Vec::new();
        let helper =
            guest_ssh_rpc::run_with_io(bytes.as_slice(), &mut output, || async { Ok(client) });
        let host = async {
            ssh_rpc_proto::read_request(&mut server).await.unwrap();
            for frame in [wire(&Response::Accepted), wire(&finished), trailing] {
                server.write_all(&frame).await.unwrap();
            }
            server.shutdown().await.unwrap();
        };
        let (result, ()) = tokio::join!(helper, host);
        assert!(!result.unwrap());
        let responses = frames(&output);
        assert_eq!(responses.iter().filter(|r| r.is_terminal()).count(), 1);
        assert!(
            !responses
                .iter()
                .any(|r| matches!(r, Response::Finished { .. }))
        );
    }
}

#[tokio::test(start_paused = true)]
async fn input_deadline_does_not_connect_or_leave_the_helper_waiting() {
    let (_input_writer, reader) = tokio::io::duplex(64);
    let mut output = Vec::new();
    let calls = AtomicUsize::new(0);
    assert!(
        !guest_ssh_rpc::run_with_io(reader, &mut output, || async {
            calls.fetch_add(1, Ordering::Relaxed);
            Err::<UnixStream, _>(io::Error::other("must not connect"))
        })
        .await
        .unwrap()
    );
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    assert_eq!(
        frames(&output),
        [Response::error(ErrorCode::TimedOut, Effect::NotStarted)]
    );
}

#[test]
fn executable_rejects_bad_input_without_files_or_payload_logs() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_guest-ssh-rpc"))
        .current_dir(dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"secret malformed input")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(
        frames(&output.stdout),
        [Response::error(
            ErrorCode::InvalidRequest,
            Effect::NotStarted
        )]
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);

    let output = Command::new(env!("CARGO_BIN_EXE_guest-ssh-rpc"))
        .args(["--socket", "/untrusted"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        !String::from_utf8(output.stderr)
            .unwrap()
            .contains("untrusted")
    );
}
