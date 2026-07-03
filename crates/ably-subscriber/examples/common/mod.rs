use std::time::{SystemTime, UNIX_EPOCH};

use ably_subscriber::{BoxError, TokenRequest};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

pub(crate) const ONE_HOUR_TTL_MS: i64 = 3_600_000;

type HmacSha256 = Hmac<Sha256>;

pub(crate) fn create_token_request(
    key_name: &str,
    key_secret: &str,
    ttl_ms: i64,
) -> Result<TokenRequest, BoxError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("system time error: {e}"))?;
    let timestamp = now.as_millis() as i64;
    let nonce = format!("{:x}{:x}", now.as_nanos(), std::process::id());
    let capability = r#"{"*":["*"]}"#;

    // Ably signing format: keyName\nttl\ncapability\nclientId\ntimestamp\nnonce\n
    let sign_text = format!("{key_name}\n{ttl_ms}\n{capability}\n\n{timestamp}\n{nonce}\n");

    let mut mac = HmacSha256::new_from_slice(key_secret.as_bytes())
        .map_err(|e| format!("HMAC error: {e}"))?;
    mac.update(sign_text.as_bytes());
    let mac_b64 = BASE64.encode(mac.finalize().into_bytes());

    Ok(TokenRequest {
        key_name: key_name.to_string(),
        timestamp,
        nonce,
        mac: mac_b64,
        capability: capability.to_string(),
        ttl: Some(ttl_ms),
        client_id: None,
    })
}
