#!/usr/bin/env bash
set -euo pipefail

package_dir="$(cd "$(dirname "$0")/.." && pwd)"
desktop_dir="$(cd "$package_dir/../.." && pwd)"
output_dir="$package_dir/out"
platform_url="https://app.okou.ai"
product=okou
preview=true
version=""
while (( $# )); do
  case "$1" in
    --output) output_dir="$2"; shift 2 ;;
    --platform-url) platform_url="$2"; shift 2 ;;
    --product) product="$2"; shift 2 ;;
    --version) version="$2"; shift 2 ;;
    --production) preview=false; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Building the app requires macOS 14+ and Xcode 16.3+ (Swift 6.1)." >&2
  exit 1
fi
if [[ "$product" != okou && "$product" != zero ]]; then
  echo "--product must be okou or zero" >&2
  exit 1
fi
if [[ -z "$version" ]]; then
  if [[ -f "$desktop_dir/VERSION" ]]; then
    version="$(cat "$desktop_dir/VERSION")"
  else
    version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$desktop_dir/package.json")"
  fi
fi
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
helper_dir="$desktop_dir/native/computer-use-helper"

swift build --package-path "$helper_dir" --arch arm64 -c release
swift build --package-path "$package_dir" --arch arm64 -c release
helper_bin="$(swift build --package-path "$helper_dir" --arch arm64 -c release --show-bin-path)"
app_bin="$(swift build --package-path "$package_dir" --arch arm64 -c release --show-bin-path)"

if [[ "$product" == okou ]]; then
  app_name=Okou
  bundle_id=ai.okou.desktop
else
  app_name="Zero Computer Use"
  bundle_id=ai.vm0.zero.desktop
fi
if [[ "$preview" == true ]]; then
  if [[ "$product" == okou ]]; then app_name="Okou Dev"; else app_name="Zero CU Dev"; fi
  bundle_id="$bundle_id.dev"
fi
app_dir="$output_dir/$app_name.app"
if [[ -e "$app_dir" ]]; then rm -rf "$app_dir"; fi
mkdir -p "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources/native"
cp "$app_bin/okou-desktop" "$app_dir/Contents/MacOS/okou-desktop"
cp "$helper_bin/computer-use-helper" "$helper_bin/screen-recorder-helper" "$app_dir/Contents/Resources/native/"
cp "$app_bin/okou-desktop-updater" "$app_dir/Contents/Resources/native/"
cp "$desktop_dir/assets/icon.icns" "$app_dir/Contents/Resources/icon.icns"
# SwiftPM resource bundles retain their module names inside Resources.
for bundle in "$app_bin"/*.bundle "$helper_bin"/*.bundle; do
  if [[ -d "$bundle" ]]; then cp -R "$bundle" "$app_dir/Contents/Resources/"; fi
done
python3 - "$app_dir" "$app_name" "$bundle_id" "$version" "$platform_url" "$product" "$preview" <<'PY'
import json, os, pathlib, plistlib, sys
app, name, bundle, version, url, product, preview = sys.argv[1:]
root = pathlib.Path(app) / "Contents"
plist = {
    "CFBundleName": name, "CFBundleDisplayName": name, "CFBundleIdentifier": bundle,
    "CFBundleExecutable": "okou-desktop", "CFBundlePackageType": "APPL",
    "CFBundleShortVersionString": version, "CFBundleVersion": version,
    "CFBundleIconFile": "icon.icns", "LSMinimumSystemVersion": "14.0",
    "LSUIElement": True, "NSHighResolutionCapable": True, "NSPrincipalClass": "NSApplication",
    "CFBundleURLTypes": [{"CFBundleURLName": name + " Auth", "CFBundleURLSchemes": [bundle]}],
    "NSAppleEventsUsageDescription": "Allow Okou to control browser apps for Computer Use.",
    "NSMicrophoneUsageDescription": "Record narration with your screen recording.",
}
with open(root / "Info.plist", "wb") as output:
    plistlib.dump(plist, output)
runtime = {"platformUrl": url, "product": product, "preview": preview == "true"}
dsn = os.environ.get("SENTRY_DSN_DESKTOP")
if dsn:
    runtime["sentryDsn"] = dsn
(root / "Resources/desktop-runtime-config.json").write_text(json.dumps(runtime, indent=2) + "\n")
PY
for helper in "$app_dir/Contents/Resources/native/"*; do
  codesign --force --sign - --options runtime --entitlements "$package_dir/Resources/entitlements.plist" "$helper"
done
codesign --force --sign - --options runtime --entitlements "$package_dir/Resources/entitlements.plist" "$app_dir"
codesign --verify --deep --strict "$app_dir"
lipo -verify_arch arm64 "$app_dir/Contents/MacOS/okou-desktop"
ditto -c -k --sequesterRsrc --keepParent "$app_dir" "$output_dir/Okou-Swift-macos-arm64.zip"
printf 'Built %s\n' "$app_dir"
