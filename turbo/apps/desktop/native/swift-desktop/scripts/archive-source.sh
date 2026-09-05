#!/usr/bin/env bash
set -euo pipefail
package_dir="$(cd "$(dirname "$0")/.." && pwd)"
desktop_dir="$(cd "$package_dir/../.." && pwd)"
output_dir="${1:-$package_dir/out}"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
source_dir="$(mktemp -d)"
trap 'rm -rf "$source_dir"' EXIT
mkdir -p "$source_dir/Okou-Swift-Project/native" "$source_dir/Okou-Swift-Project/assets"
rsync -a --exclude .build --exclude .swiftpm --exclude out "$package_dir" "$source_dir/Okou-Swift-Project/native/"
rsync -a --exclude .build --exclude .swiftpm "$desktop_dir/native/computer-use-helper" "$source_dir/Okou-Swift-Project/native/"
cp "$desktop_dir/assets/icon.icns" "$source_dir/Okou-Swift-Project/assets/"
python3 - "$desktop_dir/package.json" "$source_dir/Okou-Swift-Project/VERSION" <<'PY'
import json, pathlib, sys
pathlib.Path(sys.argv[2]).write_text(json.load(open(sys.argv[1]))["version"] + "\n")
PY
ditto -c -k --sequesterRsrc --keepParent "$source_dir/Okou-Swift-Project" "$output_dir/Okou-Swift-Project.zip"
