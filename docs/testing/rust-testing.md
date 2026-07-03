# Rust Testing Guide

## Overview

Rust crates live in `crates/` and use `cargo test` for testing. The same principles from [testing.md](../testing.md) apply: integration tests are primary, mock at the boundary, use real infrastructure.

## Running Tests

```bash
# All crates
cargo test --manifest-path crates/Cargo.toml

# Specific crate
cargo test --manifest-path crates/Cargo.toml -p guest-agent

# Specific test by name
cargo test --manifest-path crates/Cargo.toml -p runner config::tests::load_full_config

# With output (for debugging)
cargo test --manifest-path crates/Cargo.toml -- --nocapture
```

Pre-commit hooks run `cargo-clippy` and `cargo-fmt` on staged Rust files.

## Test Organization

### Integration Tests (`tests/`)

Preferred for testing public APIs and cross-module behavior:

```
crates/guest-agent/
  src/
    http.rs
    masker.rs
  tests/
    integration.rs     # Integration tests
```

### Inline Tests (`#[cfg(test)]`)

For testing module-internal logic that isn't exposed publicly:

```rust
// src/config.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn load_full_config() {
        let dir = tempfile::tempdir().unwrap();
        // ... setup and assertions
    }
}
```

## Patterns

### HTTP Mocking with httpmock

Use `httpmock` for mocking external HTTP services:

```rust
use httpmock::prelude::*;

static MOCK_SERVER: LazyLock<MockServer> = LazyLock::new(|| {
    let server = MockServer::start();
    unsafe {
        std::env::set_var("VM0_API_URL", server.base_url());
    }
    server
});

#[tokio::test]
async fn post_json_success() {
    let server = &*MOCK_SERVER;
    let mock = server.mock(|when, then| {
        when.method(POST).path("/test");
        then.status(200).json_body(json!({"status": "ok"}));
    });

    let result = http::post_json(&format!("{}/test", server.base_url()), &json!({}), 1).await;

    mock.assert_calls_async(1).await;
    assert_eq!(result.unwrap().unwrap()["status"], "ok");
    mock.delete_async().await;
}
```

### Test Serialization

When tests share mutable state (env vars, global server), use `std::sync::Mutex`:

```rust
// Use std::sync::Mutex, not tokio::sync::Mutex
// Each #[tokio::test] runs in its own runtime, so tokio Mutex won't work across tests
static TEST_MUTEX: Mutex<()> = Mutex::new(());

#[tokio::test]
async fn test_with_shared_state() {
    let _guard = TEST_MUTEX.lock().unwrap();
    // ... test body
}
```

### Temp Directories

Use `tempfile` crate (auto-cleanup via `Drop`):

```rust
let dir = tempfile::tempdir().unwrap();
let config_path = dir.path().join("runner.yaml");
tokio::fs::write(&config_path, yaml).await.unwrap();

let config = load(&config_path).await.unwrap();
assert_eq!(config.name, "test-runner");
// dir is cleaned up when dropped
```

### Test Harness for Complex Setup

When multiple tests need shared setup/teardown:

```rust
struct Harness {
    dir: PathBuf,
    host: Option<VsockHost>,
}

impl Harness {
    async fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        Self { dir, host: None }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
```

### Async Tests

Use `#[tokio::test]` for async code:

```rust
#[tokio::test]
async fn downloads_and_extracts() {
    let dir = tempfile::tempdir().unwrap();
    // ... async operations with .await
}
```

For sync-only logic, plain `#[test]` is fine:

```rust
#[test]
fn masks_nested_json() {
    let masker = SecretMasker { patterns: vec!["secret".into()] };
    let mut val = json!({"key": "has secret inside"});
    masker.mask_value(&mut val);
    assert_eq!(val["key"], "has *** inside");
}
```

## What to Test

- **Config parsing**: round-trip (generate → load), validation of invalid inputs
- **HTTP clients**: success, retry, error responses (via httpmock)
- **Serialization**: serde round-trips for protocol types
- **Business logic**: masking, matching, path manipulation

## What NOT to Test

- Firecracker VM creation (requires root + KVM)
- Network namespace operations (requires root)
- Sandbox lifecycle (requires full runner environment)

These are covered by E2E tests in CI with real runner infrastructure.
