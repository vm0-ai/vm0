#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../../../.." && pwd)
typescript_bin="$repo_root/turbo/apps/cli/dist/zero.js"
rust_bin="$repo_root/crates/target/debug/zero-cli"
cases_dir="$script_dir/v1/cases"

pnpm --dir "$repo_root/turbo" --filter @vm0/cli build
chmod +x "$typescript_bin"

cargo build --manifest-path "$repo_root/crates/Cargo.toml" -p zero-cli --bin zero-cli
cargo test --manifest-path "$repo_root/crates/Cargo.toml" -p zero-cli --example parity
cargo run --manifest-path "$repo_root/crates/Cargo.toml" -p zero-cli --example parity -- \
  --typescript "$typescript_bin" \
  --rust "$rust_bin" \
  --cases "$cases_dir"
