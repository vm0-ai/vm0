//! Build a fabricated, well-formed-but-placeholder `~/.codex/auth.json`
//! for the ChatGPT-OAuth bootstrap path.
//!
//! Codex (`openai/codex`) decides between API-key mode and ChatGPT mode at
//! load time from `auth.json` contents. By writing an `auth.json` with
//! `auth_mode: "Chatgpt"`, `OPENAI_API_KEY: null`, and a `tokens` object
//! whose JWTs carry far-future `exp` claims, we put the codex CLI into
//! ChatGPT mode without ever holding real OAuth credentials inside the
//! sandbox. The mitm firewall replaces the placeholder bytes (Bearer
//! token + account_id header) on egress with the real values from
//! server-side secrets.
//!
//! Codex `decode_jwt_payload` (`codex-rs/login/src/token_data.rs:117-128`)
//! base64url-decodes only the payload segment; the header and signature
//! segments must be non-empty but are not validated. So a syntactically
//! valid 3-segment JWT with a `https://api.openai.com/auth` claim
//! namespace and a far-future `exp` is sufficient for codex's local
//! parser.
//!
//! See issue #11877 and parent Epic #11872 for full context.

use std::path::Path;

use base64::Engine;
use chrono::{DateTime, Utc};
use serde_json::{Value, json};

use crate::error::AgentError;

// ---------------------------------------------------------------------------
// Placeholder constants
//
// These literals MUST match the firewall's expected placeholder bytes for
// ChatGPT request rewriting. The api-contracts firewall config that owns
// the matching side lives at:
//     turbo/packages/api-contracts/src/contracts/model-providers.ts
// (per Epic #11872, sub-issue #11878). If you change these constants,
// update both files in the same PR — drift produces silent 401s from
// the upstream API because the firewall will fail to recognize and
// replace the placeholder bytes.
// ---------------------------------------------------------------------------

/// Placeholder workspace account id written into `auth.json` `tokens.account_id`
/// and the JWT `chatgpt_account_id` claim. The firewall replaces these bytes
/// on egress with the real account id from server-side secrets.
pub(crate) const PLACEHOLDER_CHATGPT_ACCOUNT_ID: &str = "ws_VM0_PLACEHOLDER_DO_NOT_TRUST";

/// Placeholder ChatGPT plan type. Must be a non-`free` plan name; codex
/// rejects `free`. The real plan type is enforced server-side at provider
/// creation; this string only needs to satisfy codex's local parser.
pub(crate) const PLACEHOLDER_PLAN_TYPE: &str = "plus";

/// Far-future JWT `exp` offset, in seconds. ~100 years from now ensures
/// codex's `is_stale_for_proactive_refresh`
/// (`codex-rs/login/src/auth/manager.rs:1786-1806`) always returns false;
/// codex will not attempt refresh during runs.
const FAR_FUTURE_EXP_SECS: i64 = 100 * 365 * 24 * 3600;

/// Localhost no-op URL for `CODEX_REFRESH_TOKEN_URL_OVERRIDE`. Defense
/// in depth: if codex tries to refresh despite the far-future `exp`,
/// the request hits a closed port and fails fast instead of escaping
/// to `auth.openai.com`. The firewall additionally denies that
/// hostname from inside the sandbox (Epic #11872 risk-mitigation row).
const REFRESH_TOKEN_NOOP_URL: &str = "http://127.0.0.1:1/blocked";

// ---------------------------------------------------------------------------
// JWT builder
//
// Header is `{"alg":"HS256","typ":"JWT"}` (NOT `alg:none` — the latter
// is a known antipattern that strict JWT libraries reject by default).
// Signature segment is a fixed non-empty literal; codex doesn't validate
// signatures locally, so no real HMAC computation is needed.
// ---------------------------------------------------------------------------

fn make_placeholder_jwt(payload: &Value) -> Result<String, AgentError> {
    let header = json!({"alg": "HS256", "typ": "JWT"});
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let header_b64 = engine.encode(serde_json::to_string(&header)?.as_bytes());
    let payload_b64 = engine.encode(serde_json::to_string(payload)?.as_bytes());
    // Fixed placeholder signature segment — codex doesn't validate it,
    // and we don't have OpenAI's signing key. Non-empty satisfies the
    // segment-presence check in `decode_jwt_payload`.
    let sig = "PLACEHOLDER_SIG_DO_NOT_TRUST";
    Ok(format!("{header_b64}.{payload_b64}.{sig}"))
}

// ---------------------------------------------------------------------------
// Claim builders
// ---------------------------------------------------------------------------

/// Build the JWT payload for the access_token. Codex parses this for
/// `chatgpt_account_id` (under the `https://api.openai.com/auth`
/// namespace) and `exp` (top-level). Far-future `exp` prevents
/// proactive refresh.
fn build_access_token_claims(now: DateTime<Utc>) -> Value {
    let exp = now.timestamp() + FAR_FUTURE_EXP_SECS;
    json!({
        "https://api.openai.com/auth": {
            "chatgpt_account_id": PLACEHOLDER_CHATGPT_ACCOUNT_ID,
            "chatgpt_plan_type": PLACEHOLDER_PLAN_TYPE,
        },
        "iat": now.timestamp(),
        "exp": exp,
    })
}

/// id_token claims include `chatgpt_account_id`, `chatgpt_plan_type`,
/// `chatgpt_user_id`, and `chatgpt_account_is_fedramp` — parsed by
/// codex's `IdTokenInfo` struct (`codex-rs/login/src/token_data.rs:28-42`).
fn build_id_token_claims(now: DateTime<Utc>) -> Value {
    let exp = now.timestamp() + FAR_FUTURE_EXP_SECS;
    json!({
        "https://api.openai.com/auth": {
            "chatgpt_account_id": PLACEHOLDER_CHATGPT_ACCOUNT_ID,
            "chatgpt_plan_type": PLACEHOLDER_PLAN_TYPE,
            "chatgpt_user_id": "placeholder",
            "chatgpt_account_is_fedramp": false,
        },
        "iat": now.timestamp(),
        "exp": exp,
    })
}

// ---------------------------------------------------------------------------
// auth.json builder
//
// Three independent ChatGPT-mode signals (defense in depth against
// future codex refactors):
//   1. `auth_mode: "Chatgpt"` (explicit; wins first in `resolved_mode()`)
//   2. `OPENAI_API_KEY: null` (defends against the unconditional fallback
//      being gated on `tokens.is_some()` in some future codex version)
//   3. `tokens` populated with valid placeholder JWTs
// ---------------------------------------------------------------------------

fn build_auth_json(now: DateTime<Utc>) -> Result<Value, AgentError> {
    let access_jwt = make_placeholder_jwt(&build_access_token_claims(now))?;
    let id_jwt = make_placeholder_jwt(&build_id_token_claims(now))?;

    Ok(json!({
        "auth_mode": "Chatgpt",
        "OPENAI_API_KEY": Value::Null,
        "tokens": {
            "id_token": id_jwt,
            "access_token": access_jwt,
            "refresh_token": "",
            "account_id": PLACEHOLDER_CHATGPT_ACCOUNT_ID,
        },
        "last_refresh": now.to_rfc3339(),
    }))
}

// ---------------------------------------------------------------------------
// Setup function
//
// Inputs are explicit (`home_dir`, `now`) so this function is fully
// testable without touching env or the real clock. The thin wrapper in
// `cli.rs` reads `env::home_dir()` and `Utc::now()` and calls this.
// ---------------------------------------------------------------------------

pub(crate) fn setup_codex_chatgpt_inner(
    home_dir: &Path,
    now: DateTime<Utc>,
) -> Result<(), AgentError> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt;

    let codex_home = home_dir.join(".codex");
    std::fs::create_dir_all(&codex_home)?;

    let auth_json = build_auth_json(now)?;
    let serialized = serde_json::to_string(&auth_json)?;

    let auth_path = codex_home.join("auth.json");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&auth_path)?;
    file.write_all(serialized.as_bytes())?;

    // SAFETY: `setup_codex_chatgpt_inner` runs from `main.rs` during
    // single-threaded init, before any worker thread spawns. No other
    // thread is reading the env concurrently.
    unsafe {
        std::env::set_var("CODEX_REFRESH_TOKEN_URL_OVERRIDE", REFRESH_TOKEN_NOOP_URL);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::os::unix::fs::PermissionsExt;

    use chrono::TimeZone;
    use tempfile::TempDir;

    fn fixed_now() -> DateTime<Utc> {
        // 2026-01-01T00:00:00Z — well after assistant knowledge cutoff
        // so any "exp must be > now" check is unambiguous.
        Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap()
    }

    fn decode_segment(segment: &str) -> Value {
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(segment)
            .expect("payload segment must be base64url");
        serde_json::from_slice(&bytes).expect("payload segment must be JSON")
    }

    // -----------------------------------------------------------------
    // make_placeholder_jwt
    // -----------------------------------------------------------------

    #[test]
    fn make_placeholder_jwt_produces_three_non_empty_segments() {
        let payload = json!({"hello": "world"});
        let jwt = make_placeholder_jwt(&payload).unwrap();
        let segments: Vec<&str> = jwt.split('.').collect();
        assert_eq!(segments.len(), 3, "JWT must have 3 segments: {jwt}");
        for (i, seg) in segments.iter().enumerate() {
            assert!(!seg.is_empty(), "segment {i} must be non-empty: {jwt}");
        }
    }

    #[test]
    fn make_placeholder_jwt_payload_round_trips() {
        let payload = json!({"foo": 42, "bar": ["a", "b"]});
        let jwt = make_placeholder_jwt(&payload).unwrap();
        let segments: Vec<&str> = jwt.split('.').collect();
        let decoded = decode_segment(segments[1]);
        assert_eq!(decoded, payload);
    }

    #[test]
    fn make_placeholder_jwt_header_uses_hs256_not_none() {
        let jwt = make_placeholder_jwt(&json!({})).unwrap();
        let segments: Vec<&str> = jwt.split('.').collect();
        let header = decode_segment(segments[0]);
        assert_eq!(header["alg"], "HS256");
        assert_eq!(header["typ"], "JWT");
    }

    // -----------------------------------------------------------------
    // build_access_token_claims / build_id_token_claims
    // -----------------------------------------------------------------

    #[test]
    fn build_access_token_claims_has_chatgpt_namespace() {
        let claims = build_access_token_claims(fixed_now());
        let auth_ns = &claims["https://api.openai.com/auth"];
        assert_eq!(
            auth_ns["chatgpt_account_id"],
            PLACEHOLDER_CHATGPT_ACCOUNT_ID
        );
        assert_eq!(auth_ns["chatgpt_plan_type"], PLACEHOLDER_PLAN_TYPE);
    }

    #[test]
    fn build_access_token_claims_far_future_exp() {
        let now = fixed_now();
        let claims = build_access_token_claims(now);
        let exp = claims["exp"].as_i64().expect("exp must be i64");
        // At least 50 years in the future — far enough that any real
        // run finishes well before codex would consider refresh.
        let fifty_years_secs = 50 * 365 * 24 * 3600;
        assert!(
            exp > now.timestamp() + fifty_years_secs,
            "exp {exp} not far enough in future from now {}",
            now.timestamp()
        );
    }

    #[test]
    fn build_access_token_claims_iat_is_now() {
        let now = fixed_now();
        let claims = build_access_token_claims(now);
        assert_eq!(claims["iat"].as_i64().unwrap(), now.timestamp());
    }

    #[test]
    fn build_id_token_claims_plan_type_not_free() {
        let claims = build_id_token_claims(fixed_now());
        let plan_type = claims["https://api.openai.com/auth"]["chatgpt_plan_type"]
            .as_str()
            .expect("chatgpt_plan_type must be a string");
        assert_ne!(plan_type, "free", "codex rejects free plan type");
    }

    #[test]
    fn build_id_token_claims_includes_user_id_and_fedramp_flag() {
        let claims = build_id_token_claims(fixed_now());
        let auth_ns = &claims["https://api.openai.com/auth"];
        assert!(auth_ns["chatgpt_user_id"].is_string());
        assert_eq!(auth_ns["chatgpt_account_is_fedramp"], false);
    }

    // -----------------------------------------------------------------
    // build_auth_json
    // -----------------------------------------------------------------

    #[test]
    fn build_auth_json_contains_three_chatgpt_signals() {
        let auth = build_auth_json(fixed_now()).unwrap();
        // 1. Explicit auth_mode
        assert_eq!(auth["auth_mode"], "Chatgpt");
        // 2. OPENAI_API_KEY explicitly null
        assert_eq!(auth["OPENAI_API_KEY"], Value::Null);
        // 3. tokens populated with valid 3-segment JWT
        let access_token = auth["tokens"]["access_token"]
            .as_str()
            .expect("access_token must be string");
        assert_eq!(access_token.split('.').count(), 3);
    }

    #[test]
    fn build_auth_json_account_id_is_placeholder() {
        let auth = build_auth_json(fixed_now()).unwrap();
        assert_eq!(auth["tokens"]["account_id"], PLACEHOLDER_CHATGPT_ACCOUNT_ID);
    }

    #[test]
    fn build_auth_json_id_token_has_three_segments() {
        let auth = build_auth_json(fixed_now()).unwrap();
        let id_token = auth["tokens"]["id_token"].as_str().unwrap();
        assert_eq!(id_token.split('.').count(), 3);
    }

    #[test]
    fn build_auth_json_refresh_token_is_empty_string() {
        let auth = build_auth_json(fixed_now()).unwrap();
        assert_eq!(auth["tokens"]["refresh_token"], "");
    }

    #[test]
    fn build_auth_json_last_refresh_is_rfc3339() {
        let auth = build_auth_json(fixed_now()).unwrap();
        let last_refresh = auth["last_refresh"].as_str().unwrap();
        DateTime::parse_from_rfc3339(last_refresh).expect("last_refresh must be RFC3339");
    }

    #[test]
    fn auth_json_contains_no_real_token_shapes() {
        let auth = build_auth_json(fixed_now()).unwrap();
        let serialized = serde_json::to_string(&auth).unwrap();
        // Real OpenAI/Anthropic/Google token prefixes that must never
        // appear in our fabricated auth.json.
        for needle in ["sk-proj-", "sk-ant-", "Bearer ya29.", "eyJhbGciOiJSUzI1NiI"] {
            assert!(
                !serialized.contains(needle),
                "fabricated auth.json must not contain real-token shape {needle:?}: {serialized}"
            );
        }
    }

    // -----------------------------------------------------------------
    // setup_codex_chatgpt_inner
    // -----------------------------------------------------------------

    #[test]
    fn setup_codex_chatgpt_inner_writes_auth_json_with_0600_perms() {
        let tmp = TempDir::new().unwrap();
        setup_codex_chatgpt_inner(tmp.path(), fixed_now()).unwrap();

        let auth_path = tmp.path().join(".codex").join("auth.json");
        assert!(auth_path.exists(), "auth.json must be created");

        let mode = std::fs::metadata(&auth_path).unwrap().permissions().mode();
        // Mask off the file-type bits (0o170000) — leaves just permissions.
        assert_eq!(
            mode & 0o7777,
            0o600,
            "auth.json must be mode 0o600 (got {mode:o})"
        );

        let body = std::fs::read_to_string(&auth_path).unwrap();
        let parsed: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["auth_mode"], "Chatgpt");
        assert_eq!(parsed["OPENAI_API_KEY"], Value::Null);
        assert_eq!(
            parsed["tokens"]["account_id"],
            PLACEHOLDER_CHATGPT_ACCOUNT_ID
        );
    }

    #[test]
    fn setup_codex_chatgpt_inner_sets_refresh_url_override_env() {
        let tmp = TempDir::new().unwrap();
        setup_codex_chatgpt_inner(tmp.path(), fixed_now()).unwrap();
        assert_eq!(
            std::env::var("CODEX_REFRESH_TOKEN_URL_OVERRIDE").unwrap(),
            REFRESH_TOKEN_NOOP_URL
        );
    }

    #[test]
    fn setup_codex_chatgpt_inner_overwrites_existing_auth_json() {
        let tmp = TempDir::new().unwrap();
        let codex_home = tmp.path().join(".codex");
        std::fs::create_dir_all(&codex_home).unwrap();
        let auth_path = codex_home.join("auth.json");
        std::fs::write(&auth_path, b"STALE_CONTENT_FROM_PRIOR_RUN").unwrap();

        setup_codex_chatgpt_inner(tmp.path(), fixed_now()).unwrap();

        let body = std::fs::read_to_string(&auth_path).unwrap();
        assert!(
            !body.contains("STALE_CONTENT_FROM_PRIOR_RUN"),
            "stale content must be truncated: {body}"
        );
        // And the new content must parse as our auth.json shape.
        serde_json::from_str::<Value>(&body).unwrap();
    }
}
