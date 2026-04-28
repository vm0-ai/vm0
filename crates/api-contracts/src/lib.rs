//! Rust bindings for selected `@vm0/api-contracts` routes.
//!
//! Route constants under [`generated::routes`] are generated from the
//! TypeScript supported-route registry. Regenerate them with:
//!
//! ```bash
//! cd turbo && pnpm -F @vm0/api-contracts generate:rust
//! ```
//!
//! Use [`Route::url`] to build an absolute endpoint URL from `VM0_API_URL`
//! or another API base URL.
//!
//! Add new Rust-supported routes to
//! `turbo/packages/api-contracts/src/rust-bindings/routes.ts`.

pub mod generated;

mod route;

pub use route::{Method, Route};
