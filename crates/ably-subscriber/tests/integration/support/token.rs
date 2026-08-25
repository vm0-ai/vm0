use std::io;

use httpmock::prelude::*;
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};

use super::now_ms;

const TOKEN_REQUEST_MAX_BYTES: usize = 16 * 1024;

pub(crate) struct RawTokenServer {
    listener: TcpListener,
    port: u16,
}

impl RawTokenServer {
    pub(crate) async fn start() -> io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        Ok(Self { listener, port })
    }

    pub(crate) fn port(&self) -> u16 {
        self.port
    }

    pub(crate) async fn accept_request(&self) -> io::Result<TcpStream> {
        let (mut stream, _) = self.listener.accept().await?;
        read_request(&mut stream).await?;
        Ok(stream)
    }
}

async fn read_request(stream: &mut TcpStream) -> io::Result<()> {
    let mut request = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 1024];

    loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "token request closed before its body completed",
            ));
        }
        let next_length = request
            .len()
            .checked_add(read)
            .ok_or_else(request_too_large)?;
        if next_length > TOKEN_REQUEST_MAX_BYTES {
            return Err(request_too_large());
        }
        request.extend(buffer.iter().take(read).copied());

        let Some(header_end) = request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|position| position + 4)
        else {
            continue;
        };
        let headers = request.get(..header_end).ok_or_else(request_too_large)?;
        let content_length = request_content_length(headers)?;
        let request_end = header_end
            .checked_add(content_length)
            .ok_or_else(request_too_large)?;
        if request_end > TOKEN_REQUEST_MAX_BYTES {
            return Err(request_too_large());
        }
        if request.len() >= request_end {
            return Ok(());
        }
    }
}

fn request_content_length(headers: &[u8]) -> io::Result<usize> {
    let headers = std::str::from_utf8(headers)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let value = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then_some(value.trim())
    });
    value.map_or(Ok(0), |value| {
        value
            .parse()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    })
}

fn request_too_large() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "token request exceeds test fixture limit",
    )
}

pub(crate) fn mock_token_endpoint(server: &MockServer, key_name: &str) {
    let path = format!("/keys/{key_name}/requestToken");
    let now = now_ms();
    let body = serde_json::json!({
        "token": "mock-token-abc",
        "expires": now + 3_600_000,
        "issued": now,
        "capability": "{\"*\":[\"*\"]}",
    });
    server.mock(|when, then| {
        when.method(POST).path(path);
        then.status(201)
            .header("content-type", "application/json")
            .json_body(body);
    });
}
