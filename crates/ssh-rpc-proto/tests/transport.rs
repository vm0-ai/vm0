#![cfg(test)]

use std::io;
use std::time::Duration;

use serde_json::json;
use ssh_rpc_proto::*;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::time::timeout;

fn request_json(command: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"version": 1, "sshConnectionId": "ad729daa-0606-4113-ae6e-a8c553260f9d", "command": command})).unwrap()
}

fn raw_frame(value: serde_json::Value) -> Vec<u8> {
    let bytes = serde_json::to_vec(&value).unwrap();
    let mut frame = (bytes.len() as u32).to_be_bytes().to_vec();
    frame.extend(bytes);
    frame
}

#[tokio::test]
async fn requests_round_trip_escaped_command_at_the_bound_and_reject_authority_fields() {
    let command = "\0".repeat(MAX_COMMAND_BYTES);
    let request = parse_request(&request_json(&command)).unwrap();
    let (mut sender, mut receiver) = UnixStream::pair().unwrap();
    let send = async {
        write_request(&mut sender, &request).await.unwrap();
        sender.shutdown().await.unwrap();
    };
    let ((), received) = tokio::join!(send, read_request(&mut receiver));
    assert_eq!(received.unwrap().command, command);
    for (field, invalid_value) in [
        ("version", json!(2)),
        ("version", json!("1")),
        ("sshConnectionId", json!("hallucinated")),
        (
            "sshConnectionId",
            json!("00000000-0000-0000-0000-000000000000"),
        ),
        ("command", json!("")),
        ("command", json!("x".repeat(MAX_COMMAND_BYTES + 1))),
        ("host", json!("secret-host")),
        ("username", json!("root")),
        ("privateKey", json!("secret")),
        ("runId", json!("other")),
    ] {
        let mut value: serde_json::Value = serde_json::from_slice(&request_json("true")).unwrap();
        value[field] = invalid_value;
        let error = parse_request(&serde_json::to_vec(&value).unwrap())
            .err()
            .unwrap();
        assert!(!error.to_string().contains("secret"));
    }
}

#[tokio::test]
async fn advertised_oversize_is_rejected_before_waiting_for_a_body() {
    let (mut peer, mut host) = UnixStream::pair().unwrap();
    peer.write_all(&u32::MAX.to_be_bytes()).await.unwrap();
    let error = timeout(Duration::from_secs(1), read_request(&mut host))
        .await
        .unwrap()
        .err()
        .unwrap();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    let (mut peer, host) = UnixStream::pair().unwrap();
    peer.write_all(&u32::MAX.to_be_bytes()).await.unwrap();
    assert_eq!(
        timeout(Duration::from_secs(1), ResponseReader::new(host).next())
            .await
            .unwrap()
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidData
    );
}

#[tokio::test]
async fn partial_malformed_and_extra_requests_fail_closed() {
    let request = raw_frame(serde_json::from_slice(&request_json("true")).unwrap());
    for bytes in [
        vec![],
        vec![0, 0],
        vec![0, 0, 0, 10, b'{'],
        [request.clone(), request].concat(),
        raw_frame(json!({"version": 1})),
    ] {
        let (mut peer, mut host) = UnixStream::pair().unwrap();
        peer.write_all(&bytes).await.unwrap();
        peer.shutdown().await.unwrap();
        assert!(read_request(&mut host).await.is_err());
    }
}

#[tokio::test]
async fn arbitrary_binary_and_independent_stream_caps_round_trip() {
    let (host, peer) = UnixStream::pair().unwrap();
    let binary: Vec<u8> = (0..MAX_CHUNK_BYTES).map(|i| i as u8).collect();
    let encoded = encode_output(&binary).unwrap();
    let send = async {
        let mut writer = ResponseWriter::new(host);
        writer.send(&Response::Accepted {}).await.unwrap();
        for _ in 0..MAX_OUTPUT_BYTES / MAX_CHUNK_BYTES {
            writer
                .send(&Response::Stdout {
                    data: encoded.clone(),
                })
                .await
                .unwrap();
            writer
                .send(&Response::Stderr {
                    data: encoded.clone(),
                })
                .await
                .unwrap();
        }
        assert!(
            writer
                .send(&Response::Stdout {
                    data: encode_output(b"x").unwrap()
                })
                .await
                .is_err()
        );
        writer
            .send(&Response::Finished {
                status: ExitStatus::Exit { code: 42 },
                stdout_truncated: true,
                stderr_truncated: false,
            })
            .await
            .unwrap();
        assert!(
            writer
                .send(&Response::error(ErrorCode::Transport, Effect::Unknown))
                .await
                .is_err()
        );
    };
    let receive = async {
        let mut reader = ResponseReader::new(peer);
        let mut total = 0;
        while let Some(response) = reader.next().await.unwrap() {
            match response {
                Response::Stdout { data } | Response::Stderr { data } => {
                    assert_eq!(decode_output(&data).unwrap(), binary);
                    total += binary.len();
                }
                Response::Finished {
                    status,
                    stdout_truncated,
                    stderr_truncated,
                } => {
                    assert_eq!(status, ExitStatus::Exit { code: 42 });
                    assert!(stdout_truncated);
                    assert!(!stderr_truncated);
                }
                _ => {}
            }
        }
        assert_eq!(total, 2 * MAX_OUTPUT_BYTES);
    };
    tokio::join!(send, receive);
}

#[tokio::test]
async fn response_reader_rejects_bad_order_encoding_shapes_and_terminal_duplicates() {
    let accepted = json!({"type": "accepted"});
    let error = json!({"type": "error", "code": "unavailable", "effect": "not_started", "stdout_truncated": false, "stderr_truncated": false});
    for frames in [
        vec![json!({"type": "stdout", "data": "eA=="})],
        vec![accepted.clone(), accepted.clone()],
        vec![accepted.clone(), error.clone()],
        vec![accepted.clone(), json!({"type": "stdout", "data": "?"})],
        vec![accepted.clone(), json!({"type": "stdout", "data": ""})],
        vec![
            accepted.clone(),
            json!({"type": "stdout", "data": "A".repeat(MAX_RESPONSE_BYTES)}),
        ],
        vec![json!({"type": "accepted", "host": "secret"})],
        vec![json!({"type": "unexpected"})],
        vec![error.clone(), error],
        vec![accepted],
    ] {
        let bytes: Vec<_> = frames.into_iter().flat_map(raw_frame).collect();
        let mut reader = ResponseReader::new(bytes.as_slice());
        loop {
            match reader.next().await {
                Ok(Some(_)) => {}
                Ok(None) => panic!("invalid response unexpectedly succeeded"),
                Err(_) => break,
            }
        }
        assert!(reader.next().await.is_err());
    }
}

#[tokio::test]
async fn response_authority_fields_are_rejected_on_the_frame_that_contains_them() {
    for response in [
        json!({"type": "accepted", "host": "secret"}),
        json!({"type": "stdout", "data": "eA==", "username": "root"}),
        json!({"type": "finished", "status": {"kind": "exit", "code": 0, "hostKey": "secret"}, "stdout_truncated": false, "stderr_truncated": false}),
        json!({"type": "error", "code": "unavailable", "effect": "unknown", "privateKey": "secret", "stdout_truncated": false, "stderr_truncated": false}),
    ] {
        let needs_acceptance = response["type"] != "accepted";
        let mut bytes = Vec::new();
        if needs_acceptance {
            bytes.extend(raw_frame(json!({"type": "accepted"})));
        }
        bytes.extend(raw_frame(response));
        let mut reader = ResponseReader::new(bytes.as_slice());
        if needs_acceptance {
            assert_eq!(reader.next().await.unwrap(), Some(Response::Accepted {}));
        }
        assert!(reader.next().await.is_err());
    }
}
