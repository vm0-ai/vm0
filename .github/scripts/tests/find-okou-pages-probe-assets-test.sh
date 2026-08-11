#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/find-okou-pages-probe-assets.mjs"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

assets_dir="${tmp_dir}/assets"
mkdir -p "$assets_dir"
printf '%s\n' 'import "./shared.js";' > "${assets_dir}/index-a.js"
printf '%s\n' 'import "./shared.js?cache=1";' > "${assets_dir}/Route-b.js"
printf '%s\n' 'import "./shared.js";' > "${assets_dir}/SignIn-c.js"
printf '%s\n' 'import "./shared.js#fragment";' > "${assets_dir}/SignUp-d.js"
printf '%s\n' 'export const shared = true;' > "${assets_dir}/shared.js"
printf '%s\n' 'export const unrelated = true;' > "${assets_dir}/unrelated.js"

output="${tmp_dir}/output"
node "$script" "$assets_dir" > "$output"

for asset in index-a.js Route-b.js SignIn-c.js SignUp-d.js shared.js; do
  grep -Fxq "${assets_dir}/${asset}" "$output"
done
if grep -Fq "${assets_dir}/unrelated.js" "$output"; then
  echo "included an unreachable preview asset" >&2
  exit 1
fi

echo "find-okou-pages-probe-assets tests passed"
