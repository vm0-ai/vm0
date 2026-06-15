use guest_agent::http::HttpClient;

#[test]
fn for_current_env_requires_api_url_when_api_token_is_set() {
    unsafe {
        std::env::set_var("VM0_API_TOKEN", "test-token");
        std::env::set_var("VM0_API_URL", "");
    }

    let Err(err) = HttpClient::for_current_env() else {
        panic!("missing API URL should fail fast");
    };
    assert!(
        err.to_string().contains("VM0_API_URL"),
        "error should identify VM0_API_URL, got: {err}"
    );
}
