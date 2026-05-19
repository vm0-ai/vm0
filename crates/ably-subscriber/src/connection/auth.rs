use crate::TokenRequest;
use crate::types::{Error, TokenDetails};

use super::endpoint::{PROTOCOL_VERSION, is_localhost};

/// Exchange a TokenRequest for a TokenDetails via Ably's REST API.
pub(crate) async fn exchange_token(
    client: &reqwest::Client,
    token_request: &TokenRequest,
    host: &str,
) -> Result<TokenDetails, Error> {
    let scheme = if is_localhost(host) { "http" } else { "https" };
    let url = format!(
        "{scheme}://{host}/keys/{}/requestToken",
        token_request.key_name
    );
    let resp = client
        .post(&url)
        .header("X-Ably-Version", PROTOCOL_VERSION)
        .json(token_request)
        .send()
        .await?
        .error_for_status()?
        .json::<TokenDetails>()
        .await?;
    Ok(resp)
}
