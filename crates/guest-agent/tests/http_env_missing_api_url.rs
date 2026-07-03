use guest_agent::http::HttpClient;

#[test]
fn for_config_requires_api_url_when_api_token_is_set() {
    let config = guest_agent::env::GuestConfig::from_raw(guest_agent::env::GuestConfigRaw {
        run_id: "http-missing-api-url".to_string(),
        api_token: "test-token".to_string(),
        home: Some(std::env::temp_dir().to_string_lossy().into_owned()),
        ..Default::default()
    })
    .expect("test config should be valid");

    let Err(err) = HttpClient::for_config(&config) else {
        panic!("missing API URL should fail fast");
    };
    assert!(
        err.to_string().contains("VM0_API_URL"),
        "error should identify VM0_API_URL, got: {err}"
    );
}
