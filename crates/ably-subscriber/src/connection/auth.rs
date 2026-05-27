use crate::TokenRequest;
use crate::types::{Error, TokenDetails};

use super::endpoint::{PROTOCOL_VERSION, build_token_request_url};

/// Exchange a TokenRequest for a TokenDetails via Ably's REST API.
pub(crate) async fn exchange_token(
    client: &reqwest::Client,
    token_request: &TokenRequest,
    host: &str,
) -> Result<TokenDetails, Error> {
    let url = build_token_request_url(host, &token_request.key_name)?;
    let resp = client
        .post(url)
        .header("X-Ably-Version", PROTOCOL_VERSION)
        .json(token_request)
        .send()
        .await?
        .error_for_status()?
        .json::<TokenDetails>()
        .await?;
    Ok(resp)
}
