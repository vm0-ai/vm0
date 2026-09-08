use api_contracts::generated::types::runners::ssh::ResolveResponse;
use serde_json::json;

#[test]
fn credential_handoff_obeys_utf16_bounds_and_preserves_secret_whitespace() {
    let body = json!({"outcome":"resolved","host":"example.com","port":22,"username":"user","generation":1,"learnedHostKey":null,"privateKey":"😀".repeat(32768),"passphrase":" passphrase\n"});
    let decoded: ResolveResponse = serde_json::from_value(body.clone()).unwrap();
    let ResolveResponse::Resolved {
        private_key,
        passphrase,
        ..
    } = decoded
    else {
        panic!("expected resolved");
    };
    assert_eq!(private_key.expose().encode_utf16().count(), 65536);
    assert_eq!(passphrase.unwrap().expose(), " passphrase\n");
    let mut oversized = body;
    oversized["privateKey"] = json!("😀".repeat(32769));
    assert!(serde_json::from_value::<ResolveResponse>(oversized).is_err());
    for response in [
        r#"{"outcome":"unavailable","outcome":"unavailable"}"#,
        r#"{"outcome":"unavailable","unknown":"canary"}"#,
        r#"{"outcome":"unavailable","passphrase":null}"#,
    ] {
        assert!(serde_json::from_str::<ResolveResponse>(response).is_err());
    }
}
