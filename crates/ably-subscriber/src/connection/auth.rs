use crate::TokenRequest;
use crate::protocol::error_code;
use crate::types::{Error, TokenDetails};

use super::endpoint::{PROTOCOL_VERSION, build_token_request_url};

/// Maximum encoded JSON payload accepted from the Ably token endpoint.
///
/// Token details are normally small; 64 KiB leaves ample room for capability
/// metadata while keeping response buffering bounded in the long-lived runner.
const TOKEN_EXCHANGE_RESPONSE_MAX_BYTES: usize = 64 * 1024;

/// Exchange a TokenRequest for a TokenDetails via Ably's REST API.
pub(crate) async fn exchange_token(
    client: &reqwest::Client,
    token_request: &TokenRequest,
    host: &str,
) -> Result<TokenDetails, Error> {
    let url = build_token_request_url(host, &token_request.key_name)?;
    let response = client
        .post(url)
        .header("X-Ably-Version", PROTOCOL_VERSION)
        .json(token_request)
        .send()
        .await?
        .error_for_status()?;
    let body = collect_token_response(response).await?;
    serde_json::from_slice(&body).map_err(|error| Error::Protocol {
        code: error_code::FAILED,
        message: format!("Token exchange response JSON decode failed: {error}"),
    })
}

async fn collect_token_response(mut response: reqwest::Response) -> Result<Vec<u8>, Error> {
    let capacity = match response.content_length() {
        Some(length) if length > TOKEN_EXCHANGE_RESPONSE_MAX_BYTES as u64 => {
            return Err(token_response_too_large());
        }
        Some(length) => usize::try_from(length).map_err(|_| token_response_too_large())?,
        None => 0,
    };
    let mut body = Vec::with_capacity(capacity);

    while let Some(chunk) = response.chunk().await? {
        let length = body
            .len()
            .checked_add(chunk.len())
            .ok_or_else(token_response_too_large)?;
        if length > TOKEN_EXCHANGE_RESPONSE_MAX_BYTES {
            return Err(token_response_too_large());
        }
        body.extend_from_slice(&chunk);
    }

    Ok(body)
}

fn token_response_too_large() -> Error {
    Error::Protocol {
        code: error_code::FAILED,
        message: "Token exchange response body exceeds 64 KiB limit".to_string(),
    }
}
