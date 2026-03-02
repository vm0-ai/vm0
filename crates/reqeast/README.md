# reqeast

Thin wrapper around [reqwest](https://crates.io/crates/reqwest) that auto-installs the **ring** TLS crypto provider before the first HTTP request.

## Why

reqwest 0.13 switched its default TLS backend from `ring` to `aws-lc-rs`. This causes two problems for us:

1. **Cross-compilation breaks** — `aws-lc-sys` uses glibc-specific fortified functions (`__memcpy_chk`, `__fprintf_chk`) that don't exist in musl libc. Our guest binaries target `aarch64-unknown-linux-musl`, so linking fails.

2. **Manual provider ceremony** — Using reqwest's `rustls-no-provider` feature to opt out of `aws-lc-rs` requires every binary and test to manually call `rustls::crypto::ring::default_provider().install_default()` before any HTTP client is created. Missing this call produces a runtime panic.

`reqeast` solves both by depending on reqwest with `rustls-no-provider` + `ring`, and calling `install_default()` automatically (via `std::sync::Once`) in its `builder()` and `get()` entry points.

## Usage

Use `reqeast::builder()` instead of `reqwest::Client::builder()`:

```rust
let client = reqeast::builder()
    .timeout(Duration::from_secs(10))
    .build()?;

let resp = client.get("https://example.com").send().await?;
```

Commonly used reqwest types are re-exported (`Client`, `Method`, `StatusCode`, etc.) so downstream crates only need `reqeast` in their `[dependencies]`.

## Background

- [seanmonstar/reqwest#2723](https://github.com/seanmonstar/reqwest/issues/2723) — reqwest 0.13 switched default TLS to rustls + aws-lc-rs (instead of ring).
- [seanmonstar/reqwest#2630](https://github.com/seanmonstar/reqwest/issues/2630) — Using `rustls-no-provider` requires manual `CryptoProvider::install_default()`; missing it causes a runtime panic.
- [seanmonstar/reqwest#2136](https://github.com/seanmonstar/reqwest/issues/2136) — Discussion on aws-lc-rs build complexity (needs cmake, nasm) vs ring.
- [seanmonstar/reqwest#647](https://github.com/seanmonstar/reqwest/issues/647) — Prior art: reqwest in Firecracker + musl — same scenario, same class of problem.
- [aws/aws-lc-rs#894](https://github.com/aws/aws-lc-rs/issues/894) — `aws-lc-sys` musl build failures (`linux/random.h` missing); fixed but illustrates fragile musl support.
- [algesten/ureq#751](https://github.com/algesten/ureq/issues/751) — ureq chose to stay on ring; rustls maintainers confirmed "it is fine to stick with ring" for minimal-dependency use cases.
